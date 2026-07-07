import type {
  AuthUserDto,
  BatchSummary,
  BulkApproveResponseDto,
  CreateBatchRequest,
  CreateExportRequest,
  ConfirmProductMappingRequest,
  ExportDto,
  ImportStoreAddressesRequest,
  ImportStoreAddressesPreviewResponse,
  ImportStoreAddressesResponse,
  LoginRequest,
  LoginResponse,
  MakeOrderReadinessDto,
  MissingMakeOrderStoreDto,
  MeResponse,
  ProductMatchCandidateDto,
  ProductMappingDto,
  RunRealReviewRequest,
  ReviewDecisionDto,
  ReviewLineDto,
  SubmitReviewResponseDto,
  CreateWdtGoodsSyncRunRequest,
  StoreAddressDto,
  StoreAddressImportPreviewItem,
  UpdateWarehouseUsageSettingsRequest,
  UpdateReviewLinePriorityRequest,
  UpdateProductMappingStatusRequest,
  UpsertStoreAddressRequest,
  WarehouseUsageSettingsDto,
  WdtGoodsSpecSearchResultDto,
  WdtGoodsSyncRunDto,
} from "@jy-trade/shared";
import { buildMockReview } from "@jy-trade/workflow";
import { and, desc, eq, like, or } from "drizzle-orm";
import * as XLSX from "xlsx";
import { randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { createDatabaseContext, type DatabaseContext } from "./db/client.js";
import {
  auditLogs,
  batches,
  exportsTable,
  reviewDecisions,
  reviewLines,
  sessions,
  productMappings,
  productMatchCandidates,
  storeAddresses,
  users,
  warehouseUsageSettings,
  wdtGoodsSpecs,
  wdtGoodsSyncRuns,
} from "./db/schema.js";
import {
  type GoodsSyncRepository,
  type GoodsSyncRunRecord,
  runWdtGoodsSync,
  type WdtGoodsSpecPayload,
  type WdtGoodsWindowClient,
} from "./wdtGoodsSync.js";
import { createWdtReadClientsFromEnv } from "./wdtClientAdapter.js";
import { ensureRuntimeDir, resolveProjectRoot, resolveRuntimeDir } from "./runtimePaths.js";
import {
  decideLocalProductMatch,
  loadOrderLines,
  type LocalGoodsSpecCandidate,
  type ProductMappingCandidate,
  type ProductMatchDecision,
} from "@jy-trade/workflow";
import type { WdtStockResponse, WdtStockRow } from "../../../backend/src/integrations/wdtClient.js";

type BatchRow = typeof batches.$inferSelect;
type ReviewLineRow = typeof reviewLines.$inferSelect;
type ReviewDecisionRow = typeof reviewDecisions.$inferSelect;
type ExportRow = typeof exportsTable.$inferSelect;
type UserRow = typeof users.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;
type StoreAddressRow = typeof storeAddresses.$inferSelect;
type WarehouseUsageSettingsRow = typeof warehouseUsageSettings.$inferSelect;
type WdtGoodsSyncRunRow = typeof wdtGoodsSyncRuns.$inferSelect;
type WdtGoodsSpecRow = typeof wdtGoodsSpecs.$inferSelect;
type ProductMappingRow = typeof productMappings.$inferSelect;
type ProductMatchCandidateRow = typeof productMatchCandidates.$inferSelect;

export interface StockLookupClient {
  queryStock(specNo: string): Promise<WdtStockResponse>;
}

interface WarehouseStockSummary {
  mainAvailableStock: number;
  nearExpiryAvailableStock: number;
  defectAvailableStock: number;
  otherAvailableStock: number;
  usableAvailableStock: number;
  warehouseBreakdown: string;
}

export interface StoreOptions {
  databaseUrl?: string;
  projectRoot?: string;
  wdtGoodsClient?: WdtGoodsWindowClient;
  stockClient?: StockLookupClient;
}

export class StoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreValidationError";
  }
}

