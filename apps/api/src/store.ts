import type {
  AuthUserDto,
  BatchSummary,
  BulkApproveResponseDto,
  CreateBatchRequest,
  CreateExportRequest,
  ConfirmProductMappingRequest,
  ExportDto,
  LoginRequest,
  LoginResponse,
  MeResponse,
  ProductMatchCandidateDto,
  ProductMappingDto,
  RunRealReviewRequest,
  ReviewDecisionDto,
  ReviewLineDto,
  SubmitReviewResponseDto,
  CreateWdtGoodsSyncRunRequest,
  UpdateWarehouseUsageSettingsRequest,
  UpdateReviewLinePriorityRequest,
  UpdateProductMappingStatusRequest,
  WarehouseUsageSettingsDto,
  WdtGoodsSpecSearchResultDto,
  WdtGoodsSyncRunDto,
} from "@jy-trade/shared";
import { buildMockReview } from "@jy-trade/workflow";
import { and, desc, eq, like, or } from "drizzle-orm";
import * as XLSX from "xlsx";
import { randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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
  const projectRoot = options.projectRoot ?? resolve(process.cwd(), "../..");
  const exportsDir = resolve(projectRoot, "outputs/exports");
  const wdtClients = options.wdtGoodsClient && options.stockClient ? undefined : createWdtReadClientsFromEnv();
  const wdtGoodsClient = options.wdtGoodsClient ?? wdtClients?.goodsClient;
  const stockClient = options.stockClient ?? wdtClients?.stockClient;
  const bootstrapUsername = process.env.JY_TRADE_BOOTSTRAP_USERNAME ?? "admin";
  const bootstrapPassword = process.env.JY_TRADE_BOOTSTRAP_PASSWORD ?? "admin123";
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
      const filePath = resolve(projectRoot, "outputs/exports", fileName);
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
        await mkdir(resolve(projectRoot, "outputs/exports"), { recursive: true });
        const buffer = renderExportWorkbook(batch, type, lines);
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
            .limit(50)
        : await base.orderBy(desc(productMatchCandidates.createdAt)).limit(50);
      return rows.map(toProductMatchCandidateDto);
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
    externalBarcode: input.orderLine.externalBarcode,
    externalGoodsName: input.orderLine.externalGoodsName,
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
      externalBarcode: line.externalBarcode,
      externalGoodsName: line.externalGoodsName,
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
  if (candidates.length === 0) return;
  await database.db.insert(productMatchCandidates).values(
    candidates.map((candidate) => ({
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

function toReviewLineDto(line: ReviewLineRow, decision?: ReviewDecisionRow): ReviewLineDto {
  return {
    id: line.id,
    batchId: line.batchId,
    orderNoticeNo: line.orderNoticeNo,
    excelRow: line.excelRow,
    storeNo: line.storeNo,
    storeName: line.storeName,
    uploadTime: line.uploadTime,
    externalBarcode: line.externalBarcode,
    externalGoodsName: line.externalGoodsName,
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

async function prepareDatabase(database: DatabaseContext, bootstrapUsers: Array<{ username: string; password: string; role: AuthUserDto["role"] }>) {
  await database.ready;
  await ensureReviewLinePriorityColumns(database);
  await ensureWarehouseUsageSettings(database);
  await ensureBootstrapUsers(database, bootstrapUsers);
}

async function ensureReviewLinePriorityColumns(database: DatabaseContext) {
  const columns = await getTableColumns(database, "review_lines");
  if (columns.length === 0) return;
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
  return `${base}-${type}-${stamp}.xlsx`;
}

function renderExportWorkbook(batch: BatchRow, type: ExportDto["type"], lines: ReviewLineDto[]) {
  const worksheetRows = [
    ["batchId", batch.id],
    ["batchFileName", batch.fileName],
    ["exportType", type],
    ["exportAt", new Date().toISOString()],
    [],
    ["storeName", "orderNoticeNo", "externalBarcode", "externalGoodsName", "status", "decision", "approvedShipQty", "reason"],
    ...lines.map((line) => [
      line.storeName,
      line.orderNoticeNo,
      line.externalBarcode,
      line.externalGoodsName,
      line.status,
      line.decision,
      String(line.approvedShipQty),
      line.reason,
    ]),
  ];

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(worksheetRows);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetNameFor(type));
  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
}

function sheetNameFor(type: ExportDto["type"]) {
  if (type === "confirmed") return "confirmed";
  if (type === "wdt_import") return "wdt_import";
  return "review";
}