export function createSqliteStore(options: StoreOptions = {}) {
  const database = createDatabaseContext(options.databaseUrl);
  const projectRoot = options.projectRoot ?? resolveProjectRoot();
  const exportsDir = ensureRuntimeDir(resolveRuntimeDir(process.env.JY_TRADE_EXPORTS_DIR, resolve(projectRoot, "outputs/exports"), projectRoot));
  const configuredUploadDir = ensureRuntimeDir(resolveRuntimeDir(process.env.JY_TRADE_UPLOAD_DIR, resolve(projectRoot, "inputs/uploads"), projectRoot));
  const uploadDirs = uniquePaths([
    configuredUploadDir,
    resolve(process.cwd(), "inputs/uploads"),
    resolve(projectRoot, "inputs/uploads"),
    resolve(projectRoot, "apps/api/inputs/uploads"),
  ]);
  const wdtClients = options.wdtGoodsClient && options.stockClient ? undefined : createWdtReadClientsFromEnv();
  const wdtGoodsClient = options.wdtGoodsClient ?? wdtClients?.goodsClient;
  const stockClient = options.stockClient ?? wdtClients?.stockClient;
  const bootstrapUsername = process.env.JY_TRADE_BOOTSTRAP_USERNAME ?? "admin";
  const bootstrapPassword = process.env.JY_TRADE_BOOTSTRAP_PASSWORD ?? "jymy";
  const ready = prepareDatabase(database, [
    { username: bootstrapUsername, password: bootstrapPassword, role: "admin" },
    { username: "operator", password: "operator123", role: "operator" },
    { username: "reviewer", password: "reviewer123", role: "reviewer" },
  ]);
  const goodsSyncRepository = createGoodsSyncRepository(database);

  return {
    ready,

    async login(input: LoginRequest): Promise<LoginResponse | undefined> {
      await ready;
      const user = await findUserByUsername(database, input.username);
      if (!user) return undefined;
      const ok = await verifyPassword(input.password, user.passwordHash);
      if (!ok) return undefined;
      return { user: toAuthUserDto(user) };
    },

    async getMe(sessionId: string | undefined): Promise<MeResponse> {
      await ready;
      if (!sessionId) return { user: null };
      const session = await findSession(database, sessionId);
      if (!session) return { user: null };
      const user = await findUserById(database, session.userId);
      return { user: user ? toAuthUserDto(user) : null };
    },

    async createSession(userId: string, ttlDays = 7, actor?: AuthUserDto): Promise<{ sessionId: string; expiresAt: string } | undefined> {
      await ready;
      const user = await findUserById(database, userId);
      if (!user) return undefined;

      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
      const sessionId = `session-${randomUUID()}`;
      await database.db.insert(sessions).values({
        id: sessionId,
        userId,
        expiresAt,
        createdAt: now.toISOString(),
        lastUsedAt: now.toISOString(),
      });
      await insertAuditLog(database, actor?.id ?? user.id, "auth.login", "session", sessionId, {
        userId,
        username: user.username,
      });
      return { sessionId, expiresAt };
    },

    async logout(sessionId: string | undefined, actor?: AuthUserDto): Promise<void> {
      await ready;
      if (!sessionId) return;
      const session = await findSession(database, sessionId);
      await database.db.delete(sessions).where(eq(sessions.id, sessionId));
      if (session) {
        await insertAuditLog(database, actor?.id ?? session.userId, "auth.logout", "session", sessionId, {
          userId: session.userId,
        });
      }
    },

    async createBatch(input: CreateBatchRequest, actor?: AuthUserDto): Promise<BatchSummary> {
      await ready;
      const now = new Date().toISOString();
      const filePath = resolveProjectPath(input.filePath, projectRoot);
      const batch: BatchRow = {
        id: `batch-${randomUUID()}`,
        filePath,
        fileName: input.fileName ?? input.filePath.split(/[\\/]/).at(-1) ?? input.filePath,
        mode: input.mode,
        status: "uploaded",
        orderLineCount: 0,
        uniqueBarcodeCount: 0,
        matchedBarcodeCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      await database.db.insert(batches).values(batch);
      await insertAuditLog(database, actor?.id ?? null, "batch.create", "batch", batch.id, {
        fileName: batch.fileName,
        mode: batch.mode,
      });
      return toBatchSummary(batch);
    },

    async listBatches(): Promise<BatchSummary[]> {
      await ready;
      const rows = await database.db.select().from(batches).orderBy(desc(batches.createdAt));
      return rows.map(toBatchSummary);
    },

    async getBatch(batchId: string): Promise<BatchSummary | undefined> {
      await ready;
      const batch = await getBatchRow(database, batchId);
      return batch ? toBatchSummary(batch) : undefined;
    },

    async deleteBatch(batchId: string, actor?: AuthUserDto): Promise<{ batchId: string; deleted: true } | undefined> {
      await ready;
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;

      const exportRows = await database.db.select().from(exportsTable).where(eq(exportsTable.batchId, batchId));
      await database.db.delete(reviewDecisions).where(eq(reviewDecisions.batchId, batchId));
      await database.db.delete(reviewLines).where(eq(reviewLines.batchId, batchId));
      await database.db.delete(productMatchCandidates).where(eq(productMatchCandidates.batchId, batchId));
      await database.db.delete(exportsTable).where(eq(exportsTable.batchId, batchId));
      await database.db.delete(batches).where(eq(batches.id, batchId));

      const removedFiles: string[] = [];
      for (const filePath of [batch.filePath, ...exportRows.map((row) => row.filePath)]) {
        if (await removeRuntimeFile(filePath, [...uploadDirs, exportsDir])) {
          removedFiles.push(filePath);
        }
      }

      await insertAuditLog(database, actor?.id ?? null, "batch.delete", "batch", batchId, {
        fileName: batch.fileName,
        removedFileCount: removedFiles.length,
      });
      return { batchId, deleted: true };
    },

    async runMockReview(batchId: string, mockDataFile: string, actor?: AuthUserDto) {
      await ready;
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;

      const result = buildMockReview(batch.filePath, resolveProjectPath(mockDataFile, projectRoot), batchId);
      const now = new Date().toISOString();

      await replaceBatchReviewLines(database, batchId, result.reviewLines, now);
      await database.db.delete(productMatchCandidates).where(eq(productMatchCandidates.batchId, batchId));

      const updatedBatch: BatchRow = {
        ...batch,
        status: "review_generated",
        orderLineCount: result.orderLineCount,
        uniqueBarcodeCount: result.uniqueBarcodeCount,
        matchedBarcodeCount: result.matchedBarcodeCount,
        updatedAt: now,
      };
      await database.db
        .update(batches)
        .set({
          status: updatedBatch.status,
          orderLineCount: updatedBatch.orderLineCount,
          uniqueBarcodeCount: updatedBatch.uniqueBarcodeCount,
          matchedBarcodeCount: updatedBatch.matchedBarcodeCount,
          updatedAt: updatedBatch.updatedAt,
        })
        .where(eq(batches.id, batchId));

      await insertAuditLog(database, actor?.id ?? null, "batch.run_mock_review", "batch", batchId, {
        orderLineCount: result.orderLineCount,
        statusCounts: result.statusCounts,
        matchCounts: result.matchCounts,
      });

      return {
        batch: toBatchSummary(updatedBatch),
        statusCounts: result.statusCounts,
        matchCounts: result.matchCounts,
      };
    },

    async runRealReview(batchId: string, input: RunRealReviewRequest, actor?: AuthUserDto) {
      await ready;
      if (!stockClient) {
        throw new StoreValidationError("WDT stock client is not configured");
      }
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;

      const cacheStatus = await getGoodsCacheStatus(database, Boolean(input.allowStaleCache));
      assertReviewGoodsCacheUsable(cacheStatus);

      const goodsSpecs = (await database.db.select().from(wdtGoodsSpecs)).map(toLocalGoodsSpecCandidate);
      const mappings = (await database.db.select().from(productMappings).where(eq(productMappings.status, "confirmed"))).map(toProductMappingCandidate);
      const warehouseSettings = toWarehouseUsageSettingsDto(await getWarehouseUsageSettingsRow(database));
      const result = await buildRealReview(stockClient, {
        batchId,
        orderFile: batch.filePath,
        goodsSpecs,
        mappings,
        warehouseSettings,
      });
      const now = new Date().toISOString();

      await replaceBatchReviewLines(database, batchId, result.reviewLines, now);
      await replaceProductMatchCandidates(database, batchId, result.candidateRows, now);

      const updatedBatch: BatchRow = {
        ...batch,
        status: "review_generated",
        orderLineCount: result.orderLineCount,
        uniqueBarcodeCount: result.uniqueBarcodeCount,
        matchedBarcodeCount: result.matchedBarcodeCount,
        updatedAt: now,
      };
      await database.db
        .update(batches)
        .set({
          status: updatedBatch.status,
          orderLineCount: updatedBatch.orderLineCount,
          uniqueBarcodeCount: updatedBatch.uniqueBarcodeCount,
          matchedBarcodeCount: updatedBatch.matchedBarcodeCount,
          updatedAt: updatedBatch.updatedAt,
        })
        .where(eq(batches.id, batchId));

      await insertAuditLog(database, actor?.id ?? null, "batch.run_real_review", "batch", batchId, {
        orderLineCount: result.orderLineCount,
        statusCounts: result.statusCounts,
        matchCounts: result.matchCounts,
        stockQueriedCount: result.stockQueriedCount,
        allowStaleCache: input.allowStaleCache,
      });

      return {
        batch: toBatchSummary(updatedBatch),
        statusCounts: result.statusCounts,
        matchCounts: result.matchCounts,
        stockQueriedCount: result.stockQueriedCount,
      };
    },

    async getReviewLines(batchId: string): Promise<ReviewLineDto[] | undefined> {
      await ready;
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;
      return getReviewLineDtos(database, batchId);
    },

    async getMakeOrderReadiness(batchId: string): Promise<MakeOrderReadinessDto | undefined> {
      await ready;
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;
      const lines = await getReviewLineDtos(database, batchId);
      const addressIndex = await loadMakeOrderAddressIndex(database);
      return buildMakeOrderReadiness(batchId, lines, addressIndex);
    },

    async listStoreAddresses(query = ""): Promise<StoreAddressDto[]> {
      await ready;
      const trimmed = query.trim();
      const base = database.db.select().from(storeAddresses);
      const rows = trimmed
        ? await base
            .where(
              or(
                like(storeAddresses.storeNo, `%${trimmed}%`),
                like(storeAddresses.storeName, `%${trimmed}%`),
                like(storeAddresses.receiver, `%${trimmed}%`),
                like(storeAddresses.phone, `%${trimmed}%`),
                like(storeAddresses.address, `%${trimmed}%`),
              ),
            )
            .orderBy(desc(storeAddresses.updatedAt))
            .limit(50)
        : await base.orderBy(desc(storeAddresses.updatedAt)).limit(50);
      return rows.map(toStoreAddressDto);
    },

    async upsertStoreAddress(input: UpsertStoreAddressRequest, actor?: AuthUserDto): Promise<StoreAddressDto> {
      await ready;
      const now = new Date().toISOString();
      const storeNo = input.storeNo.trim();
      const storeName = input.storeName.trim();
      const normalizedStoreName = normalizeStoreName(storeName);
      const values = {
        storeNo,
        storeName,
        normalizedStoreName,
        receiver: input.receiver.trim(),
        phone: input.phone.trim(),
        address: input.address.trim(),
        note: input.note.trim(),
        sourceSheet: "手工维护",
        sourceRow: 0,
        importedAt: "",
        rawJson: "{}",
        updatedByUserId: actor?.id ?? null,
        updatedByUsername: actor?.username ?? null,
        updatedAt: now,
      };

      const existing = await findStoreAddressRow(database, storeNo, normalizedStoreName);
      if (existing) {
        const next: StoreAddressRow = { ...existing, ...values };
        await database.db.update(storeAddresses).set(values).where(eq(storeAddresses.id, existing.id));
        await insertAuditLog(database, actor?.id ?? null, "store_address.update", "store_address", existing.id, values);
        return toStoreAddressDto(next);
      }

      const row: StoreAddressRow = {
        id: `store-address-${randomUUID()}`,
        ...values,
        createdAt: now,
      };
      await database.db.insert(storeAddresses).values(row);
      await insertAuditLog(database, actor?.id ?? null, "store_address.create", "store_address", row.id, values);
      return toStoreAddressDto(row);
    },

    async previewStoreAddressImport(input: ImportStoreAddressesRequest): Promise<ImportStoreAddressesPreviewResponse> {
      await ready;
      const parsed = parseStoreAddressImportInput(input);
      const preview = await buildStoreAddressImportPreview(database, parsed.addresses);
      return {
        fileName: input.fileName,
        sheetCount: parsed.sheetCount,
        parsedRowCount: parsed.addresses.length,
        skippedRowCount: parsed.skippedRowCount,
        affectedStoreCount: preview.items.length,
        createCount: preview.createCount,
        updateCount: preview.updateCount,
        unchangedCount: preview.unchangedCount,
        items: preview.items,
      };
    },

    async importStoreAddresses(input: ImportStoreAddressesRequest, actor?: AuthUserDto): Promise<ImportStoreAddressesResponse> {
      await ready;
      const parsed = parseStoreAddressImportInput(input);
      const importGroups = groupStoreAddressImports(parsed.addresses);
      const now = new Date().toISOString();
      let importedAddressCount = 0;

      for (const group of importGroups) {
        const address = group.address;
        const existing = await findStoreAddressRow(database, address.storeNo, normalizeStoreName(address.storeName));
        const rawJson = group.rawAddresses.reduce(
          (currentRawJson, rawAddress) => mergeStoreAddressRawJson(currentRawJson, rawAddress),
          existing?.rawJson,
        );
        const values = {
          storeNo: address.storeNo,
          storeName: address.storeName,
          normalizedStoreName: normalizeStoreName(address.storeName),
          receiver: address.receiver,
          phone: address.phone,
          address: address.address,
          note: address.note,
          sourceSheet: address.sourceSheet,
          sourceRow: address.sourceRow,
          importedAt: now,
          rawJson,
          updatedByUserId: actor?.id ?? null,
          updatedByUsername: actor?.username ?? null,
          updatedAt: now,
        };
        if (existing) {
          await database.db.update(storeAddresses).set(values).where(eq(storeAddresses.id, existing.id));
        } else {
          await database.db.insert(storeAddresses).values({
            id: `store-address-${randomUUID()}`,
            ...values,
            createdAt: now,
          });
        }
        importedAddressCount += 1;
      }

      await insertAuditLog(database, actor?.id ?? null, "store_address.import", "store_address", input.fileName, {
        fileName: input.fileName,
        workbookSheetCount: parsed.workbookSheetCount,
        sheetCount: parsed.sheetCount,
        parsedRowCount: parsed.addresses.length,
        skippedRowCount: parsed.skippedRowCount,
      });

      return {
        fileName: input.fileName,
        sheetCount: parsed.sheetCount,
        parsedRowCount: parsed.addresses.length,
        importedAddressCount,
        skippedRowCount: parsed.skippedRowCount,
      };
    },

    async getWarehouseUsageSettings(): Promise<WarehouseUsageSettingsDto> {
      await ready;
      const row = await getWarehouseUsageSettingsRow(database);
      return toWarehouseUsageSettingsDto(row);
    },

    async updateWarehouseUsageSettings(
      input: UpdateWarehouseUsageSettingsRequest,
      actor?: AuthUserDto,
    ): Promise<WarehouseUsageSettingsDto> {
      await ready;
      const previous = await getWarehouseUsageSettingsRow(database);
      const now = new Date().toISOString();
      const row: WarehouseUsageSettingsRow = {
        id: "default",
        includeMainWarehouse: input.includeMainWarehouse ? 1 : 0,
        includeNearExpiryWarehouse: input.includeNearExpiryWarehouse ? 1 : 0,
        includeDefectWarehouse: input.includeDefectWarehouse ? 1 : 0,
        includeOtherWarehouses: input.includeOtherWarehouses ? 1 : 0,
        updatedByUserId: actor?.id ?? null,
        updatedByUsername: actor?.username ?? null,
        updatedAt: now,
      };

      await database.db
        .insert(warehouseUsageSettings)
        .values(row)
        .onConflictDoUpdate({
          target: warehouseUsageSettings.id,
          set: {
            includeMainWarehouse: row.includeMainWarehouse,
            includeNearExpiryWarehouse: row.includeNearExpiryWarehouse,
            includeDefectWarehouse: row.includeDefectWarehouse,
            includeOtherWarehouses: row.includeOtherWarehouses,
            updatedByUserId: row.updatedByUserId,
            updatedByUsername: row.updatedByUsername,
            updatedAt: row.updatedAt,
          },
        });

      await insertAuditLog(database, actor?.id ?? null, "settings.update_warehouse_usage", "settings", "warehouse_usage", {
        previous: toWarehouseUsageSettingsDto(previous),
        next: toWarehouseUsageSettingsDto(row),
      });

      return toWarehouseUsageSettingsDto(row);
    },

    async updateReviewDecision(
      batchId: string,
      lineId: string,
      decision: ReviewDecisionDto,
      actor?: AuthUserDto,
    ): Promise<ReviewLineDto | undefined> {
      await ready;
      const [line] = await database.db
        .select()
        .from(reviewLines)
        .where(and(eq(reviewLines.batchId, batchId), eq(reviewLines.id, lineId)))
        .limit(1);
      if (!line) return undefined;

      const now = new Date().toISOString();
      const [previousDecision] = await database.db
        .select()
        .from(reviewDecisions)
        .where(eq(reviewDecisions.reviewLineId, lineId))
        .limit(1);

      const nextDecision = await replaceReviewDecision(database, line, decision, now, previousDecision, actor?.id ?? null);

      await insertAuditLog(database, actor?.id ?? null, "review_line.update_decision", "review_line", lineId, {
        previous: previousDecision
          ? {
              decision: previousDecision.decision,
              approvedShipQty: previousDecision.approvedShipQty,
              reason: previousDecision.reason,
            }
          : null,
        next: decision,
      });

      return toReviewLineDto(line, nextDecision);
    },

    async updateReviewLinePriority(
      batchId: string,
      lineId: string,
      input: UpdateReviewLinePriorityRequest,
      actor?: AuthUserDto,
    ): Promise<ReviewLineDto | undefined> {
      await ready;
      const [line] = await database.db
        .select()
        .from(reviewLines)
        .where(and(eq(reviewLines.batchId, batchId), eq(reviewLines.id, lineId)))
        .limit(1);
      if (!line) return undefined;

      const reason = input.reason.trim();

      await database.db
        .update(reviewLines)
        .set({
          priority: input.priority ? 1 : 0,
          priorityReason: input.priority ? reason : "",
        })
        .where(eq(reviewLines.id, lineId));

      const [updatedLine] = await database.db.select().from(reviewLines).where(eq(reviewLines.id, lineId)).limit(1);
      const [decision] = await database.db.select().from(reviewDecisions).where(eq(reviewDecisions.reviewLineId, lineId)).limit(1);

      await insertAuditLog(database, actor?.id ?? null, "review_line.update_priority", "review_line", lineId, {
        previous: { priority: Boolean(line.priority), reason: line.priorityReason },
        next: { priority: input.priority, reason: input.priority ? reason : "" },
      });

      return toReviewLineDto(updatedLine, decision);
    },

    async bulkApprove(batchId: string, actor?: AuthUserDto): Promise<BulkApproveResponseDto | undefined> {
      await ready;
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;

      const now = new Date().toISOString();
      const candidates = await database.db.select().from(reviewLines).where(eq(reviewLines.batchId, batchId));
      const targetLines = candidates.filter(
        (line) => line.matchStatus === "matched" && (line.status === "库存充足" || line.status === "部分满足"),
      );

      for (const line of targetLines) {
        const [previousDecision] = await database.db
          .select()
          .from(reviewDecisions)
          .where(eq(reviewDecisions.reviewLineId, line.id))
          .limit(1);
        await replaceReviewDecision(
          database,
          line,
          { decision: "ship", approvedShipQty: line.suggestedShipQty, reason: "" },
          now,
          previousDecision,
          actor?.id ?? null,
        );
      }

      await insertAuditLog(database, actor?.id ?? null, "batch.bulk_approve", "batch", batchId, {
        updatedCount: targetLines.length,
      });

      return { batch: toBatchSummary(batch), updatedCount: targetLines.length };
    },

    async submitReview(batchId: string, actor?: AuthUserDto): Promise<SubmitReviewResponseDto | undefined> {
      await ready;
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;

      const now = new Date().toISOString();
      const nextBatch: BatchRow = { ...batch, status: "reviewed", updatedAt: now };
      await database.db.update(batches).set({ status: "reviewed", updatedAt: now }).where(eq(batches.id, batchId));
      const lines = await getReviewLineDtos(database, batchId);
      const pendingCount = lines.filter((line) => line.decision === "pending").length;
      const shipCount = lines.filter((line) => line.decision === "ship").length;
      const doNotShipCount = lines.filter((line) => line.decision === "do_not_ship").length;

      await insertAuditLog(database, actor?.id ?? null, "batch.submit_review", "batch", batchId, {
        pendingCount,
        shipCount,
        doNotShipCount,
      });

      return {
        batch: toBatchSummary(nextBatch),
        pendingCount,
        shipCount,
        doNotShipCount,
      };
    },

    async listExports(batchId: string): Promise<ExportDto[]> {
      await ready;
      const rows = await database.db.select().from(exportsTable).where(eq(exportsTable.batchId, batchId)).orderBy(desc(exportsTable.createdAt));
      return rows.map(toExportDto);
    },

    async createExport(batchId: string, input?: CreateExportRequest, actor?: AuthUserDto): Promise<ExportDto | undefined> {
      await ready;
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;
      const lines = await getReviewLineDtos(database, batchId);
      const now = new Date().toISOString();
      const type = input?.type ?? "review";
      const exportId = `export-${randomUUID()}`;
      const fileName = buildExportFileName(batch.fileName, type, now);
      const filePath = resolve(exportsDir, fileName);
      const exportRow: typeof exportsTable.$inferInsert = {
        id: exportId,
        batchId,
        type,
        status: "created",
        fileName,
        filePath,
        errorMessage: "",
        createdByUserId: actor?.id ?? null,
        createdByUsername: actor?.username ?? null,
        createdAt: now,
      };

      await database.db.insert(exportsTable).values(exportRow);
      try {
        await mkdir(exportsDir, { recursive: true });
        const addressIndex = type === "wdt_import" ? await loadMakeOrderAddressIndex(database) : undefined;
        if (type === "wdt_import") {
          const readiness = buildMakeOrderReadiness(batchId, lines, addressIndex ?? emptyMakeOrderAddressIndex());
          if (!readiness.canExport) {
            throw new StoreValidationError(makeOrderReadinessError(readiness));
          }
        }
        const buffer = renderExportWorkbook(batch, type, lines, addressIndex);
        await writeFile(filePath, buffer);
        await database.db
          .update(exportsTable)
          .set({ status: "ready", filePath, errorMessage: "" })
          .where(eq(exportsTable.id, exportId));
        await database.db.update(batches).set({ status: "exported", updatedAt: now }).where(eq(batches.id, batchId));
        await insertAuditLog(database, actor?.id ?? null, "export.ready", "export", exportId, {
          batchId,
          type,
          filePath,
        });
        return toExportDto({
          ...exportRow,
          status: "ready",
          filePath,
          errorMessage: "",
          createdByUserId: exportRow.createdByUserId ?? null,
          createdByUsername: exportRow.createdByUsername ?? null,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "export failed";
        await database.db
          .update(exportsTable)
          .set({ status: "failed", filePath, errorMessage })
          .where(eq(exportsTable.id, exportId));
        await insertAuditLog(database, actor?.id ?? null, "export.failed", "export", exportId, {
          batchId,
          type,
          errorMessage,
        });
        return toExportDto({
          ...exportRow,
          status: "failed",
          filePath,
          errorMessage,
          createdByUserId: exportRow.createdByUserId ?? null,
          createdByUsername: exportRow.createdByUsername ?? null,
        });
      }
    },

    async getExport(exportId: string): Promise<ExportDto | undefined> {
      await ready;
      const [row] = await database.db.select().from(exportsTable).where(eq(exportsTable.id, exportId)).limit(1);
      return row ? toExportDto(row) : undefined;
    },

    async getExportFile(exportId: string): Promise<{ exportJob: ExportDto; filePath: string; fileName: string } | undefined> {
      await ready;
      const [row] = await database.db.select().from(exportsTable).where(eq(exportsTable.id, exportId)).limit(1);
      if (!row) return undefined;
      return { exportJob: toExportDto(row), filePath: row.filePath, fileName: row.fileName };
    },

    async runWdtGoodsSync(input: CreateWdtGoodsSyncRunRequest, actor?: AuthUserDto): Promise<WdtGoodsSyncRunDto> {
      await ready;
      if (!wdtGoodsClient) {
        throw new StoreValidationError("WDT goods sync client is not configured");
      }
      const run = await runWdtGoodsSync(goodsSyncRepository, wdtGoodsClient, {
        mode: input.mode,
        startDate: input.startDate,
        endDate: input.endDate,
        pageSize: input.pageSize,
        maxRetries: input.maxRetries,
        retryDelaysMs: input.retryDelaysMs,
      });
      await insertAuditLog(database, actor?.id ?? null, "wdt.goods_sync.run", "wdt_goods_sync_run", run.id, {
        mode: run.mode,
        status: run.status,
        rangeStart: run.rangeStart,
        rangeEnd: run.rangeEnd,
        fetchedCount: run.fetchedCount,
        upsertedCount: run.upsertedCount,
      });
      return toWdtGoodsSyncRunDto(run);
    },

    async listWdtGoodsSyncRuns(): Promise<WdtGoodsSyncRunDto[]> {
      await ready;
      const rows = await database.db.select().from(wdtGoodsSyncRuns).orderBy(desc(wdtGoodsSyncRuns.startedAt)).limit(20);
      return rows.map(toWdtGoodsSyncRunDto);
    },

    async getLatestWdtGoodsSyncRun(): Promise<WdtGoodsSyncRunDto | undefined> {
      await ready;
      const [row] = await database.db.select().from(wdtGoodsSyncRuns).orderBy(desc(wdtGoodsSyncRuns.startedAt)).limit(1);
      return row ? toWdtGoodsSyncRunDto(row) : undefined;
    },

    async searchWdtGoodsSpecs(query: string): Promise<WdtGoodsSpecSearchResultDto[]> {
      await ready;
      const trimmed = query.trim();
      if (!trimmed) return [];
      const pattern = `%${trimmed}%`;
      const rows = await database.db
        .select()
        .from(wdtGoodsSpecs)
        .where(
          or(
            like(wdtGoodsSpecs.barcode, pattern),
            like(wdtGoodsSpecs.barcodesJson, pattern),
            like(wdtGoodsSpecs.specNo, pattern),
            like(wdtGoodsSpecs.goodsNo, pattern),
            like(wdtGoodsSpecs.goodsName, pattern),
            like(wdtGoodsSpecs.specName, pattern),
          ),
        )
        .limit(20);
      return rows.map(toWdtGoodsSpecSearchResultDto);
    },

    async confirmProductMapping(input: ConfirmProductMappingRequest, actor?: AuthUserDto): Promise<ProductMappingDto> {
      await ready;
      const [spec] = await database.db.select().from(wdtGoodsSpecs).where(eq(wdtGoodsSpecs.specNo, input.wdtSpecNo)).limit(1);
      if (!spec) {
        throw new StoreValidationError(`WDT goods spec not found: ${input.wdtSpecNo}`);
      }
      if (!input.externalBarcode && !input.externalGoodsCode && !input.externalGoodsName) {
        throw new StoreValidationError("At least one external product identifier is required");
      }

      const now = new Date().toISOString();
      const existing = await findProductMapping(database, input);
      const row: ProductMappingRow = {
        id: existing?.id ?? `product-mapping-${randomUUID()}`,
        externalBarcode: input.externalBarcode,
        externalGoodsName: input.externalGoodsName,
        externalGoodsCode: input.externalGoodsCode,
        wdtGoodsNo: spec.goodsNo,
        wdtGoodsName: spec.goodsName,
        wdtSpecNo: spec.specNo,
        wdtSpecName: spec.specName,
        wdtBarcode: spec.barcode,
        status: "confirmed",
        sourceBatchId: input.sourceBatchId,
        confirmedByUserId: actor?.id ?? existing?.confirmedByUserId ?? null,
        confirmedAt: now,
        note: input.note,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      if (existing) {
        await database.db.update(productMappings).set(row).where(eq(productMappings.id, existing.id));
      } else {
        await database.db.insert(productMappings).values(row);
      }
      await deleteProductMatchCandidatesForMapping(database, row);
      await insertAuditLog(database, actor?.id ?? null, "product_mapping.confirm", "product_mapping", row.id, row);
      return toProductMappingDto(row);
    },

    async listProductMappings(query = ""): Promise<ProductMappingDto[]> {
      await ready;
      const trimmed = query.trim();
      const base = database.db.select().from(productMappings);
      const rows = trimmed
        ? await base
            .where(
              or(
                like(productMappings.externalBarcode, `%${trimmed}%`),
                like(productMappings.externalGoodsCode, `%${trimmed}%`),
                like(productMappings.externalGoodsName, `%${trimmed}%`),
                like(productMappings.wdtSpecNo, `%${trimmed}%`),
                like(productMappings.wdtGoodsName, `%${trimmed}%`),
              ),
            )
            .orderBy(desc(productMappings.updatedAt))
            .limit(50)
        : await base.orderBy(desc(productMappings.updatedAt)).limit(50);
      return rows.map(toProductMappingDto);
    },

    async listProductMatchCandidates(query = ""): Promise<ProductMatchCandidateDto[]> {
      await ready;
      const trimmed = query.trim();
      const base = database.db.select().from(productMatchCandidates);
      const rows = trimmed
        ? await base
            .where(
              or(
                like(productMatchCandidates.externalBarcode, `%${trimmed}%`),
                like(productMatchCandidates.externalGoodsCode, `%${trimmed}%`),
                like(productMatchCandidates.externalGoodsName, `%${trimmed}%`),
                like(productMatchCandidates.wdtSpecNo, `%${trimmed}%`),
                like(productMatchCandidates.wdtGoodsName, `%${trimmed}%`),
              ),
            )
            .orderBy(desc(productMatchCandidates.createdAt))
            .limit(250)
        : await base.orderBy(desc(productMatchCandidates.createdAt)).limit(250);
      const confirmedMappings = await database.db.select().from(productMappings).where(eq(productMappings.status, "confirmed"));
      return dedupeProductMatchCandidates(
        rows.map(toProductMatchCandidateDto).filter((candidate) => !confirmedMappings.some((mapping) => productCandidateMatchesMapping(candidate, mapping))),
      ).slice(0, 50);
    },

    async updateProductMappingStatus(
      mappingId: string,
      input: UpdateProductMappingStatusRequest,
      actor?: AuthUserDto,
    ): Promise<ProductMappingDto | undefined> {
      await ready;
      const [existing] = await database.db.select().from(productMappings).where(eq(productMappings.id, mappingId)).limit(1);
      if (!existing) return undefined;
      const patch = { status: input.status, note: input.note, updatedAt: new Date().toISOString() };
      await database.db.update(productMappings).set(patch).where(eq(productMappings.id, mappingId));
      const next = { ...existing, ...patch };
      await insertAuditLog(database, actor?.id ?? null, "product_mapping.update_status", "product_mapping", mappingId, patch);
      return toProductMappingDto(next);
    },

    async close() {
      await ready.catch(() => undefined);
      await database.close();
    },
  };
}

async function getBatchRow(database: DatabaseContext, batchId: string): Promise<BatchRow | undefined> {
  const [batch] = await database.db.select().from(batches).where(eq(batches.id, batchId)).limit(1);
  return batch;
}

async function getWarehouseUsageSettingsRow(database: DatabaseContext): Promise<WarehouseUsageSettingsRow> {
  const [row] = await database.db.select().from(warehouseUsageSettings).where(eq(warehouseUsageSettings.id, "default")).limit(1);
  if (row) return row;
  const now = new Date().toISOString();
  const defaultRow: WarehouseUsageSettingsRow = {
    id: "default",
    includeMainWarehouse: 1,
    includeNearExpiryWarehouse: 1,
    includeDefectWarehouse: 0,
    includeOtherWarehouses: 0,
    updatedByUserId: null,
    updatedByUsername: null,
    updatedAt: now,
  };
  await database.db.insert(warehouseUsageSettings).values(defaultRow);
  return defaultRow;
}

async function findStoreAddressRow(database: DatabaseContext, storeNo: string, normalizedStoreName: string): Promise<StoreAddressRow | undefined> {
  if (storeNo) {
    const [byStoreNo] = await database.db.select().from(storeAddresses).where(eq(storeAddresses.storeNo, storeNo)).limit(1);
    if (byStoreNo) return byStoreNo;
  }
  if (normalizedStoreName) {
    const [byName] = await database.db
      .select()
      .from(storeAddresses)
      .where(eq(storeAddresses.normalizedStoreName, normalizedStoreName))
      .limit(1);
    if (byName) return byName;
  }
  return undefined;
}

interface RealReviewBuildOptions {
  batchId: string;
  orderFile: string;
  goodsSpecs: LocalGoodsSpecCandidate[];
  mappings: ProductMappingCandidate[];
  warehouseSettings: WarehouseUsageSettingsDto;
}

interface RealReviewCandidateRow {
  reviewLineId: string;
  externalBarcode: string;
  externalGoodsName: string;
  externalGoodsCode: string;
  wdtSpecNo: string;
  wdtGoodsNo: string;
  wdtGoodsName: string;
  wdtSpecName: string;
  wdtBarcode: string;
  score: number;
  basis: string;
  source: string;
}

interface RealReviewBuildResult {
  orderLineCount: number;
  uniqueBarcodeCount: number;
  matchedBarcodeCount: number;
  statusCounts: Record<string, number>;
  matchCounts: Record<string, number>;
  stockQueriedCount: number;
  reviewLines: ReviewLineDto[];
  candidateRows: RealReviewCandidateRow[];
}

interface GoodsCacheStatus {
  specCount: number;
  latestRunStatus: string;
  latestRunErrorMessage: string;
  allowStaleCache: boolean;
}

async function buildRealReview(client: StockLookupClient, options: RealReviewBuildOptions): Promise<RealReviewBuildResult> {
  const orderLines = loadOrderLines(options.orderFile);
  const stockBySpecNo = new Map<string, WarehouseStockSummary>();
  const remainingMain = new Map<string, number>();
  const remainingNearExpiry = new Map<string, number>();
  const remainingDefect = new Map<string, number>();
  const remainingOther = new Map<string, number>();
  const reviewLines: ReviewLineDto[] = [];
  const candidateRows: RealReviewCandidateRow[] = [];
  let stockQueriedCount = 0;

  for (const [index, line] of orderLines.entries()) {
    const decision = decideLocalProductMatch(
      {
        barcode: line.externalBarcode,
        goodsCode: line.externalGoodsCode,
        goodsName: line.externalGoodsName,
        specName: line.spec,
      },
      { goodsSpecs: options.goodsSpecs, mappings: options.mappings },
    );

    const id = `${options.batchId}-line-${index + 1}`;
    let stock: WarehouseStockSummary | undefined;
    let matchStatus: ReviewLineDto["matchStatus"] = decision.status;
    let matchMessage = decision.message;
    const specNo = decision.candidate?.specNo ?? "";

    if (decision.status === "matched" && specNo) {
      stock = stockBySpecNo.get(specNo);
      if (!stock) {
        const response = await client.queryStock(specNo);
        if (response.status && response.status !== 0) {
          matchStatus = "api_error";
          matchMessage = `stock query status=${response.status}`;
        } else {
          stock = summarizeWarehouseStock(response.data?.detail_list ?? [], options.warehouseSettings);
          stockBySpecNo.set(specNo, stock);
          remainingMain.set(specNo, stock.mainAvailableStock);
          remainingNearExpiry.set(specNo, stock.nearExpiryAvailableStock);
          remainingDefect.set(specNo, stock.defectAvailableStock);
          remainingOther.set(specNo, stock.otherAvailableStock);
          stockQueriedCount += 1;
        }
      }
    }

    if (decision.status === "ambiguous") {
      candidateRows.push(...toRealReviewCandidateRows(id, line, decision));
    }

    const reviewLine = buildRealReviewLine({
      batchId: options.batchId,
      id,
      sortOrder: index + 1,
      orderLine: line,
      decision,
      matchStatus,
      matchMessage,
      stock,
      remainingMain,
      remainingNearExpiry,
      remainingDefect,
      remainingOther,
      warehouseSettings: options.warehouseSettings,
    });
    reviewLines.push(reviewLine);
  }

  return {
    orderLineCount: orderLines.length,
    uniqueBarcodeCount: new Set(orderLines.map((line) => line.externalBarcode).filter(Boolean)).size,
    matchedBarcodeCount: new Set(reviewLines.filter((line) => line.matchStatus === "matched").map((line) => line.externalBarcode).filter(Boolean)).size,
    statusCounts: countBy(reviewLines.map((line) => line.status)),
    matchCounts: countBy(reviewLines.map((line) => line.matchStatus)),
    stockQueriedCount,
    reviewLines,
    candidateRows,
  };
}

function buildRealReviewLine(input: {
  batchId: string;
  id: string;
  sortOrder: number;
  orderLine: ReturnType<typeof loadOrderLines>[number];
  decision: ProductMatchDecision;
  matchStatus: ReviewLineDto["matchStatus"];
  matchMessage: string;
  stock: WarehouseStockSummary | undefined;
  remainingMain: Map<string, number>;
  remainingNearExpiry: Map<string, number>;
  remainingDefect: Map<string, number>;
  remainingOther: Map<string, number>;
  warehouseSettings: WarehouseUsageSettingsDto;
}): ReviewLineDto {
  const specNo = input.matchStatus === "matched" ? input.decision.candidate?.specNo ?? "" : "";
  const mainBefore = specNo ? input.remainingMain.get(specNo) ?? 0 : 0;
  const nearExpiryBefore = specNo ? input.remainingNearExpiry.get(specNo) ?? 0 : 0;
  const defectBefore = specNo ? input.remainingDefect.get(specNo) ?? 0 : 0;
  const otherBefore = specNo ? input.remainingOther.get(specNo) ?? 0 : 0;
  const usableBefore =
    (input.warehouseSettings.includeMainWarehouse ? mainBefore : 0)
    + (input.warehouseSettings.includeNearExpiryWarehouse ? nearExpiryBefore : 0)
    + (input.warehouseSettings.includeDefectWarehouse ? defectBefore : 0)
    + (input.warehouseSettings.includeOtherWarehouses ? otherBefore : 0);
  const suggestedShipQty = input.matchStatus === "matched" ? Math.min(input.orderLine.orderQty, usableBefore) : 0;

  if (specNo) {
    let remainingToAllocate = suggestedShipQty;
    if (input.warehouseSettings.includeMainWarehouse) {
      const used = Math.min(remainingToAllocate, mainBefore);
      input.remainingMain.set(specNo, mainBefore - used);
      remainingToAllocate -= used;
    }
    if (input.warehouseSettings.includeNearExpiryWarehouse) {
      const used = Math.min(remainingToAllocate, nearExpiryBefore);
      input.remainingNearExpiry.set(specNo, nearExpiryBefore - used);
      remainingToAllocate -= used;
    }
    if (input.warehouseSettings.includeDefectWarehouse) {
      const used = Math.min(remainingToAllocate, defectBefore);
      input.remainingDefect.set(specNo, defectBefore - used);
      remainingToAllocate -= used;
    }
    if (input.warehouseSettings.includeOtherWarehouses) {
      const used = Math.min(remainingToAllocate, otherBefore);
      input.remainingOther.set(specNo, otherBefore - used);
    }
  }

  const status = reviewStatusFor(input.matchStatus, input.orderLine.orderQty, suggestedShipQty);
  const decision = status === "库存充足" ? "ship" : "pending";

  return {
    id: input.id,
    batchId: input.batchId,
    orderNoticeNo: input.orderLine.orderNoticeNo,
    excelRow: input.orderLine.excelRow,
    storeNo: input.orderLine.storeNo,
    storeName: input.orderLine.storeName,
    uploadTime: input.orderLine.uploadTime,
    orderApprovalNo: input.orderLine.orderApprovalNo,
    readingStatus: input.orderLine.readingStatus,
    deliveryMode: input.orderLine.deliveryMode,
    orderStatus: input.orderLine.orderStatus,
    deliveryTarget: input.orderLine.deliveryTarget,
    category: input.orderLine.category,
    orderDate: input.orderLine.orderDate,
    deadlineDate: input.orderLine.deadlineDate,
    salesperson: input.orderLine.salesperson,
    maker: input.orderLine.maker,
    madeAt: input.orderLine.madeAt,
    sourceReviewer: input.orderLine.sourceReviewer,
    externalGoodsCode: input.orderLine.externalGoodsCode,
    externalBarcode: input.orderLine.externalBarcode,
    externalGoodsName: input.orderLine.externalGoodsName,
    originalSpec: input.orderLine.spec,
    transportSpec: input.orderLine.transportSpec,
    orderBoxQty: input.orderLine.orderBoxQty,
    taxExcludedUnitPrice: input.orderLine.taxExcludedUnitPrice,
    contractPrice: input.orderLine.contractPrice,
    taxIncludedUnitPrice: input.orderLine.unitPriceTaxIncluded,
    discountRate: input.orderLine.discountRate,
    shelfLifeDays: input.orderLine.shelfLifeDays,
    receivedQty: input.orderLine.receivedQty,
    giftRate: input.orderLine.giftRate,
    td: input.orderLine.td,
    da: input.orderLine.da,
    pd: input.orderLine.pd,
    spd: input.orderLine.spd,
    rebate: input.orderLine.rebate,
    orderRawJson: JSON.stringify(input.orderLine.raw),
    goodsName: input.decision.candidate?.goodsName ?? "",
    specName: input.decision.candidate?.specName ?? "",
    wdtSpecNo: specNo,
    matchStatus: input.matchStatus,
    matchMessage: input.matchMessage,
    orderQty: input.orderLine.orderQty,
    mainAvailableBefore: mainBefore,
    nearExpiryAvailableBefore: nearExpiryBefore,
    suggestedShipQty,
    status,
    decision,
    approvedShipQty: decision === "ship" ? suggestedShipQty : 0,
    reason: "",
    priority: false,
    priorityReason: "",
  };
}

function reviewStatusFor(matchStatus: ReviewLineDto["matchStatus"], orderQty: number, suggestedShipQty: number): ReviewLineDto["status"] {
  if (matchStatus !== "matched") return "未匹配";
  if (suggestedShipQty >= orderQty) return "库存充足";
  if (suggestedShipQty > 0) return "部分满足";
  return "库存不足";
}

function toRealReviewCandidateRows(
  reviewLineId: string,
  orderLine: ReturnType<typeof loadOrderLines>[number],
  decision: ProductMatchDecision,
): RealReviewCandidateRow[] {
  return decision.candidates.map((candidate) => ({
    reviewLineId,
    externalBarcode: orderLine.externalBarcode,
    externalGoodsName: orderLine.externalGoodsName,
    externalGoodsCode: orderLine.externalGoodsCode,
    wdtSpecNo: candidate.specNo ?? "",
    wdtGoodsNo: candidate.goodsNo ?? "",
    wdtGoodsName: candidate.goodsName ?? "",
    wdtSpecName: candidate.specName ?? "",
    wdtBarcode: candidate.barcodes?.[0] ?? "",
    score: candidate.score,
    basis: candidate.basis,
    source: candidate.source,
  }));
}

async function replaceBatchReviewLines(database: DatabaseContext, batchId: string, lines: ReviewLineDto[], now: string): Promise<void> {
  await database.db.delete(reviewDecisions).where(eq(reviewDecisions.batchId, batchId));
  await database.db.delete(reviewLines).where(eq(reviewLines.batchId, batchId));

  if (lines.length === 0) return;

  await database.db.insert(reviewLines).values(
    lines.map((line, index) => ({
      id: line.id,
      batchId,
      sortOrder: index + 1,
      orderNoticeNo: line.orderNoticeNo,
      excelRow: line.excelRow,
      storeNo: line.storeNo,
      storeName: line.storeName,
      uploadTime: line.uploadTime,
      orderApprovalNo: line.orderApprovalNo,
      readingStatus: line.readingStatus,
      deliveryMode: line.deliveryMode,
      orderStatus: line.orderStatus,
      deliveryTarget: line.deliveryTarget,
      category: line.category,
      orderDate: line.orderDate,
      deadlineDate: line.deadlineDate,
      salesperson: line.salesperson,
      maker: line.maker,
      madeAt: line.madeAt,
      sourceReviewer: line.sourceReviewer,
      externalGoodsCode: line.externalGoodsCode,
      externalBarcode: line.externalBarcode,
      externalGoodsName: line.externalGoodsName,
      originalSpec: line.originalSpec,
      transportSpec: line.transportSpec,
      orderBoxQty: line.orderBoxQty,
      taxExcludedUnitPrice: line.taxExcludedUnitPrice,
      contractPrice: line.contractPrice,
      taxIncludedUnitPrice: line.taxIncludedUnitPrice,
      discountRate: line.discountRate,
      shelfLifeDays: line.shelfLifeDays,
      receivedQty: line.receivedQty,
      giftRate: line.giftRate,
      td: line.td,
      da: line.da,
      pd: line.pd,
      spd: line.spd,
      rebate: line.rebate,
      orderRawJson: line.orderRawJson,
      goodsName: line.goodsName,
      specName: line.specName,
      wdtSpecNo: line.wdtSpecNo,
      matchStatus: line.matchStatus,
      matchMessage: line.matchMessage,
      orderQty: line.orderQty,
      mainAvailableBefore: line.mainAvailableBefore,
      nearExpiryAvailableBefore: line.nearExpiryAvailableBefore,
      suggestedShipQty: line.suggestedShipQty,
      priority: line.priority ? 1 : 0,
      priorityReason: line.priorityReason ?? "",
      status: line.status,
    })),
  );

  await database.db.insert(reviewDecisions).values(
    lines.map((line) => ({
      id: `decision-${randomUUID()}`,
      batchId,
      reviewLineId: line.id,
      reviewerId: null,
      decision: line.decision,
      approvedShipQty: line.approvedShipQty,
      reason: line.reason ?? "",
      createdAt: now,
      updatedAt: now,
    })),
  );
}

async function replaceProductMatchCandidates(
  database: DatabaseContext,
  batchId: string,
  candidates: RealReviewCandidateRow[],
  now: string,
): Promise<void> {
  await database.db.delete(productMatchCandidates).where(eq(productMatchCandidates.batchId, batchId));
  const uniqueCandidates = dedupeRealReviewCandidateRows(candidates);
  if (uniqueCandidates.length === 0) return;
  await database.db.insert(productMatchCandidates).values(
    uniqueCandidates.map((candidate) => ({
      id: `candidate-${randomUUID()}`,
      batchId,
      reviewLineId: candidate.reviewLineId,
      externalBarcode: candidate.externalBarcode,
      externalGoodsName: candidate.externalGoodsName,
      externalGoodsCode: candidate.externalGoodsCode,
      wdtSpecNo: candidate.wdtSpecNo,
      wdtGoodsNo: candidate.wdtGoodsNo,
      wdtGoodsName: candidate.wdtGoodsName,
      wdtSpecName: candidate.wdtSpecName,
      wdtBarcode: candidate.wdtBarcode,
      score: candidate.score,
      basis: candidate.basis,
      source: candidate.source,
      createdAt: now,
    })),
  );
}

function dedupeRealReviewCandidateRows(candidates: RealReviewCandidateRow[]): RealReviewCandidateRow[] {
  const byKey = new Map<string, RealReviewCandidateRow>();
  for (const candidate of candidates) {
    const key = productMatchCandidateKey(candidate);
    const existing = byKey.get(key);
    if (!existing || candidate.score > existing.score) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function dedupeProductMatchCandidates(candidates: ProductMatchCandidateDto[]): ProductMatchCandidateDto[] {
  const byKey = new Map<string, ProductMatchCandidateDto>();
  for (const candidate of candidates) {
    const key = productMatchCandidateKey(candidate);
    const existing = byKey.get(key);
    if (!existing || candidate.score > existing.score) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function productMatchCandidateKey(
  candidate: Pick<
    ProductMatchCandidateDto,
    "externalBarcode" | "externalGoodsCode" | "externalGoodsName" | "wdtSpecNo" | "wdtGoodsNo" | "wdtSpecName" | "wdtBarcode"
  >,
) {
  return [
    normalizeProductCandidateKeyPart(candidate.externalBarcode),
    normalizeProductCandidateKeyPart(candidate.externalGoodsCode),
    normalizeProductCandidateKeyPart(candidate.externalGoodsName),
    normalizeProductCandidateKeyPart(candidate.wdtSpecNo),
    normalizeProductCandidateKeyPart(candidate.wdtGoodsNo),
    normalizeProductCandidateKeyPart(candidate.wdtSpecName),
    normalizeProductCandidateKeyPart(candidate.wdtBarcode),
  ].join("\u0000");
}

function normalizeProductCandidateKeyPart(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

async function deleteProductMatchCandidatesForMapping(database: DatabaseContext, mapping: ProductMappingRow): Promise<void> {
  const conditions = [
    mapping.externalBarcode ? eq(productMatchCandidates.externalBarcode, mapping.externalBarcode) : undefined,
    mapping.externalGoodsCode ? eq(productMatchCandidates.externalGoodsCode, mapping.externalGoodsCode) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
  if (conditions.length === 0 && mapping.externalGoodsName) {
    conditions.push(eq(productMatchCandidates.externalGoodsName, mapping.externalGoodsName));
  }
  if (conditions.length === 0) return;
  await database.db.delete(productMatchCandidates).where(or(...conditions));
}

function productCandidateMatchesMapping(candidate: ProductMatchCandidateDto, mapping: ProductMappingRow): boolean {
  if (mapping.status !== "confirmed") return false;
  if (sameProductIdentifier(candidate.externalBarcode, mapping.externalBarcode)) return true;
  if (sameProductIdentifier(candidate.externalGoodsCode, mapping.externalGoodsCode)) return true;
  if (!mapping.externalBarcode && !mapping.externalGoodsCode && sameProductIdentifier(candidate.externalGoodsName, mapping.externalGoodsName)) return true;
  return false;
}

function sameProductIdentifier(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

async function getGoodsCacheStatus(database: DatabaseContext, allowStaleCache: boolean): Promise<GoodsCacheStatus> {
  const rows = await database.client.execute("select count(*) as count from wdt_goods_specs");
  const specCount = Number(rows.rows[0]?.count ?? 0);
  const [latestRun] = await database.db.select().from(wdtGoodsSyncRuns).orderBy(desc(wdtGoodsSyncRuns.startedAt)).limit(1);
  return {
    specCount,
    latestRunStatus: latestRun?.status ?? "none",
    latestRunErrorMessage: latestRun?.errorMessage ?? "",
    allowStaleCache,
  };
}

function assertReviewGoodsCacheUsable(status: GoodsCacheStatus): void {
  if (status.latestRunStatus === "success") return;
  if (status.allowStaleCache) return;
  throw new StoreValidationError(
    "WDT goods cache is not usable for real review because latest goods sync is not success. latestStatus="
      + status.latestRunStatus
      + " specCount="
      + status.specCount
      + (status.latestRunErrorMessage ? " error=" + status.latestRunErrorMessage : ""),
  );
}

function toLocalGoodsSpecCandidate(row: WdtGoodsSpecRow): LocalGoodsSpecCandidate {
  return {
    goodsNo: row.goodsNo,
    goodsName: row.goodsName,
    specNo: row.specNo,
    specName: row.specName,
    specCode: row.specCode,
    barcode: row.barcode,
    barcodes: parseBarcodes(row.barcodesJson),
    deleted: row.deleted,
  };
}

function toProductMappingCandidate(row: ProductMappingRow): ProductMappingCandidate {
  return {
    externalBarcode: row.externalBarcode,
    externalGoodsName: row.externalGoodsName,
    externalGoodsCode: row.externalGoodsCode,
    wdtGoodsNo: row.wdtGoodsNo,
    wdtGoodsName: row.wdtGoodsName,
    wdtSpecNo: row.wdtSpecNo,
    wdtSpecName: row.wdtSpecName,
    wdtBarcode: row.wdtBarcode,
    status: row.status,
  };
}

function summarizeWarehouseStock(rows: WdtStockRow[], settings: WarehouseUsageSettingsDto): WarehouseStockSummary {
  let mainAvailableStock = 0;
  let nearExpiryAvailableStock = 0;
  let defectAvailableStock = 0;
  let otherAvailableStock = 0;

  for (const row of rows) {
    const available = Number(row.available_send_stock ?? 0);
    const warehouseNo = row.warehouse_no ?? "";
    if (warehouseNo === "001") mainAvailableStock += available;
    else if (warehouseNo === "LINQI") nearExpiryAvailableStock += available;
    else if (warehouseNo === "CIPIN" || row.defect === true) defectAvailableStock += available;
    else otherAvailableStock += available;
  }

  const usableAvailableStock =
    (settings.includeMainWarehouse ? mainAvailableStock : 0)
    + (settings.includeNearExpiryWarehouse ? nearExpiryAvailableStock : 0)
    + (settings.includeDefectWarehouse ? defectAvailableStock : 0)
    + (settings.includeOtherWarehouses ? otherAvailableStock : 0);

  return {
    mainAvailableStock,
    nearExpiryAvailableStock,
    defectAvailableStock,
    otherAvailableStock,
    usableAvailableStock,
    warehouseBreakdown: rows
      .map((row) => `${row.warehouse_no ?? ""}/${row.warehouse_name ?? ""}:${row.available_send_stock ?? 0}`)
      .filter(Boolean)
      .join("; "),
  };
}

function countBy(items: string[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item] = (counts[item] ?? 0) + 1;
    return counts;
  }, {});
}

async function getReviewLineDtos(database: DatabaseContext, batchId: string): Promise<ReviewLineDto[]> {
  const lineRows = await database.db
    .select()
    .from(reviewLines)
    .where(eq(reviewLines.batchId, batchId))
    .orderBy(desc(reviewLines.priority), reviewLines.sortOrder);
  if (lineRows.length === 0) return [];

  const decisionRows = await database.db.select().from(reviewDecisions).where(eq(reviewDecisions.batchId, batchId));
  const decisionsByLineId = new Map(decisionRows.map((decision) => [decision.reviewLineId, decision]));
  return lineRows.map((line) => toReviewLineDto(line, decisionsByLineId.get(line.id)));
}

async function replaceReviewDecision(
  database: DatabaseContext,
  line: ReviewLineRow,
  decision: ReviewDecisionDto,
  updatedAt: string,
  previousDecision?: ReviewDecisionRow,
  reviewerId?: string | null,
): Promise<ReviewDecisionRow> {
  validateReviewDecision(line, decision);
  await database.db.delete(reviewDecisions).where(eq(reviewDecisions.reviewLineId, line.id));
  const nextDecision: ReviewDecisionRow = {
    id: previousDecision?.id ?? `decision-${randomUUID()}`,
    batchId: line.batchId,
    reviewLineId: line.id,
    reviewerId: reviewerId ?? previousDecision?.reviewerId ?? null,
    decision: decision.decision,
    approvedShipQty: decision.approvedShipQty,
    reason: decision.reason ?? "",
    createdAt: previousDecision?.createdAt ?? updatedAt,
    updatedAt,
  };
  await database.db.insert(reviewDecisions).values(nextDecision);
  return nextDecision;
}

function validateReviewDecision(line: ReviewLineRow, decision: ReviewDecisionDto) {
  if (decision.approvedShipQty < 0) {
    throw new StoreValidationError("发货数量不能小于 0");
  }
}

function toBatchSummary(batch: BatchRow): BatchSummary {
  return {
    id: batch.id,
    fileName: batch.fileName,
    mode: batch.mode,
    status: batch.status,
    orderLineCount: batch.orderLineCount,
    uniqueBarcodeCount: batch.uniqueBarcodeCount,
    matchedBarcodeCount: batch.matchedBarcodeCount,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

function toWarehouseUsageSettingsDto(row: WarehouseUsageSettingsRow): WarehouseUsageSettingsDto {
  return {
    includeMainWarehouse: Boolean(row.includeMainWarehouse),
    includeNearExpiryWarehouse: Boolean(row.includeNearExpiryWarehouse),
    includeDefectWarehouse: Boolean(row.includeDefectWarehouse),
    includeOtherWarehouses: Boolean(row.includeOtherWarehouses),
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId ?? null,
    updatedByUsername: row.updatedByUsername ?? null,
  };
}

function toStoreAddressDto(row: StoreAddressRow): StoreAddressDto {
  return {
    id: row.id,
    storeNo: row.storeNo,
    storeName: row.storeName,
    receiver: row.receiver,
    phone: row.phone,
    address: row.address,
    note: row.note,
    sourceSheet: row.sourceSheet,
    sourceRow: row.sourceRow,
    importedAt: row.importedAt,
    rawJson: row.rawJson,
    updatedByUserId: row.updatedByUserId ?? null,
    updatedByUsername: row.updatedByUsername ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toReviewLineDto(line: ReviewLineRow, decision?: ReviewDecisionRow): ReviewLineDto {
  return {
    id: line.id,
    batchId: line.batchId,
    orderNoticeNo: line.orderNoticeNo,
    excelRow: line.excelRow,
    storeNo: line.storeNo,
    storeName: line.storeName,
    uploadTime: line.uploadTime,
    orderApprovalNo: line.orderApprovalNo,
    readingStatus: line.readingStatus,
    deliveryMode: line.deliveryMode,
    orderStatus: line.orderStatus,
    deliveryTarget: line.deliveryTarget,
    category: line.category,
    orderDate: line.orderDate,
    deadlineDate: line.deadlineDate,
    salesperson: line.salesperson,
    maker: line.maker,
    madeAt: line.madeAt,
    sourceReviewer: line.sourceReviewer,
    externalGoodsCode: line.externalGoodsCode,
    externalBarcode: line.externalBarcode,
    externalGoodsName: line.externalGoodsName,
    originalSpec: line.originalSpec,
    transportSpec: line.transportSpec,
    orderBoxQty: line.orderBoxQty,
    taxExcludedUnitPrice: line.taxExcludedUnitPrice,
    contractPrice: line.contractPrice,
    taxIncludedUnitPrice: line.taxIncludedUnitPrice,
    discountRate: line.discountRate,
    shelfLifeDays: line.shelfLifeDays,
    receivedQty: line.receivedQty,
    giftRate: line.giftRate,
    td: line.td,
    da: line.da,
    pd: line.pd,
    spd: line.spd,
    rebate: line.rebate,
    orderRawJson: line.orderRawJson,
    goodsName: line.goodsName,
    specName: line.specName,
    wdtSpecNo: line.wdtSpecNo,
    matchStatus: line.matchStatus,
    matchMessage: line.matchMessage,
    orderQty: line.orderQty,
    mainAvailableBefore: line.mainAvailableBefore,
    nearExpiryAvailableBefore: line.nearExpiryAvailableBefore,
    suggestedShipQty: line.suggestedShipQty,
    status: line.status,
    decision: decision?.decision ?? "pending",
    approvedShipQty: decision?.approvedShipQty ?? 0,
    reason: decision?.reason ?? "",
    priority: Boolean(line.priority),
    priorityReason: line.priorityReason ?? "",
  };
}

function toExportDto(exportRow: ExportRow): ExportDto {
  return {
    id: exportRow.id,
    batchId: exportRow.batchId,
    type: exportRow.type,
    status: exportRow.status,
    fileName: exportRow.fileName,
    downloadUrl: exportRow.status === "ready" ? `/api/v1/exports/${exportRow.id}/download` : undefined,
    errorMessage: exportRow.errorMessage || null,
    createdByUserId: exportRow.createdByUserId ?? null,
    createdByUsername: exportRow.createdByUsername ?? null,
    createdAt: exportRow.createdAt,
  };
}

async function findProductMapping(
  database: DatabaseContext,
  input: Pick<ConfirmProductMappingRequest, "externalBarcode" | "externalGoodsCode" | "externalGoodsName">,
): Promise<ProductMappingRow | undefined> {
  const conditions = [
    input.externalBarcode ? eq(productMappings.externalBarcode, input.externalBarcode) : undefined,
    input.externalGoodsCode ? eq(productMappings.externalGoodsCode, input.externalGoodsCode) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
  if (conditions.length === 0 && input.externalGoodsName) {
    conditions.push(eq(productMappings.externalGoodsName, input.externalGoodsName));
  }
  if (conditions.length === 0) return undefined;
  const [row] = await database.db.select().from(productMappings).where(or(...conditions)).limit(1);
  return row;
}

function createGoodsSyncRepository(database: DatabaseContext): GoodsSyncRepository {
  return {
    async createGoodsSyncRun(input) {
      const row: typeof wdtGoodsSyncRuns.$inferInsert = {
        ...input,
        finishedAt: "",
        windowCount: 0,
        pageCount: 0,
        fetchedCount: 0,
        upsertedCount: 0,
        errorMessage: "",
      };
      await database.db.insert(wdtGoodsSyncRuns).values(row);
      return toGoodsSyncRunRecord(row);
    },

    async finishGoodsSyncRun(runId, patch) {
      await database.db.update(wdtGoodsSyncRuns).set(patch).where(eq(wdtGoodsSyncRuns.id, runId));
      const [row] = await database.db.select().from(wdtGoodsSyncRuns).where(eq(wdtGoodsSyncRuns.id, runId)).limit(1);
      if (!row) throw new Error(`WDT goods sync run not found after finish: ${runId}`);
      return toGoodsSyncRunRecord(row);
    },

    async getLatestSuccessfulGoodsSyncRun() {
      const [row] = await database.db
        .select()
        .from(wdtGoodsSyncRuns)
        .where(eq(wdtGoodsSyncRuns.status, "success"))
        .orderBy(desc(wdtGoodsSyncRuns.rangeEnd))
        .limit(1);
      return row ? toGoodsSyncRunRecord(row) : undefined;
    },

    async upsertGoodsSpecs(specs, syncedAt) {
      let upserted = 0;
      for (const spec of specs) {
        const row = toWdtGoodsSpecInsert(spec, syncedAt);
        await database.db
          .insert(wdtGoodsSpecs)
          .values(row)
          .onConflictDoUpdate({
            target: wdtGoodsSpecs.specNo,
            set: {
              goodsNo: row.goodsNo,
              goodsName: row.goodsName,
              specName: row.specName,
              specCode: row.specCode,
              barcode: row.barcode,
              barcodesJson: row.barcodesJson,
              deleted: row.deleted,
              modified: row.modified,
              rawJson: row.rawJson,
              syncedAt: row.syncedAt,
            },
          });
        upserted += 1;
      }
      return upserted;
    },
  };
}

function toWdtGoodsSpecInsert(spec: WdtGoodsSpecPayload, syncedAt: string): typeof wdtGoodsSpecs.$inferInsert {
  return {
    id: `wdt-goods-spec-${spec.specNo}`,
    goodsNo: spec.goodsNo,
    goodsName: spec.goodsName,
    specNo: spec.specNo,
    specName: spec.specName,
    specCode: spec.specCode,
    barcode: spec.barcode,
    barcodesJson: JSON.stringify(spec.barcodes),
    deleted: spec.deleted,
    modified: spec.modified,
    rawJson: JSON.stringify(spec.raw),
    syncedAt,
  };
}

function toGoodsSyncRunRecord(row: WdtGoodsSyncRunRow | typeof wdtGoodsSyncRuns.$inferInsert): GoodsSyncRunRecord {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? "",
    rangeStart: row.rangeStart,
    rangeEnd: row.rangeEnd,
    windowCount: row.windowCount ?? 0,
    pageCount: row.pageCount ?? 0,
    fetchedCount: row.fetchedCount ?? 0,
    upsertedCount: row.upsertedCount ?? 0,
    errorMessage: row.errorMessage ?? "",
  };
}

function toWdtGoodsSyncRunDto(row: GoodsSyncRunRecord | WdtGoodsSyncRunRow): WdtGoodsSyncRunDto {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    rangeStart: row.rangeStart,
    rangeEnd: row.rangeEnd,
    windowCount: row.windowCount,
    pageCount: row.pageCount,
    fetchedCount: row.fetchedCount,
    upsertedCount: row.upsertedCount,
    errorMessage: row.errorMessage,
  };
}

function toWdtGoodsSpecSearchResultDto(row: WdtGoodsSpecRow): WdtGoodsSpecSearchResultDto {
  return {
    id: row.id,
    goodsNo: row.goodsNo,
    goodsName: row.goodsName,
    specNo: row.specNo,
    specName: row.specName,
    specCode: row.specCode,
    barcode: row.barcode,
    barcodes: parseBarcodes(row.barcodesJson),
    deleted: row.deleted,
    modified: row.modified,
    syncedAt: row.syncedAt,
  };
}

function toProductMappingDto(row: ProductMappingRow): ProductMappingDto {
  return {
    id: row.id,
    externalBarcode: row.externalBarcode,
    externalGoodsName: row.externalGoodsName,
    externalGoodsCode: row.externalGoodsCode,
    wdtGoodsNo: row.wdtGoodsNo,
    wdtGoodsName: row.wdtGoodsName,
    wdtSpecNo: row.wdtSpecNo,
    wdtSpecName: row.wdtSpecName,
    wdtBarcode: row.wdtBarcode,
    status: row.status,
    sourceBatchId: row.sourceBatchId,
    confirmedByUserId: row.confirmedByUserId ?? null,
    confirmedAt: row.confirmedAt,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProductMatchCandidateDto(row: ProductMatchCandidateRow): ProductMatchCandidateDto {
  return {
    id: row.id,
    batchId: row.batchId,
    reviewLineId: row.reviewLineId,
    externalBarcode: row.externalBarcode,
    externalGoodsName: row.externalGoodsName,
    externalGoodsCode: row.externalGoodsCode,
    wdtSpecNo: row.wdtSpecNo,
    wdtGoodsNo: row.wdtGoodsNo,
    wdtGoodsName: row.wdtGoodsName,
    wdtSpecName: row.wdtSpecName,
    wdtBarcode: row.wdtBarcode,
    score: row.score,
    basis: row.basis,
    source: row.source,
    createdAt: row.createdAt,
  };
}

function parseBarcodes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function insertAuditLog(
  database: DatabaseContext,
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  payload: unknown,
) {
  await database.db.insert(auditLogs).values({
    id: `audit-${randomUUID()}`,
    actorId,
    action,
    entityType,
    entityId,
    payloadJson: JSON.stringify(payload),
    createdAt: new Date().toISOString(),
  });
}

function resolveProjectPath(path: string, projectRoot: string): string {
  if (isAbsolute(path)) return path;
  return resolve(projectRoot, path);
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.map((path) => resolve(path)))];
}

async function removeRuntimeFile(filePath: string, safeDirs: string[]): Promise<boolean> {
  if (!filePath) return false;
  const resolvedFilePath = resolve(filePath);
  const safeDir = safeDirs.find((dir) => isPathWithin(resolve(dir), resolvedFilePath));
  if (!safeDir) return false;
  await rm(resolvedFilePath, { force: true });
  return true;
}

function isPathWithin(baseDir: string, targetPath: string): boolean {
  const relativePath = relative(baseDir, targetPath);
  return relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function prepareDatabase(database: DatabaseContext, bootstrapUsers: Array<{ username: string; password: string; role: AuthUserDto["role"] }>) {
  await database.ready;
  await ensureReviewLineColumns(database);
  await ensureWarehouseUsageSettings(database);
  await ensureStoreAddresses(database);
  await ensureBootstrapUsers(database, bootstrapUsers);
}

async function ensureReviewLineColumns(database: DatabaseContext) {
  const columns = await getTableColumns(database, "review_lines");
  if (columns.length === 0) return;
  const textColumns: Array<[string, string]> = [
    ["order_approval_no", "''"],
    ["reading_status", "''"],
    ["delivery_mode", "''"],
    ["order_status", "''"],
    ["delivery_target", "''"],
    ["category", "''"],
    ["order_date", "''"],
    ["deadline_date", "''"],
    ["salesperson", "''"],
    ["maker", "''"],
    ["made_at", "''"],
    ["source_reviewer", "''"],
    ["external_goods_code", "''"],
    ["original_spec", "''"],
    ["transport_spec", "''"],
    ["order_box_qty", "''"],
    ["tax_excluded_unit_price", "''"],
    ["contract_price", "''"],
    ["tax_included_unit_price", "''"],
    ["discount_rate", "''"],
    ["shelf_life_days", "''"],
    ["received_qty", "''"],
    ["gift_rate", "''"],
    ["td", "''"],
    ["da", "''"],
    ["pd", "''"],
    ["spd", "''"],
    ["rebate", "''"],
    ["order_raw_json", "'{}'"],
  ];
  for (const [column, defaultValue] of textColumns) {
    if (!columns.includes(column)) {
      await database.client.execute(`alter table review_lines add column ${column} text not null default ${defaultValue}`);
    }
  }
  if (!columns.includes("priority")) {
    await database.client.execute("alter table review_lines add column priority integer not null default 0");
  }
  if (!columns.includes("priority_reason")) {
    await database.client.execute("alter table review_lines add column priority_reason text not null default ''");
  }
  if (columns.includes("is_priority")) {
    await database.client.execute("update review_lines set priority = coalesce(is_priority, 0) where coalesce(priority, 0) = 0");
  }
  if (columns.includes("priority_reason")) {
    await database.client.execute("update review_lines set priority_reason = coalesce(priority_reason, '')");
  }
}

async function getTableColumns(database: DatabaseContext, tableName: string): Promise<string[]> {
  const result = await database.client.execute(`pragma table_info(${tableName})`);
  return result.rows.map((row) => String(row.name));
}

async function ensureWarehouseUsageSettings(database: DatabaseContext) {
  await database.client.execute(`
    create table if not exists warehouse_usage_settings (
      id text primary key not null,
      include_main_warehouse integer not null default 1,
      include_near_expiry_warehouse integer not null default 1,
      include_defect_warehouse integer not null default 0,
      include_other_warehouses integer not null default 0,
      updated_by_user_id text,
      updated_by_username text,
      updated_at text not null
    )
  `);
  await migrateLegacyWarehouseUsageSettings(database);
  await getWarehouseUsageSettingsRow(database);
}

async function ensureStoreAddresses(database: DatabaseContext) {
  await database.client.execute(`
    create table if not exists store_addresses (
      id text primary key not null,
      store_no text not null default '',
      store_name text not null,
      normalized_store_name text not null default '',
      receiver text not null default '',
      phone text not null default '',
      address text not null,
      note text not null default '',
      source_sheet text not null default '',
      source_row integer not null default 0,
      imported_at text not null default '',
      raw_json text not null default '{}',
      updated_by_user_id text,
      updated_by_username text,
      created_at text not null,
      updated_at text not null
    )
  `);
  const columns = await getTableColumns(database, "store_addresses");
  if (!columns.includes("source_sheet")) {
    await database.client.execute("alter table store_addresses add column source_sheet text not null default ''");
  }
  if (!columns.includes("source_row")) {
    await database.client.execute("alter table store_addresses add column source_row integer not null default 0");
  }
  if (!columns.includes("imported_at")) {
    await database.client.execute("alter table store_addresses add column imported_at text not null default ''");
  }
  if (!columns.includes("raw_json")) {
    await database.client.execute("alter table store_addresses add column raw_json text not null default '{}'");
  }
  await database.client.execute("create index if not exists store_addresses_store_no_idx on store_addresses (store_no)");
  await database.client.execute("create index if not exists store_addresses_normalized_store_name_idx on store_addresses (normalized_store_name)");
  await database.client.execute("create index if not exists store_addresses_updated_at_idx on store_addresses (updated_at)");
}

async function migrateLegacyWarehouseUsageSettings(database: DatabaseContext) {
  const existing = await database.db.select().from(warehouseUsageSettings).where(eq(warehouseUsageSettings.id, "default")).limit(1);
  const current = existing[0];
  if (current?.updatedByUserId || current?.updatedByUsername) return;

  let legacyRows: Awaited<ReturnType<DatabaseContext["client"]["execute"]>>["rows"];
  try {
    const result = await database.client.execute("select value_json, updated_at, updated_by_user_id from app_settings where key = 'warehouse_usage' limit 1");
    legacyRows = result.rows;
  } catch {
    return;
  }
  const legacy = legacyRows[0];
  if (!legacy) return;

  const parsed = parseLegacyWarehouseUsageSettings(String(legacy.value_json ?? ""));
  if (!parsed) return;
  const row: WarehouseUsageSettingsRow = {
    id: "default",
    includeMainWarehouse: parsed.includeMainWarehouse ? 1 : 0,
    includeNearExpiryWarehouse: parsed.includeNearExpiryWarehouse ? 1 : 0,
    includeDefectWarehouse: parsed.includeDefectWarehouse ? 1 : 0,
    includeOtherWarehouses: parsed.includeOtherWarehouses ? 1 : 0,
    updatedByUserId: legacy.updated_by_user_id ? String(legacy.updated_by_user_id) : null,
    updatedByUsername: null,
    updatedAt: legacy.updated_at ? String(legacy.updated_at) : new Date().toISOString(),
  };

  await database.db
    .insert(warehouseUsageSettings)
    .values(row)
    .onConflictDoUpdate({
      target: warehouseUsageSettings.id,
      set: {
        includeMainWarehouse: row.includeMainWarehouse,
        includeNearExpiryWarehouse: row.includeNearExpiryWarehouse,
        includeDefectWarehouse: row.includeDefectWarehouse,
        includeOtherWarehouses: row.includeOtherWarehouses,
        updatedByUserId: row.updatedByUserId,
        updatedByUsername: row.updatedByUsername,
        updatedAt: row.updatedAt,
      },
    });
}

function parseLegacyWarehouseUsageSettings(valueJson: string): Pick<
  WarehouseUsageSettingsDto,
  "includeMainWarehouse" | "includeNearExpiryWarehouse" | "includeDefectWarehouse" | "includeOtherWarehouses"
> | null {
  try {
    const parsed = JSON.parse(valueJson) as { enabledBuckets?: Record<string, unknown> };
    return {
      includeMainWarehouse: parsed.enabledBuckets?.main === true,
      includeNearExpiryWarehouse: parsed.enabledBuckets?.nearExpiry === true,
      includeDefectWarehouse: parsed.enabledBuckets?.defect === true,
      includeOtherWarehouses: parsed.enabledBuckets?.other === true,
    };
  } catch {
    return null;
  }
}

async function ensureBootstrapUsers(database: DatabaseContext, bootstrapUsers: Array<{ username: string; password: string; role: AuthUserDto["role"] }>) {
  await database.ready;
  const now = new Date().toISOString();
  for (const user of bootstrapUsers) {
    const existing = await findUserByUsername(database, user.username);
    if (existing) continue;
    await database.db.insert(users).values({
      id: `user-${randomUUID()}`,
      username: user.username,
      passwordHash: await hashPassword(user.password),
      role: user.role,
      createdAt: now,
    });
  }
}

async function findUserByUsername(database: DatabaseContext, username: string): Promise<UserRow | undefined> {
  const [user] = await database.db.select().from(users).where(eq(users.username, username)).limit(1);
  return user;
}

async function findUserById(database: DatabaseContext, userId: string): Promise<UserRow | undefined> {
  const [user] = await database.db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user;
}

async function findSession(database: DatabaseContext, sessionId: string): Promise<SessionRow | undefined> {
  const [session] = await database.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) return undefined;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await database.db.delete(sessions).where(eq(sessions.id, sessionId));
    return undefined;
  }
  await database.db.update(sessions).set({ lastUsedAt: new Date().toISOString() }).where(eq(sessions.id, sessionId));
  return session;
}

function toAuthUserDto(user: UserRow): AuthUserDto {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
  };
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const [algorithm, salt, hash] = passwordHash.split("$");
  if (algorithm !== "scrypt" || !salt || !hash) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return hash === derived.toString("hex");
}

const scrypt = promisify(scryptCallback);

function buildExportFileName(fileName: string, type: ExportDto["type"], isoTime: string) {
  const base = fileName.replace(/\.[^.]+$/, "") || fileName;
  const stamp = isoTime.replace(/[:.]/g, "-");
  const extension = type === "wdt_import" ? "xls" : "xlsx";
  return `${base}-${type}-${stamp}.${extension}`;
}

const WDT_IMPORT_SHEET_NAME = "Sheet1";

const REVIEW_EXPORT_SHEET_NAME = "订货审批单明细";

const REVIEW_EXPORT_HEADERS = [
  "审批单号",
  "通知单号",
  "收货地编码",
  "收货地名称",
  "要货地编码",
  "要货地名称",
  "业务员",
  "物流模式",
  "送货日期",
  "截止日期",
  "商品编码",
  "商品条码",
  "商品名称",
  "规格",
  "运输规格",
  "订货数量",
  "订货箱数",
  "合同进价",
  "主仓",
  "临期仓",
] as const;

const CONFIRMED_EXPORT_HEADERS = [
  "审批单号",
  "通知单号",
  "收货地编码",
  "收货地名称",
  "业务员",
  "截止日期",
  "商品编码",
  "商品条码",
  "商品名称",
  "规格",
  "订货数量",
  "发货数量",
  "合同进价",
  "主仓",
  "临期仓",
  "备注",
] as const;

const WDT_IMPORT_HEADERS = [
  "店铺名称",
  "原始单号",
  "订单编号",
  "收货信息",
  "收件人",
  "省",
  "市",
  "区",
  "手机",
  "固话",
  "邮编",
  "网名",
  "地址",
  "发货条件",
  "应收合计",
  "邮费",
  "优惠金额",
  "COD买家费用",
  "已收金额",
  "收款账户",
  "仓库名称",
  "物流公司",
  "下单时间",
  "付款时间",
  "买家备注",
  "客服备注",
  "打印备注",
  "发票类型",
  "发票抬头",
  "发票内容",
  "业务员",
  "商家编码",
  "货品数量",
  "货品价格",
  "货品总价",
  "货品优惠",
  "原始子单号",
  "赠品方式",
  "货品备注",
  "订单类别",
  "平台货品名称",
  "平台规格名称",
  "证件号码",
  "计划发货时间",
  "订单标签",
  "标记名称",
  "平台",
  "付款账户",
  "分销商名称",
] as const;

const WDT_IMPORT_DEFAULTS = {
  shopName: "KA运营B组",
  customerName: "M7Z2OLE超市",
  deliveryCondition: "挂账",
  warehouseName: "主仓",
  logisticsCompany: "加密-京东",
  invoiceType: "电子普通发票",
  invoiceTitle: "润家商业(深圳)有限公司",
} as const;

interface MakeOrderAddress {
  storeNo: string;
  storeName: string;
  receiver: string;
  phone: string;
  address: string;
}

interface ParsedStoreAddress extends MakeOrderAddress {
  note: string;
  sourceSheet: string;
  sourceSheetIndex: number;
  sourceOrder: number;
  sourceRow: number;
  rawFields: Record<string, string>;
}

interface StoreAddressImportGroup {
  address: ParsedStoreAddress;
  rawAddresses: ParsedStoreAddress[];
}

interface MakeOrderAddressIndex {
  byStoreNo: Map<string, MakeOrderAddress>;
  byStoreName: Map<string, MakeOrderAddress>;
}

function renderExportWorkbook(
  _batch: BatchRow,
  type: ExportDto["type"],
  lines: ReviewLineDto[],
  addressIndex?: MakeOrderAddressIndex,
) {
  if (type === "wdt_import") {
    return renderWdtImportWorkbook(lines, addressIndex ?? emptyMakeOrderAddressIndex());
  }
  if (type === "review") {
    return renderReviewExportWorkbook(lines);
  }
  return renderConfirmedExportWorkbook(lines);
}

function renderReviewExportWorkbook(lines: ReviewLineDto[]) {
  const rows = [
    [...REVIEW_EXPORT_HEADERS],
    ...lines.map((line) => renderReviewExportRow(line)),
  ];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, REVIEW_EXPORT_SHEET_NAME);
  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
}

function renderReviewExportRow(line: ReviewLineDto) {
  const values: Partial<Record<(typeof REVIEW_EXPORT_HEADERS)[number], string | number>> = {
    审批单号: line.orderApprovalNo,
    通知单号: line.orderNoticeNo,
    收货地名称: line.storeName,
    要货地名称: line.storeName,
    业务员: line.salesperson,
    物流模式: line.deliveryMode,
    截止日期: line.deadlineDate,
    商品编码: line.externalGoodsCode,
    商品条码: line.externalBarcode,
    商品名称: line.externalGoodsName,
    规格: line.originalSpec,
    运输规格: line.transportSpec,
    订货数量: line.orderQty,
    订货箱数: line.orderBoxQty,
    合同进价: line.contractPrice,
  };

  return REVIEW_EXPORT_HEADERS.map((header) => values[header] ?? "");
}

function renderConfirmedExportWorkbook(lines: ReviewLineDto[]) {
  const exportLines = lines.filter((line) => line.decision === "ship" && line.approvedShipQty > 0);
  const rows = [
    [...CONFIRMED_EXPORT_HEADERS],
    ...exportLines.map((line) => renderConfirmedExportRow(line)),
  ];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, REVIEW_EXPORT_SHEET_NAME);
  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
}

function renderConfirmedExportRow(line: ReviewLineDto) {
  const values: Partial<Record<(typeof CONFIRMED_EXPORT_HEADERS)[number], string | number>> = {
    审批单号: line.orderApprovalNo,
    通知单号: line.orderNoticeNo,
    收货地名称: line.storeName,
    业务员: line.salesperson,
    截止日期: line.deadlineDate,
    商品编码: line.externalGoodsCode,
    商品条码: line.externalBarcode,
    商品名称: line.externalGoodsName,
    规格: line.originalSpec,
    订货数量: line.orderQty,
    发货数量: line.approvedShipQty,
    合同进价: line.contractPrice,
  };

  return CONFIRMED_EXPORT_HEADERS.map((header) => values[header] ?? "");
}

function renderWdtImportWorkbook(lines: ReviewLineDto[], addressIndex: MakeOrderAddressIndex) {
  const exportLines = lines.filter((line) => line.decision === "ship" && line.approvedShipQty > 0);
  const rows = [
    [...WDT_IMPORT_HEADERS],
    ...exportLines.map((line) => renderWdtImportRow(line, addressIndex, WDT_IMPORT_HEADERS)),
  ];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, WDT_IMPORT_SHEET_NAME);
  return XLSX.write(workbook, { bookType: "biff8", type: "buffer" }) as Buffer;
}

function renderWdtImportRow(line: ReviewLineDto, addressIndex: MakeOrderAddressIndex, headers: readonly string[]) {
  const makeOrderAddress = findMakeOrderAddress(addressIndex, line);
  const values: Partial<Record<string, string | number>> = {
    店铺名称: WDT_IMPORT_DEFAULTS.shopName,
    原始单号: line.orderNoticeNo,
    收件人: makeOrderAddress?.receiver ?? "",
    网名: WDT_IMPORT_DEFAULTS.customerName,
    地址: makeOrderAddress?.address ?? "",
    手机: makeOrderAddress?.phone ?? "",
    发货条件: WDT_IMPORT_DEFAULTS.deliveryCondition,
    仓库名称: WDT_IMPORT_DEFAULTS.warehouseName,
    物流公司: WDT_IMPORT_DEFAULTS.logisticsCompany,
    客服备注: line.reason,
    打印备注: line.orderNoticeNo,
    发票类型: WDT_IMPORT_DEFAULTS.invoiceType,
    发票抬头: WDT_IMPORT_DEFAULTS.invoiceTitle,
    商家编码: line.wdtSpecNo,
    货品数量: line.approvedShipQty,
    平台货品名称: line.externalGoodsName,
    平台规格名称: line.specName,
  };

  return headers.map((header) => values[header] ?? "");
}

function buildMakeOrderReadiness(batchId: string, lines: ReviewLineDto[], addressIndex: MakeOrderAddressIndex): MakeOrderReadinessDto {
  const shippableLines = lines.filter((line) => line.decision === "ship" && line.approvedShipQty > 0);
  const missingByStore = new Map<string, MissingMakeOrderStoreDto>();

  for (const line of shippableLines) {
    if (isCompleteMakeOrderAddress(findMakeOrderAddress(addressIndex, line))) continue;
    const key = line.storeNo || line.storeName;
    const current = missingByStore.get(key) ?? {
      storeNo: line.storeNo,
      storeName: line.storeName,
      shippableLineCount: 0,
      orderNoticeNos: [],
    };
    current.shippableLineCount += 1;
    if (line.orderNoticeNo && !current.orderNoticeNos.includes(line.orderNoticeNo)) {
      current.orderNoticeNos.push(line.orderNoticeNo);
    }
    missingByStore.set(key, current);
  }

  const missingStores = [...missingByStore.values()].sort((a, b) => [a.storeNo, a.storeName].join("|").localeCompare([b.storeNo, b.storeName].join("|")));
  return {
    batchId,
    canExport: shippableLines.length > 0 && missingStores.length === 0,
    shippableLineCount: shippableLines.length,
    missingAddressCount: missingStores.length,
    missingStores,
  };
}

function makeOrderReadinessError(readiness: MakeOrderReadinessDto) {
  if (readiness.shippableLineCount === 0) return "没有可做单的发货明细";
  if (readiness.missingAddressCount === 0) return "做单预检查未通过";
  const names = readiness.missingStores
    .slice(0, 3)
    .map((store) => store.storeName || store.storeNo)
    .filter(Boolean)
    .join("、");
  const suffix = readiness.missingAddressCount > 3 ? `等 ${readiness.missingAddressCount} 个门店` : "";
  return `缺少发货地址：${names}${suffix}`;
}

async function loadMakeOrderAddressIndex(database: DatabaseContext): Promise<MakeOrderAddressIndex> {
  const index = emptyMakeOrderAddressIndex();
  const rows = await database.db.select().from(storeAddresses).orderBy(desc(storeAddresses.updatedAt));
  for (const row of rows) {
    addMakeOrderAddress(
      index,
      {
        storeNo: row.storeNo,
        storeName: row.storeName,
        receiver: row.receiver,
        phone: row.phone,
        address: row.address,
      },
      true,
    );
  }
  return index;
}

function parseStoreAddressImportInput(input: ImportStoreAddressesRequest) {
  const workbook = XLSX.read(Buffer.from(input.contentBase64, "base64"), { type: "buffer", cellDates: false });
  return { workbookSheetCount: workbook.SheetNames.length, ...parseStoreAddressWorkbook(workbook) };
}

async function buildStoreAddressImportPreview(database: DatabaseContext, addresses: ParsedStoreAddress[]) {
  const items: StoreAddressImportPreviewItem[] = [];
  for (const { address } of groupStoreAddressImports(addresses)) {
    const existing = await findStoreAddressRow(database, address.storeNo, normalizeStoreName(address.storeName));
    const existingPreview = existing
      ? {
          storeNo: existing.storeNo,
          storeName: existing.storeName,
          receiver: existing.receiver,
          phone: existing.phone,
          address: existing.address,
        }
      : null;
    const action: StoreAddressImportPreviewItem["action"] = !existing
      ? "create"
      : storeAddressChanged(existing, address)
        ? "update"
        : "unchanged";
    items.push({
      action,
      storeNo: address.storeNo,
      storeName: address.storeName,
      receiver: address.receiver,
      phone: address.phone,
      address: address.address,
      sourceSheet: address.sourceSheet,
      sourceRow: address.sourceRow,
      existing: existingPreview,
    });
  }

  return {
    items,
    createCount: items.filter((item) => item.action === "create").length,
    updateCount: items.filter((item) => item.action === "update").length,
    unchangedCount: items.filter((item) => item.action === "unchanged").length,
  };
}

function groupStoreAddressImports(addresses: ParsedStoreAddress[]): StoreAddressImportGroup[] {
  const groups: StoreAddressImportGroup[] = [];
  const groupsByKey = new Map<string, StoreAddressImportGroup>();
  for (const address of addresses) {
    const keys = storeAddressImportKeys(address.storeNo, address.storeName);
    if (keys.length === 0) continue;
    const matchedGroups = [...new Set(keys.map((key) => groupsByKey.get(key)).filter((group): group is StoreAddressImportGroup => Boolean(group)))];
    const group = matchedGroups[0] ?? { address, rawAddresses: [] };
    if (matchedGroups.length > 1) {
      for (const duplicateGroup of matchedGroups.slice(1)) {
        mergeStoreAddressImportGroups(group, duplicateGroup);
        const duplicateIndex = groups.indexOf(duplicateGroup);
        if (duplicateIndex >= 0) groups.splice(duplicateIndex, 1);
      }
    }

    if (group.rawAddresses.length > 0) {
      group.address = mergeStoreAddressImportAddress(group.address, address);
      group.rawAddresses.push(address);
    } else {
      group.rawAddresses.push(address);
      groups.push(group);
    }

    for (const groupAddress of group.rawAddresses) {
      for (const key of storeAddressImportKeys(groupAddress.storeNo, groupAddress.storeName)) {
        groupsByKey.set(key, group);
      }
    }
  }
  return groups;
}

function mergeStoreAddressImportGroups(target: StoreAddressImportGroup, source: StoreAddressImportGroup) {
  for (const address of source.rawAddresses) {
    target.address = mergeStoreAddressImportAddress(target.address, address);
    target.rawAddresses.push(address);
  }
}

function mergeStoreAddressImportAddress(current: ParsedStoreAddress, next: ParsedStoreAddress): ParsedStoreAddress {
  if (next.sourceSheetIndex < current.sourceSheetIndex || (next.sourceSheetIndex === current.sourceSheetIndex && next.sourceOrder > current.sourceOrder)) {
    return fillMissingStoreAddressFields(next, current);
  }
  return fillMissingStoreAddressFields(current, next);
}

function fillMissingStoreAddressFields(primary: ParsedStoreAddress, fallback: ParsedStoreAddress): ParsedStoreAddress {
  return {
    ...primary,
    storeNo: primary.storeNo || fallback.storeNo,
    storeName: primary.storeName || fallback.storeName,
    receiver: primary.receiver || fallback.receiver,
    phone: primary.phone || fallback.phone,
    address: primary.address || fallback.address,
  };
}

function storeAddressImportKeys(storeNo: string, storeName: string) {
  const keys: string[] = [];
  const normalizedStoreNo = normalizeStoreNo(storeNo);
  if (normalizedStoreNo) keys.push(`no:${normalizedStoreNo}`);
  const normalizedStoreName = normalizeStoreName(storeName);
  if (normalizedStoreName) keys.push(`name:${normalizedStoreName}`);
  return keys;
}

function storeAddressChanged(existing: StoreAddressRow, address: ParsedStoreAddress) {
  return (
    existing.storeNo !== address.storeNo
    || existing.storeName !== address.storeName
    || existing.receiver !== address.receiver
    || existing.phone !== address.phone
    || existing.address !== address.address
  );
}

function parseStoreAddressWorkbook(workbook: XLSX.WorkBook): { addresses: ParsedStoreAddress[]; sheetCount: number; skippedRowCount: number } {
  const addresses: ParsedStoreAddress[] = [];
  const parsedSheetNames = new Set<string>();
  let skippedRowCount = 0;

  let sourceOrder = 0;
  for (let sheetIndex = 0; sheetIndex < workbook.SheetNames.length; sheetIndex += 1) {
    const sheetName = workbook.SheetNames[sheetIndex];
    const rows = XLSX.utils.sheet_to_json<Array<string | number>>(workbook.Sheets[sheetName], { header: 1, defval: "" });
    if (rows.length < 2) continue;
    const headerRowIndex = findAddressHeaderRow(rows, sheetName);
    if (headerRowIndex < 0) {
      skippedRowCount += rows.filter((row) => row.some((value) => cellText(value))).length;
      continue;
    }

    const headerLabels = buildRawHeaderLabels(rows[headerRowIndex]);
    const headers = rows[headerRowIndex].map((value) => normalizeHeader(value));
    const storeNoIndex = findHeaderIndex(headers, ["门店编码/群组", "门店编号", "门店编码", "群组"]);
    let storeNameIndex = findHeaderIndex(headers, ["门店名称", "门店名"]);
    let addressIndex = findHeaderIndex(headers, ["门店地址", "地址", "收货地址"]);
    const receiverIndex = findHeaderIndex(headers, ["收货人", "经理", "非食经理", "收件人"]);
    const phoneIndex = findHeaderIndex(headers, ["电话", "联系方式", "联系电话", "手机", "收货电话"]);

    if (storeNameIndex < 0 && sheetName.includes("兼职")) storeNameIndex = 2;
    if (addressIndex < 0 && sheetName.includes("兼职")) addressIndex = 3;
    if (storeNameIndex < 0 || addressIndex < 0) continue;

    for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (!row.some((value) => cellText(value))) continue;
      const address = cellText(row[addressIndex]);
      const storeName = storeNameIndex >= 0 ? cellText(row[storeNameIndex]) : "";
      const storeNo = storeNoIndex >= 0 ? cellText(row[storeNoIndex]) : "";
      if (!address || (!storeName && !storeNo)) {
        skippedRowCount += 1;
        continue;
      }
      addresses.push({
        storeNo,
        storeName,
        receiver: receiverIndex >= 0 ? cellText(row[receiverIndex]) : "",
        phone: phoneIndex >= 0 ? cellText(row[phoneIndex]) : "",
        address,
        note: "",
        sourceSheet: sheetName,
        sourceSheetIndex: sheetIndex,
        sourceOrder: sourceOrder += 1,
        sourceRow: rowIndex + 1,
        rawFields: rawFieldsForRow(headerLabels, row),
      });
      parsedSheetNames.add(sheetName);
    }
  }

  return { addresses, sheetCount: parsedSheetNames.size, skippedRowCount };
}

function findAddressHeaderRow(rows: Array<Array<string | number>>, sheetName: string) {
  const maxRows = Math.min(rows.length, 10);
  for (let index = 0; index < maxRows; index += 1) {
    const headers = rows[index].map((value) => normalizeHeader(value));
    const hasAddress = findHeaderIndex(headers, ["门店地址", "地址", "收货地址"]) >= 0 || (sheetName.includes("兼职") && headers.includes("地址"));
    const hasStore = findHeaderIndex(headers, ["门店名称", "门店名", "门店编码/群组", "门店编号", "门店编码"]) >= 0 || sheetName.includes("兼职");
    if (hasAddress && hasStore) return index;
  }
  return -1;
}

function buildRawHeaderLabels(row: Array<string | number>) {
  const seen = new Map<string, number>();
  return row.map((value, index) => {
    const label = cellText(value) || `列${index + 1}`;
    const count = seen.get(label) ?? 0;
    seen.set(label, count + 1);
    return count === 0 ? label : `${label}_${count + 1}`;
  });
}

function rawFieldsForRow(headers: string[], row: Array<string | number>) {
  const rawFields: Record<string, string> = {};
  const maxLength = Math.max(headers.length, row.length);
  for (let index = 0; index < maxLength; index += 1) {
    const key = headers[index] ?? `列${index + 1}`;
    rawFields[key] = cellText(row[index]);
  }
  return rawFields;
}

function mergeStoreAddressRawJson(existingRawJson: string | undefined | null, address: ParsedStoreAddress) {
  const record = {
    sourceSheet: address.sourceSheet,
    sourceRow: address.sourceRow,
    storeNo: address.storeNo,
    storeName: address.storeName,
    receiver: address.receiver,
    phone: address.phone,
    address: address.address,
    rawFields: address.rawFields,
  };
  const existing = parseStoreAddressRawJson(existingRawJson);
  const records = [
    ...existing.records.filter((item) => !(item.sourceSheet === record.sourceSheet && item.sourceRow === record.sourceRow)),
    record,
  ];
  return JSON.stringify({ records });
}

function parseStoreAddressRawJson(value: string | undefined | null): { records: Array<{ sourceSheet: string; sourceRow: number }> } {
  if (!value) return { records: [] };
  try {
    const parsed = JSON.parse(value) as { records?: Array<{ sourceSheet?: unknown; sourceRow?: unknown }> };
    return {
      records: Array.isArray(parsed.records)
        ? parsed.records.map((item) => ({ ...item, sourceSheet: cellText(item.sourceSheet), sourceRow: Number(item.sourceRow) || 0 }))
        : [],
    };
  } catch {
    return { records: [] };
  }
}

function emptyMakeOrderAddressIndex(): MakeOrderAddressIndex {
  return { byStoreNo: new Map(), byStoreName: new Map() };
}

function addMakeOrderAddress(index: MakeOrderAddressIndex, address: MakeOrderAddress, overwrite = false) {
  if (address.storeNo) {
    const key = normalizeStoreNo(address.storeNo);
    if (key && (overwrite || !index.byStoreNo.has(key))) index.byStoreNo.set(key, address);
  }
  if (address.storeName) {
    const key = normalizeStoreName(address.storeName);
    if (key && (overwrite || !index.byStoreName.has(key))) index.byStoreName.set(key, address);
  }
}

function findMakeOrderAddress(index: MakeOrderAddressIndex, line: ReviewLineDto) {
  const byNo = index.byStoreNo.get(normalizeStoreNo(line.storeNo));
  if (byNo) return byNo;
  return index.byStoreName.get(normalizeStoreName(line.storeName));
}

function isCompleteMakeOrderAddress(address: MakeOrderAddress | undefined) {
  return Boolean(address?.receiver.trim() && address.phone.trim() && address.address.trim());
}

function findHeaderIndex(headers: string[], candidates: string[]) {
  return headers.findIndex((header) => candidates.includes(header));
}

function normalizeHeader(value: unknown) {
  return cellText(value).replace(/\s+/g, "");
}

function normalizeStoreNo(value: unknown) {
  return cellText(value).toUpperCase();
}

function normalizeStoreName(value: unknown) {
  return cellText(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）]/g, "")
    .replace(/精品超市/g, "")
    .replace(/超市/g, "")
    .replace(/店$/g, "");
}

function cellText(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function sheetNameFor(type: ExportDto["type"]) {
  if (type === "confirmed") return "confirmed";
  if (type === "wdt_import") return WDT_IMPORT_SHEET_NAME;
  return "review";
}
