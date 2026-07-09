import type {
  AuthUserDto,
  BatchSummary,
  BulkApproveResponseDto,
  CreateBatchRequest,
  CreateExportRequest,
  ConfirmProductMappingRequest,
  ExportDto,
  ExternalProductComponentDto,
  ExternalProductDto,
  ExternalProductImportPreviewItem,
  ExternalProductImportComponentPreview,
  ImportExternalProductsRequest,
  ImportExternalProductsPreviewResponse,
  ImportExternalProductsResponse,
  ImportConfirmedOrderRequest,
  ImportConfirmedOrderResponse,
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
  UpdateBatchStoreFieldsRequest,
  UpdateBatchStoreFieldsResponse,
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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { createDatabaseContext, type DatabaseContext } from "./db/client.js";
import {
  auditLogs,
  batches,
  externalProductComponents,
  externalProducts,
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
  wdtSuiteComponents,
  wdtSuites,
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
  type LocalSuiteCandidate,
  type ProductMappingCandidate,
  type ProductMatchDecision,
} from "@jy-trade/workflow";
import { getWdtAvailableSendStock, type WdtStockResponse, type WdtStockRow } from "../../../backend/src/integrations/wdtClient.js";

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
type WdtSuiteRow = typeof wdtSuites.$inferSelect;
type WdtSuiteComponentRow = typeof wdtSuiteComponents.$inferSelect;
type ProductMappingRow = typeof productMappings.$inferSelect;
type ProductMatchCandidateRow = typeof productMatchCandidates.$inferSelect;
type ExternalProductRow = typeof externalProducts.$inferSelect;
type ExternalProductComponentRow = typeof externalProductComponents.$inferSelect;

export interface StockLookupClient {
  queryStock(specNo: string): Promise<WdtStockResponse>;
  queryStocks?(specNos: string[]): Promise<WdtStockResponse>;
}

interface WarehouseStockSummary {
  mainAvailableStock: number;
  nearExpiryAvailableStock: number;
  defectAvailableStock: number;
  otherAvailableStock: number;
  usableAvailableStock: number;
  warehouseBreakdown: string;
}

const WDT_STOCK_BATCH_SIZE = 40;
const WDT_STOCK_MIN_INTERVAL_MS = process.env.NODE_ENV === "test" ? 0 : 1100;
const WDT_STOCK_RETRY_DELAYS_MS = process.env.NODE_ENV === "test" ? [0] : [1500];

let wdtStockRequestQueue: Promise<void> = Promise.resolve();
let lastWdtStockRequestStartedAt = 0;

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
        sourceType: "order",
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
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;
      if (batch.sourceType === "confirmed_order") {
        throw new StoreValidationError("确定单批次不支持普通订单初审，请使用确定单重新校验");
      }
      if (!stockClient) {
        throw new StoreValidationError("WDT stock client is not configured");
      }

      const cacheStatus = await getGoodsCacheStatus(database, Boolean(input.allowStaleCache));
      assertReviewGoodsCacheUsable(cacheStatus);

      const goodsSpecs = (await database.db.select().from(wdtGoodsSpecs)).map(toLocalGoodsSpecCandidate);
      const suites = await loadLocalSuiteCandidates(database);
      const mappings = (await database.db.select().from(productMappings).where(eq(productMappings.status, "confirmed"))).map(toProductMappingCandidate);
      const warehouseSettings = toWarehouseUsageSettingsDto(await getWarehouseUsageSettingsRow(database));
      const vipStoreIndex = await loadVipStoreIndex(database);
      const result = await buildRealReview(stockClient, {
        batchId,
        orderFile: batch.filePath,
        goodsSpecs,
        suites,
        mappings,
        warehouseSettings,
        vipStoreIndex,
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

    async importConfirmedOrder(input: ImportConfirmedOrderRequest, actor?: AuthUserDto): Promise<ImportConfirmedOrderResponse> {
      await ready;
      const extension = input.fileName.split(".").at(-1)?.toLowerCase() ?? "";
      if (!["xls", "xlsx"].includes(extension)) {
        throw new StoreValidationError("只支持导入 Excel 确定单文件");
      }

      const fileBuffer = Buffer.from(input.contentBase64, "base64");
      const parsed = parseConfirmedOrderWorkbook(fileBuffer);
      if (parsed.lines.length === 0) {
        throw new StoreValidationError("确定单中没有可导入的发货明细");
      }

      await mkdir(configuredUploadDir, { recursive: true });
      const storedName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.${extension}`;
      const filePath = resolve(configuredUploadDir, storedName);
      await writeFile(filePath, fileBuffer);

      const now = new Date().toISOString();
      const goodsSpecs = (await database.db.select().from(wdtGoodsSpecs)).map(toLocalGoodsSpecCandidate);
      const suites = await loadLocalSuiteCandidates(database);
      const mappings = (await database.db.select().from(productMappings).where(eq(productMappings.status, "confirmed"))).map(toProductMappingCandidate);
      const externalProductMatches = await loadExternalProductMatchIndex(database);
      const warehouseSettings = toWarehouseUsageSettingsDto(await getWarehouseUsageSettingsRow(database));
      const buildResult = await buildConfirmedOrderReview({
        batchId: `batch-${randomUUID()}`,
        lines: parsed.lines,
        goodsSpecs,
        suites,
        mappings,
        externalProductMatches,
        stockClient,
        warehouseSettings,
      });
      const batch: BatchRow = {
        id: buildResult.batchId,
        filePath,
        fileName: input.fileName.split(/[\\/]/).at(-1) ?? input.fileName,
        mode: "production_api",
        sourceType: "confirmed_order",
        status: "reviewed",
        orderLineCount: parsed.lines.length,
        uniqueBarcodeCount: new Set(parsed.lines.map((line) => line.externalBarcode).filter(Boolean)).size,
        matchedBarcodeCount: new Set(buildResult.reviewLines.filter((line) => line.matchStatus === "matched").map((line) => line.externalBarcode).filter(Boolean)).size,
        createdAt: now,
        updatedAt: now,
      };

      await database.db.insert(batches).values(batch);
      await replaceBatchReviewLines(database, batch.id, buildResult.reviewLines, now);
      await replaceProductMatchCandidates(database, batch.id, buildResult.candidateRows, now);
      await insertAuditLog(database, actor?.id ?? null, "confirmed_order.import", "batch", batch.id, {
        fileName: batch.fileName,
        sheetName: parsed.sheetName,
        parsedRowCount: parsed.lines.length,
        matchedRowCount: buildResult.reviewLines.filter((line) => line.matchStatus === "matched").length,
        unmatchedRowCount: buildResult.reviewLines.filter((line) => line.matchStatus !== "matched").length,
        skippedRowCount: parsed.skippedRowCount,
        stockQueriedCount: buildResult.stockQueriedCount,
      });

      return {
        batch: toBatchSummary(batch),
        fileName: batch.fileName,
        sheetName: parsed.sheetName,
        parsedRowCount: parsed.lines.length,
        matchedRowCount: buildResult.reviewLines.filter((line) => line.matchStatus === "matched").length,
        unmatchedRowCount: buildResult.reviewLines.filter((line) => line.matchStatus !== "matched").length,
        skippedRowCount: parsed.skippedRowCount,
      };
    },

    async rebuildConfirmedOrder(batchId: string, actor?: AuthUserDto): Promise<ImportConfirmedOrderResponse | undefined> {
      await ready;
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;
      if (batch.sourceType !== "confirmed_order") {
        throw new StoreValidationError("当前批次不是确定单批次，不能使用确定单重新校验");
      }

      const parsed = parseConfirmedOrderWorkbook(await readFile(batch.filePath));
      if (parsed.lines.length === 0) {
        throw new StoreValidationError("确定单中没有可导入的发货明细");
      }

      const now = new Date().toISOString();
      const goodsSpecs = (await database.db.select().from(wdtGoodsSpecs)).map(toLocalGoodsSpecCandidate);
      const suites = await loadLocalSuiteCandidates(database);
      const mappings = (await database.db.select().from(productMappings).where(eq(productMappings.status, "confirmed"))).map(toProductMappingCandidate);
      const externalProductMatches = await loadExternalProductMatchIndex(database);
      const warehouseSettings = toWarehouseUsageSettingsDto(await getWarehouseUsageSettingsRow(database));
      const buildResult = await buildConfirmedOrderReview({
        batchId: batch.id,
        lines: parsed.lines,
        goodsSpecs,
        suites,
        mappings,
        externalProductMatches,
        stockClient,
        warehouseSettings,
      });
      const updatedBatch: BatchRow = {
        ...batch,
        status: "reviewed",
        orderLineCount: parsed.lines.length,
        uniqueBarcodeCount: new Set(parsed.lines.map((line) => line.externalBarcode).filter(Boolean)).size,
        matchedBarcodeCount: new Set(buildResult.reviewLines.filter((line) => line.matchStatus === "matched").map((line) => line.externalBarcode).filter(Boolean)).size,
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
        .where(eq(batches.id, batch.id));
      await replaceBatchReviewLines(database, batch.id, buildResult.reviewLines, now);
      await replaceProductMatchCandidates(database, batch.id, buildResult.candidateRows, now);
      await insertAuditLog(database, actor?.id ?? null, "confirmed_order.rebuild", "batch", batch.id, {
        fileName: batch.fileName,
        sheetName: parsed.sheetName,
        parsedRowCount: parsed.lines.length,
        matchedRowCount: buildResult.reviewLines.filter((line) => line.matchStatus === "matched").length,
        unmatchedRowCount: buildResult.reviewLines.filter((line) => line.matchStatus !== "matched").length,
        skippedRowCount: parsed.skippedRowCount,
        stockQueriedCount: buildResult.stockQueriedCount,
      });

      return {
        batch: toBatchSummary(updatedBatch),
        fileName: batch.fileName,
        sheetName: parsed.sheetName,
        parsedRowCount: parsed.lines.length,
        matchedRowCount: buildResult.reviewLines.filter((line) => line.matchStatus === "matched").length,
        unmatchedRowCount: buildResult.reviewLines.filter((line) => line.matchStatus !== "matched").length,
        skippedRowCount: parsed.skippedRowCount,
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

    async updateBatchStoreFields(batchId: string, input: UpdateBatchStoreFieldsRequest, actor?: AuthUserDto): Promise<UpdateBatchStoreFieldsResponse | undefined> {
      await ready;
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;
      const nextStoreName = input.nextStoreName.trim();
      const nextStoreNo = input.nextStoreNo.trim();
      if (!nextStoreName) {
        throw new StoreValidationError("收货地名称不能为空");
      }

      const currentKey = makeOrderStoreKey({ storeNo: input.currentStoreNo.trim(), storeName: input.currentStoreName.trim() });
      if (currentKey === "name:") {
        throw new StoreValidationError("缺少要修正的原收货地字段");
      }

      const rows = await database.db.select().from(reviewLines).where(eq(reviewLines.batchId, batchId));
      const matchedRows = rows.filter((line) => makeOrderStoreKey({ storeNo: line.storeNo, storeName: line.storeName }) === currentKey);
      if (matchedRows.length === 0) {
        throw new StoreValidationError("当前批次没有匹配的收货地字段可修正");
      }

      for (const line of matchedRows) {
        await database.db
          .update(reviewLines)
          .set({ storeNo: nextStoreNo, storeName: nextStoreName })
          .where(eq(reviewLines.id, line.id));
      }

      const now = new Date().toISOString();
      const updatedBatch: BatchRow = { ...batch, updatedAt: now };
      await database.db.update(batches).set({ updatedAt: now }).where(eq(batches.id, batchId));
      const lines = await getReviewLineDtos(database, batchId);
      const addressIndex = await loadMakeOrderAddressIndex(database);
      const makeOrderReadiness = buildMakeOrderReadiness(batchId, lines, addressIndex);
      await insertAuditLog(database, actor?.id ?? null, "batch.update_store_fields", "batch", batchId, {
        currentStoreNo: input.currentStoreNo,
        currentStoreName: input.currentStoreName,
        nextStoreNo,
        nextStoreName,
        updatedLineCount: matchedRows.length,
      });

      return {
        batch: toBatchSummary(updatedBatch),
        updatedLineCount: matchedRows.length,
        makeOrderReadiness,
      };
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
        isVip: input.isVip ? 1 : 0,
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
          isVip: existing?.isVip ?? 0,
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

    async listExternalProducts(query = ""): Promise<ExternalProductDto[]> {
      await ready;
      const trimmed = query.trim();
      const base = database.db.select().from(externalProducts);
      const rows = trimmed
        ? await base
            .where(
              or(
                like(externalProducts.externalBarcode, `%${trimmed}%`),
                like(externalProducts.externalGoodsCode, `%${trimmed}%`),
                like(externalProducts.externalGoodsName, `%${trimmed}%`),
              ),
            )
            .orderBy(desc(externalProducts.updatedAt))
            .limit(50)
        : await base.orderBy(desc(externalProducts.updatedAt)).limit(50);
      return toExternalProductDtos(database, rows);
    },

    async previewExternalProductImport(input: ImportExternalProductsRequest): Promise<ImportExternalProductsPreviewResponse> {
      await ready;
      const parsed = parseExternalProductImportInput(input);
      const previewItems = await buildExternalProductImportPreview(database, parsed.products);
      return summarizeExternalProductPreview(input.fileName, parsed, previewItems);
    },

    async importExternalProducts(input: ImportExternalProductsRequest, actor?: AuthUserDto): Promise<ImportExternalProductsResponse> {
      await ready;
      const parsed = parseExternalProductImportInput(input);
      const previewItems = await buildExternalProductImportPreview(database, parsed.products);
      const now = new Date().toISOString();
      let importedProductCount = 0;
      let importedComponentCount = 0;

      for (const item of previewItems) {
        const existing = await findExternalProductRow(database, item);
        const productId = existing?.id ?? `external-product-${randomUUID()}`;
        const productRow: ExternalProductRow = {
          id: productId,
          type: item.type,
          externalBarcode: item.externalBarcode,
          externalGoodsCode: item.externalGoodsCode,
          externalGoodsName: item.externalGoodsName,
          status: item.status,
          sourceFileName: input.fileName,
          sourceSheet: item.sourceSheet,
          sourceRow: item.sourceRow,
          importedAt: now,
          rawJson: item.rawJson,
          note: item.note,
          updatedByUserId: actor?.id ?? null,
          updatedByUsername: actor?.username ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        if (existing) {
          await database.db.update(externalProducts).set(productRow).where(eq(externalProducts.id, existing.id));
        } else {
          await database.db.insert(externalProducts).values(productRow);
        }

        await database.db.delete(externalProductComponents).where(eq(externalProductComponents.externalProductId, productId));
        if (item.components.length > 0) {
          await database.db.insert(externalProductComponents).values(
            item.components.map((component, index) => ({
              id: `external-product-component-${randomUUID()}`,
              externalProductId: productId,
              sortOrder: index + 1,
              role: component.role,
              componentBarcode: component.componentBarcode,
              componentGoodsCode: component.componentGoodsCode,
              componentName: component.componentName,
              componentSpec: component.componentSpec,
              quantityMultiplier: component.quantityMultiplier,
              wdtSpecNo: component.wdtSpecNo,
              wdtGoodsNo: component.wdtGoodsNo,
              wdtGoodsName: component.wdtGoodsName,
              wdtSpecName: component.wdtSpecName,
              wdtBarcode: component.wdtBarcode,
              matchStatus: component.matchStatus,
              matchMessage: component.matchMessage,
              note: component.note,
              sourceSheet: component.sourceSheet,
              sourceRow: component.sourceRow,
              rawJson: component.rawJson,
              createdAt: now,
              updatedAt: now,
            })),
          );
        }
        importedProductCount += 1;
        importedComponentCount += item.components.length;
      }

      await insertAuditLog(database, actor?.id ?? null, "external_product.import", "external_product", input.fileName, {
        fileName: input.fileName,
        sheetCount: parsed.sheetCount,
        parsedProductCount: parsed.products.length,
        parsedComponentCount: parsed.products.reduce((total, product) => total + product.components.length, 0),
        importedProductCount,
        importedComponentCount,
        skippedRowCount: parsed.skippedRowCount,
        needsReviewCount: previewItems.filter((item) => item.status === "needs_review").length,
      });

      return {
        fileName: input.fileName,
        sheetCount: parsed.sheetCount,
        parsedProductCount: parsed.products.length,
        parsedComponentCount: parsed.products.reduce((total, product) => total + product.components.length, 0),
        importedProductCount,
        importedComponentCount,
        skippedRowCount: parsed.skippedRowCount,
        needsReviewCount: previewItems.filter((item) => item.status === "needs_review").length,
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
        const buffer = renderExportWorkbook(batch, type, lines, addressIndex, actor);
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
      return attachWdtGoodsSpecSearchStock(rows.map(toWdtGoodsSpecSearchResultDto), database, stockClient);
    },

    async confirmProductMapping(input: ConfirmProductMappingRequest, actor?: AuthUserDto): Promise<ProductMappingDto> {
      await ready;
      const [spec] = await database.db.select().from(wdtGoodsSpecs).where(eq(wdtGoodsSpecs.specNo, input.wdtSpecNo)).limit(1);
      if (!spec) {
        throw new StoreValidationError(`WDT goods spec not found: ${input.wdtSpecNo}`);
      }
      if (!input.externalBarcode && !input.externalGoodsCode) {
        throw new StoreValidationError("External barcode or product code is required for persistent product mapping");
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
      const liveCandidates = trimmed ? await buildLiveProductMatchCandidates(database, trimmed) : [];
      const candidates = dedupeProductMatchCandidates(
        [...rows.map(toProductMatchCandidateDto), ...liveCandidates]
          .filter((candidate) => !confirmedMappings.some((mapping) => productCandidateMatchesMapping(candidate, mapping))),
      )
        .sort(compareProductMatchCandidates)
        .slice(0, 50);
      return (await attachProductCandidateStock(candidates, database, stockClient)).sort(compareProductMatchCandidates);
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

    async deleteProductMapping(mappingId: string, actor?: AuthUserDto): Promise<{ mappingId: string; deleted: true } | undefined> {
      await ready;
      const [existing] = await database.db.select().from(productMappings).where(eq(productMappings.id, mappingId)).limit(1);
      if (!existing) return undefined;
      await database.db.delete(productMappings).where(eq(productMappings.id, mappingId));
      await insertAuditLog(database, actor?.id ?? null, "product_mapping.delete", "product_mapping", mappingId, existing);
      return { mappingId, deleted: true };
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
  for (const nameKey of legacyCompatibleStoreNameKeys(normalizedStoreName)) {
    const [byName] = await database.db
      .select()
      .from(storeAddresses)
      .where(eq(storeAddresses.normalizedStoreName, nameKey))
      .limit(1);
    if (byName) return byName;
  }
  return undefined;
}

interface RealReviewBuildOptions {
  batchId: string;
  orderFile: string;
  goodsSpecs: LocalGoodsSpecCandidate[];
  suites: LocalSuiteCandidate[];
  mappings: ProductMappingCandidate[];
  warehouseSettings: WarehouseUsageSettingsDto;
  vipStoreIndex: VipStoreIndex;
}

interface VipStoreIndex {
  byStoreNo: Set<string>;
  byStoreName: Set<string>;
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

interface ParsedConfirmedOrderLine {
  sourceFile: string;
  sourceSheet: string;
  excelRow: number;
  orderApprovalNo: string;
  orderNoticeNo: string;
  storeNo: string;
  storeName: string;
  salesperson: string;
  deadlineDate: string;
  externalGoodsCode: string;
  externalBarcode: string;
  externalGoodsName: string;
  spec: string;
  orderQty: number;
  shipQty: number;
  contractPrice: string;
  raw: Record<string, string>;
}

interface ConfirmedOrderParseResult {
  sheetName: string;
  lines: ParsedConfirmedOrderLine[];
  skippedRowCount: number;
}

interface ExternalProductMatchCandidate {
  type: ExternalProductDto["type"];
  externalBarcode: string;
  externalGoodsCode: string;
  externalGoodsName: string;
  wdtSpecNo: string;
  wdtGoodsNo: string;
  wdtGoodsName: string;
  wdtSpecName: string;
  wdtBarcode: string;
}

interface ConfirmedOrderReviewBuildResult {
  batchId: string;
  reviewLines: ReviewLineDto[];
  candidateRows: RealReviewCandidateRow[];
  stockQueriedCount: number;
}

function parseConfirmedOrderWorkbook(buffer: Buffer): ConfirmedOrderParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = workbook.SheetNames.includes("确定单") ? "确定单" : workbook.SheetNames[0];
  if (!sheetName) throw new StoreValidationError("确定单文件没有可读取的 Sheet");
  const rows = XLSX.utils.sheet_to_json<Array<string | number>>(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false });
  if (rows.length < 2) throw new StoreValidationError("确定单文件没有明细行");

  const headers = rows[0].map((value) => normalizeHeader(value));
  const rawHeaders = buildRawHeaderLabels(rows[0]);
  const indexes = {
    orderApprovalNo: findHeaderIndex(headers, ["审批单号", "订货审批单号"]),
    orderNoticeNo: findHeaderIndex(headers, ["通知单号", "订货通知单号"]),
    storeNo: findHeaderIndex(headers, ["收货地编码", "门店", "门店编码"]),
    storeName: findHeaderIndex(headers, ["收货地名称", "门店名称"]),
    salesperson: findHeaderIndex(headers, ["业务员"]),
    deadlineDate: findHeaderIndex(headers, ["截止日期"]),
    externalGoodsCode: findHeaderIndex(headers, ["商品编码"]),
    externalBarcode: findHeaderIndex(headers, ["商品条码"]),
    externalGoodsName: findHeaderIndex(headers, ["商品名称"]),
    spec: findHeaderIndex(headers, ["规格"]),
    orderQty: findHeaderIndex(headers, ["订货数量", "订货数"]),
    shipQty: findHeaderIndex(headers, ["实际发货数量", "发货数量"]),
    contractPrice: findHeaderIndex(headers, ["合同进价", "含税合同进价"]),
  };
  const missing = [
    ["通知单号", indexes.orderNoticeNo],
    ["收货地名称", indexes.storeName],
    ["商品编码", indexes.externalGoodsCode],
    ["商品条码", indexes.externalBarcode],
    ["商品名称", indexes.externalGoodsName],
    ["实际发货数量", indexes.shipQty],
  ].filter(([, index]) => Number(index) < 0).map(([name]) => name);
  if (missing.length > 0) {
    throw new StoreValidationError(`确定单缺少必要字段：${missing.join("、")}`);
  }

  const lines: ParsedConfirmedOrderLine[] = [];
  let skippedRowCount = 0;
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row.some((value) => cellText(value))) continue;
    const shipQty = parseNumberCell(row[indexes.shipQty]);
    if (!Number.isFinite(shipQty) || shipQty <= 0) {
      skippedRowCount += 1;
      continue;
    }
    const orderNoticeNo = cellText(row[indexes.orderNoticeNo]);
    const externalBarcode = cellText(row[indexes.externalBarcode]);
    const externalGoodsCode = cellText(row[indexes.externalGoodsCode]);
    const externalGoodsName = cellText(row[indexes.externalGoodsName]);
    const storeName = cellText(row[indexes.storeName]);
    if (!orderNoticeNo || (!externalBarcode && !externalGoodsCode && !externalGoodsName) || !storeName) {
      skippedRowCount += 1;
      continue;
    }
    lines.push({
      sourceFile: "",
      sourceSheet: sheetName,
      excelRow: rowIndex + 1,
      orderApprovalNo: indexes.orderApprovalNo >= 0 ? cellText(row[indexes.orderApprovalNo]) : "",
      orderNoticeNo,
      storeNo: indexes.storeNo >= 0 ? cellText(row[indexes.storeNo]) : "",
      storeName,
      salesperson: indexes.salesperson >= 0 ? cellText(row[indexes.salesperson]) : "",
      deadlineDate: indexes.deadlineDate >= 0 ? cellText(row[indexes.deadlineDate]) : "",
      externalGoodsCode,
      externalBarcode,
      externalGoodsName,
      spec: indexes.spec >= 0 ? cellText(row[indexes.spec]) : "",
      orderQty: indexes.orderQty >= 0 ? parseNumberCell(row[indexes.orderQty]) : shipQty,
      shipQty,
      contractPrice: indexes.contractPrice >= 0 ? cellText(row[indexes.contractPrice]) : "",
      raw: rawFieldsForRow(rawHeaders, row),
    });
  }

  return { sheetName, lines, skippedRowCount };
}

async function buildConfirmedOrderReview(options: {
  batchId: string;
  lines: ParsedConfirmedOrderLine[];
  goodsSpecs: LocalGoodsSpecCandidate[];
  suites: LocalSuiteCandidate[];
  mappings: ProductMappingCandidate[];
  externalProductMatches: ExternalProductMatchCandidate[];
  stockClient?: StockLookupClient;
  warehouseSettings: WarehouseUsageSettingsDto;
}): Promise<ConfirmedOrderReviewBuildResult> {
  const reviewLines: ReviewLineDto[] = [];
  const candidateRows: RealReviewCandidateRow[] = [];
  const matchedInputs = options.lines.map((line, index) => ({
    line,
    id: `${options.batchId}-line-${index + 1}`,
    decision: decideConfirmedOrderProductMatch(line, options),
  }));
  const specNos = matchedInputs.map((input) => input.decision.candidate?.specNo ?? "").filter(Boolean);
  const stockLookup = options.stockClient
    ? await queryWarehouseStockSummaries(specNos, options.stockClient, options.warehouseSettings)
    : { stockBySpecNo: new Map<string, WarehouseStockSummary>(), stockErrorsBySpecNo: new Map<string, StockLookupError>(), stockQueriedCount: 0 };
  const demandBySpecNo = new Map<string, number>();

  for (const input of matchedInputs) {
    const specNo = input.decision.status === "matched" ? input.decision.candidate?.specNo ?? "" : "";
    if (specNo) {
      demandBySpecNo.set(specNo, (demandBySpecNo.get(specNo) ?? 0) + input.line.shipQty);
    }
  }

  for (const { line, id, decision } of matchedInputs) {
    if (decision.status === "ambiguous") {
      candidateRows.push(...toRealReviewCandidateRows(id, confirmedLineToCandidateOrderLine(line), decision));
    }
    const matched = decision.status === "matched";
    const specNo = matched ? decision.candidate?.specNo ?? "" : "";
    const stock = specNo ? stockLookup.stockBySpecNo.get(specNo) : undefined;
    const stockError = specNo ? stockLookup.stockErrorsBySpecNo.get(specNo) : undefined;
    const demandedQty = specNo ? demandBySpecNo.get(specNo) ?? line.shipQty : line.shipQty;
    const suggestedShipQty = matched ? line.shipQty : 0;
    const status = confirmedOrderStatusFor(decision.status, demandedQty, stock);
    const systemMessage = confirmedOrderSystemMessageFor({ matched, status, demandedQty, stock, stockError });
    const reviewDecision: ReviewLineDto["decision"] = matched ? "ship" : "pending";
    reviewLines.push({
      id,
      batchId: options.batchId,
      orderNoticeNo: line.orderNoticeNo,
      excelRow: line.excelRow,
      storeNo: line.storeNo,
      storeName: line.storeName,
      uploadTime: "",
      orderApprovalNo: line.orderApprovalNo,
      readingStatus: "",
      deliveryMode: "",
      orderStatus: "",
      deliveryTarget: "",
      category: "",
      orderDate: "",
      deadlineDate: line.deadlineDate,
      salesperson: line.salesperson,
      maker: "",
      madeAt: "",
      sourceReviewer: "",
      externalGoodsCode: line.externalGoodsCode,
      externalBarcode: line.externalBarcode,
      externalGoodsName: line.externalGoodsName,
      originalSpec: line.spec,
      transportSpec: "",
      orderBoxQty: "",
      taxExcludedUnitPrice: "",
      contractPrice: line.contractPrice,
      taxIncludedUnitPrice: "",
      discountRate: "",
      shelfLifeDays: "",
      receivedQty: "",
      giftRate: "",
      td: "",
      da: "",
      pd: "",
      spd: "",
      rebate: "",
      orderRawJson: JSON.stringify(line.raw),
      goodsName: decision.candidate?.goodsName ?? "",
      specName: decision.candidate?.specName ?? "",
      wdtSpecNo: specNo,
      wdtMakeOrderCode: decision.candidate?.makeOrderCode ?? specNo,
      matchStatus: decision.status,
      matchMessage: [decision.message, systemMessage].filter(Boolean).join("；"),
      stockErrorDetail: stockError?.developerDetail ?? "",
      orderQty: line.orderQty,
      mainAvailableBefore: stock?.mainAvailableStock ?? 0,
      nearExpiryAvailableBefore: stock?.nearExpiryAvailableStock ?? 0,
      suggestedShipQty,
      status,
      decision: reviewDecision,
      approvedShipQty: matched ? line.shipQty : 0,
      reason: "",
      priority: false,
      priorityReason: "",
    });
  }

  return { batchId: options.batchId, reviewLines, candidateRows, stockQueriedCount: stockLookup.stockQueriedCount };
}

function confirmedOrderStatusFor(
  matchStatus: ReviewLineDto["matchStatus"],
  demandedQty: number,
  stock: WarehouseStockSummary | undefined,
): ReviewLineDto["status"] {
  if (matchStatus !== "matched") return "未匹配";
  if (!stock) return "库存充足";
  if (stock.usableAvailableStock >= demandedQty) return "库存充足";
  if (stock.usableAvailableStock > 0) return "部分满足";
  return "库存不足";
}

function confirmedOrderSystemMessageFor(options: {
  matched: boolean;
  status: ReviewLineDto["status"];
  demandedQty: number;
  stock: WarehouseStockSummary | undefined;
  stockError: StockLookupError | undefined;
}) {
  if (!options.matched) return "确定单导入时商品未匹配，需补充商品映射";
  if (options.stockError) return options.stockError.userMessage;
  if (!options.stock || options.status === "库存充足") return "";
  return `确定单库存可能不足：本批该商品需 ${options.demandedQty}，可发 ${options.stock.usableAvailableStock}。仅提示，不调整做单数量`;
}

function decideConfirmedOrderProductMatch(
  line: ParsedConfirmedOrderLine,
  sources: Pick<ConfirmedOrderReviewBuildResult, never> & {
    goodsSpecs: LocalGoodsSpecCandidate[];
    suites: LocalSuiteCandidate[];
    mappings: ProductMappingCandidate[];
    externalProductMatches: ExternalProductMatchCandidate[];
  },
): ProductMatchDecision {
  const input = {
    barcode: line.externalBarcode,
    goodsCode: line.externalGoodsCode,
    goodsName: line.externalGoodsName,
    specName: line.spec,
  };
  const direct = decideLocalProductMatch(input, { goodsSpecs: sources.goodsSpecs, suites: sources.suites, mappings: sources.mappings });
  if (direct.status === "matched") return direct;

  const external = findExternalProductMatch(line, sources.externalProductMatches);
  if (external) {
    return {
      status: "matched",
      candidate: {
        source: "suite",
        goodsNo: external.wdtGoodsNo,
        goodsName: external.wdtGoodsName || external.externalGoodsName,
        specNo: external.wdtSpecNo,
        specName: external.wdtSpecName,
        makeOrderCode: external.wdtSpecNo,
        barcodes: [external.wdtBarcode || external.externalBarcode].filter(Boolean),
        score: 105,
        basis: "code",
      },
      candidates: [],
      message: `Matched by confirmed external ${external.type}`,
    };
  }

  return direct;
}

function confirmedLineToCandidateOrderLine(line: ParsedConfirmedOrderLine) {
  return {
    externalBarcode: line.externalBarcode,
    externalGoodsName: line.externalGoodsName,
    externalGoodsCode: line.externalGoodsCode,
  } as ReturnType<typeof loadOrderLines>[number];
}

async function buildRealReview(client: StockLookupClient, options: RealReviewBuildOptions): Promise<RealReviewBuildResult> {
  const orderLines = loadOrderLines(options.orderFile);
  const stockBySpecNo = new Map<string, WarehouseStockSummary>();
  const lineInputs: RealReviewLineInput[] = [];
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
      { goodsSpecs: options.goodsSpecs, suites: options.suites, mappings: options.mappings },
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
          stockQueriedCount += 1;
        }
      }
    }

    if (decision.status === "ambiguous") {
      candidateRows.push(...toRealReviewCandidateRows(id, line, decision));
    }

    lineInputs.push({
      batchId: options.batchId,
      id,
      sortOrder: index + 1,
      orderLine: line,
      decision,
      matchStatus,
      matchMessage,
      stock,
    });
  }

  const allocations = allocateRealReviewShipQuantities(lineInputs, options.warehouseSettings, options.vipStoreIndex);
  const reviewLines = lineInputs.map((input) => buildRealReviewLine(input, allocations.get(input.id) ?? 0));

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

interface RealReviewLineInput {
  batchId: string;
  id: string;
  sortOrder: number;
  orderLine: ReturnType<typeof loadOrderLines>[number];
  decision: ProductMatchDecision;
  matchStatus: ReviewLineDto["matchStatus"];
  matchMessage: string;
  stock: WarehouseStockSummary | undefined;
}

function buildRealReviewLine(input: RealReviewLineInput, suggestedShipQty: number): ReviewLineDto {
  const specNo = input.matchStatus === "matched" ? input.decision.candidate?.specNo ?? "" : "";
  const makeOrderCode = input.matchStatus === "matched" ? input.decision.candidate?.makeOrderCode ?? specNo : "";
  const mainBefore = input.stock?.mainAvailableStock ?? 0;
  const nearExpiryBefore = input.stock?.nearExpiryAvailableStock ?? 0;

  const status = reviewStatusFor(input.matchStatus, input.orderLine.orderQty, suggestedShipQty);
  const decision = suggestedShipQty > 0 ? "ship" : "pending";

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
    wdtMakeOrderCode: makeOrderCode,
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

function allocateRealReviewShipQuantities(
  inputs: RealReviewLineInput[],
  warehouseSettings: WarehouseUsageSettingsDto,
  vipStoreIndex: VipStoreIndex,
): Map<string, number> {
  const allocations = new Map(inputs.map((input) => [input.id, 0]));
  const matchedBySpecNo = new Map<string, RealReviewLineInput[]>();
  for (const input of inputs) {
    const specNo = input.matchStatus === "matched" ? input.decision.candidate?.specNo ?? "" : "";
    if (!specNo || !input.stock) continue;
    const rows = matchedBySpecNo.get(specNo) ?? [];
    rows.push(input);
    matchedBySpecNo.set(specNo, rows);
  }

  for (const rows of matchedBySpecNo.values()) {
    const stock = rows[0]?.stock;
    if (!stock) continue;
    let remainingAvailable = usableStockForSettings(stock, warehouseSettings);
    const vipRows = rows.filter((row) => isVipReviewLine(row, vipStoreIndex));
    const regularRows = rows.filter((row) => !isVipReviewLine(row, vipStoreIndex));

    const vipAllocations = allocateFairlyByDemand(vipRows, remainingAvailable);
    for (const [id, quantity] of vipAllocations) {
      allocations.set(id, quantity);
      remainingAvailable -= quantity;
    }

    const regularAllocations = allocateFairlyByDemand(regularRows, remainingAvailable);
    for (const [id, quantity] of regularAllocations) {
      allocations.set(id, quantity);
    }
  }

  return allocations;
}

function allocateFairlyByDemand(rows: RealReviewLineInput[], available: number): Map<string, number> {
  const allocations = new Map(rows.map((row) => [row.id, 0]));
  let remainingAvailable = Math.max(0, Math.floor(available));
  let activeRows = rows.filter((row) => row.orderLine.orderQty > 0);

  while (remainingAvailable > 0 && activeRows.length > 0) {
    const share = Math.floor(remainingAvailable / activeRows.length);
    const extraCount = remainingAvailable % activeRows.length;
    let consumed = 0;
    const nextRows: RealReviewLineInput[] = [];

    for (const [index, row] of activeRows.entries()) {
      const current = allocations.get(row.id) ?? 0;
      const remainingDemand = Math.max(0, row.orderLine.orderQty - current);
      const fairShare = share + (index < extraCount ? 1 : 0);
      const quantity = Math.min(remainingDemand, fairShare);
      allocations.set(row.id, current + quantity);
      consumed += quantity;
      if (remainingDemand - quantity > 0) {
        nextRows.push(row);
      }
    }

    remainingAvailable = Math.max(0, remainingAvailable - consumed);
    activeRows = nextRows;
  }

  return allocations;
}

function usableStockForSettings(stock: WarehouseStockSummary, settings: WarehouseUsageSettingsDto): number {
  return (
    (settings.includeMainWarehouse ? stock.mainAvailableStock : 0)
    + (settings.includeNearExpiryWarehouse ? stock.nearExpiryAvailableStock : 0)
    + (settings.includeDefectWarehouse ? stock.defectAvailableStock : 0)
    + (settings.includeOtherWarehouses ? stock.otherAvailableStock : 0)
  );
}

function isVipReviewLine(input: RealReviewLineInput, vipStoreIndex: VipStoreIndex): boolean {
  return Boolean(
    (input.orderLine.storeNo && vipStoreIndex.byStoreNo.has(input.orderLine.storeNo))
      || (input.orderLine.storeName && vipStoreIndex.byStoreName.has(normalizeStoreName(input.orderLine.storeName))),
  );
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
      wdtMakeOrderCode: line.wdtMakeOrderCode || line.wdtSpecNo,
      matchStatus: line.matchStatus,
      matchMessage: line.matchMessage,
      stockErrorDetail: line.stockErrorDetail ?? "",
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

async function buildLiveProductMatchCandidates(database: DatabaseContext, query: string): Promise<ProductMatchCandidateDto[]> {
  const reviewRows = await database.db
    .select()
    .from(reviewLines)
    .where(
      or(
        eq(reviewLines.externalBarcode, query),
        eq(reviewLines.externalGoodsCode, query),
        like(reviewLines.externalGoodsName, `%${query}%`),
      ),
    )
    .limit(20);

  const inputs = reviewRows.length > 0
    ? reviewRows
    : [liveQueryReviewLine(query)];
  if (inputs.length === 0) return [];

  const goodsSpecs = (await database.db.select().from(wdtGoodsSpecs)).map(toLocalGoodsSpecCandidate);
  const suites = await loadLocalSuiteCandidates(database);
  const candidates: ProductMatchCandidateDto[] = [];

  for (const line of inputs) {
    const fullDecision = decideLocalProductMatch(reviewLineToProductMatchInput(line), { goodsSpecs, suites, mappings: [] });
    const nameDecision = decideLocalProductMatch(reviewLineToNameOnlyProductMatchInput(line), { goodsSpecs, suites, mappings: [] });
    candidates.push(...toLiveProductMatchCandidates(line, fullDecision));
    candidates.push(...toLiveProductMatchCandidates(line, nameDecision));
  }

  return dedupeProductMatchCandidates(candidates).sort(compareProductMatchCandidates).slice(0, 20);
}

function liveQueryReviewLine(query: string): Pick<ReviewLineRow, "id" | "batchId" | "externalBarcode" | "externalGoodsCode" | "externalGoodsName" | "originalSpec"> {
  return {
    id: "live-query",
    batchId: "live",
    externalBarcode: "",
    externalGoodsCode: "",
    externalGoodsName: query,
    originalSpec: "",
  };
}

function reviewLineToProductMatchInput(line: Pick<ReviewLineRow, "externalBarcode" | "externalGoodsCode" | "externalGoodsName" | "originalSpec">) {
  return {
    barcode: line.externalBarcode,
    goodsCode: line.externalGoodsCode,
    goodsName: line.externalGoodsName,
    specName: line.originalSpec,
  };
}

function reviewLineToNameOnlyProductMatchInput(line: Pick<ReviewLineRow, "externalGoodsName" | "originalSpec">) {
  return {
    goodsName: line.externalGoodsName,
    specName: line.originalSpec,
  };
}

function toLiveProductMatchCandidates(
  line: Pick<ReviewLineRow, "id" | "batchId" | "externalBarcode" | "externalGoodsCode" | "externalGoodsName">,
  decision: ProductMatchDecision,
): ProductMatchCandidateDto[] {
  const now = new Date().toISOString();
  const candidates = [decision.candidate, ...decision.candidates].filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
  return candidates
    .filter((candidate) => candidate.specNo)
    .map((candidate) => ({
      id: `live-candidate-${line.id}-${candidate.source}-${candidate.specNo}`,
      batchId: line.batchId,
      reviewLineId: line.id,
      externalBarcode: line.externalBarcode,
      externalGoodsName: line.externalGoodsName,
      externalGoodsCode: line.externalGoodsCode,
      wdtSpecNo: candidate.specNo ?? "",
      wdtGoodsNo: candidate.goodsNo ?? "",
      wdtGoodsName: candidate.goodsName ?? "",
      wdtSpecName: candidate.specName ?? "",
      wdtBarcode: candidate.barcodes?.[0] ?? "",
      score: candidate.score,
      basis: candidate.basis,
      source: candidate.source,
      createdAt: now,
    }));
}

function compareProductMatchCandidates(left: ProductMatchCandidateDto, right: ProductMatchCandidateDto): number {
  return (
    right.score - left.score
    || candidateStockSortValue(right) - candidateStockSortValue(left)
    || left.externalGoodsName.localeCompare(right.externalGoodsName, "zh-Hans")
    || left.wdtSpecNo.localeCompare(right.wdtSpecNo)
  );
}

function candidateStockSortValue(candidate: ProductMatchCandidateDto): number {
  if (candidate.stockTotalAvailable === undefined) return -1;
  return candidate.stockTotalAvailable;
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

async function loadLocalSuiteCandidates(database: DatabaseContext): Promise<LocalSuiteCandidate[]> {
  const suites = await database.db.select().from(wdtSuites);
  if (suites.length === 0) return [];
  const components = await database.db.select().from(wdtSuiteComponents);
  const componentsBySuiteNo = new Map<string, WdtSuiteComponentRow[]>();
  for (const component of components) {
    const rows = componentsBySuiteNo.get(component.suiteNo) ?? [];
    rows.push(component);
    componentsBySuiteNo.set(component.suiteNo, rows);
  }

  const candidates: LocalSuiteCandidate[] = [];
  for (const suite of suites) {
    const activeComponents = (componentsBySuiteNo.get(suite.suiteNo) ?? [])
      .filter((component) => component.deleted !== 1 && component.specNo)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    if (activeComponents.length !== 1) continue;
    candidates.push(toLocalSuiteCandidate(suite, activeComponents[0]));
  }
  return candidates;
}

function toLocalSuiteCandidate(suite: WdtSuiteRow, component: WdtSuiteComponentRow): LocalSuiteCandidate {
  return {
    suiteNo: suite.suiteNo,
    suiteName: suite.suiteName,
    barcode: suite.barcode,
    componentSpecNo: component.specNo,
    componentGoodsNo: component.goodsNo,
    componentGoodsName: component.goodsName,
    componentSpecName: component.specName,
    componentBarcode: component.barcode,
    deleted: suite.deleted,
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

async function loadExternalProductMatchIndex(database: DatabaseContext): Promise<ExternalProductMatchCandidate[]> {
  const products = await database.db.select().from(externalProducts).where(eq(externalProducts.status, "confirmed"));
  if (products.length === 0) return [];
  const components = await database.db.select().from(externalProductComponents);
  const componentsByProductId = new Map<string, ExternalProductComponentRow[]>();
  for (const component of components) {
    const rows = componentsByProductId.get(component.externalProductId) ?? [];
    rows.push(component);
    componentsByProductId.set(component.externalProductId, rows);
  }

  return products.map((product) => {
    const primaryComponent = (componentsByProductId.get(product.id) ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .find((component) => component.role === "primary" && component.wdtSpecNo);
    if (product.type === "bundle") {
      const bundleCode = product.externalBarcode || product.externalGoodsCode;
      return {
        type: product.type,
        externalBarcode: product.externalBarcode,
        externalGoodsCode: product.externalGoodsCode,
        externalGoodsName: product.externalGoodsName,
        wdtSpecNo: bundleCode,
        wdtGoodsNo: bundleCode,
        wdtGoodsName: product.externalGoodsName,
        wdtSpecName: "",
        wdtBarcode: product.externalBarcode,
      };
    }
    return {
      type: product.type,
      externalBarcode: product.externalBarcode,
      externalGoodsCode: product.externalGoodsCode,
      externalGoodsName: product.externalGoodsName,
      wdtSpecNo: primaryComponent?.wdtSpecNo ?? product.externalBarcode ?? product.externalGoodsCode,
      wdtGoodsNo: primaryComponent?.wdtGoodsNo ?? "",
      wdtGoodsName: primaryComponent?.wdtGoodsName ?? product.externalGoodsName,
      wdtSpecName: primaryComponent?.wdtSpecName ?? "",
      wdtBarcode: primaryComponent?.wdtBarcode ?? product.externalBarcode,
    };
  }).filter((item) => item.wdtSpecNo);
}

function findExternalProductMatch(line: ParsedConfirmedOrderLine, candidates: ExternalProductMatchCandidate[]): ExternalProductMatchCandidate | undefined {
  const barcode = normalizeIdentifier(line.externalBarcode);
  const goodsCode = normalizeIdentifier(line.externalGoodsCode);
  const goodsName = normalizeProductCandidateKeyPart(line.externalGoodsName);
  return candidates.find((candidate) => {
    if (barcode && barcode === normalizeIdentifier(candidate.externalBarcode)) return true;
    if (goodsCode && goodsCode === normalizeIdentifier(candidate.externalGoodsCode)) return true;
    return Boolean(goodsName && goodsName === normalizeProductCandidateKeyPart(candidate.externalGoodsName));
  });
}

function summarizeWarehouseStock(rows: WdtStockRow[], settings: WarehouseUsageSettingsDto): WarehouseStockSummary {
  let mainAvailableStock = 0;
  let nearExpiryAvailableStock = 0;
  let defectAvailableStock = 0;
  let otherAvailableStock = 0;

  for (const row of rows) {
    const available = getWdtAvailableSendStock(row);
    const warehouseType = classifyWdtWarehouse(row);
    if (warehouseType === "main") mainAvailableStock += available;
    else if (warehouseType === "near_expiry") nearExpiryAvailableStock += available;
    else if (warehouseType === "defect") defectAvailableStock += available;
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
      .map((row) => `${row.warehouse_no ?? ""}/${row.warehouse_name ?? ""}:可发库存${getWdtAvailableSendStock(row)}`)
      .filter(Boolean)
      .join("; "),
  };
}

async function queryWarehouseStockSummaries(
  specNos: string[],
  stockClient: StockLookupClient,
  settings: WarehouseUsageSettingsDto,
): Promise<{
  stockBySpecNo: Map<string, WarehouseStockSummary>;
  stockErrorsBySpecNo: Map<string, StockLookupError>;
  stockQueriedCount: number;
}> {
  const stockBySpecNo = new Map<string, WarehouseStockSummary>();
  const stockErrorsBySpecNo = new Map<string, StockLookupError>();
  let stockQueriedCount = 0;

  for (const batch of stockQueryBatches(specNos, stockClient)) {
    try {
      const response = await queryStockBatchWithRetry(stockClient, batch);
      if (response.status && response.status !== 0) {
        const error = buildStockLookupError(wdtStockResponseErrorDetail(response));
        for (const specNo of batch) stockErrorsBySpecNo.set(specNo, error);
        continue;
      }
      const rowsBySpecNo = groupWdtStockRowsBySpecNo(response.data?.detail_list ?? []);
      for (const specNo of batch) {
        stockBySpecNo.set(specNo, summarizeWarehouseStock(rowsBySpecNo.get(specNo) ?? [], settings));
        stockQueriedCount += 1;
      }
    } catch (error) {
      const stockError = buildStockLookupError(error instanceof Error ? error.message : "库存查询失败");
      for (const specNo of batch) stockErrorsBySpecNo.set(specNo, stockError);
    }
  }

  return { stockBySpecNo, stockErrorsBySpecNo, stockQueriedCount };
}

function stockQueryBatches(specNos: string[], stockClient: StockLookupClient): string[][] {
  const uniqueSpecNos = [...new Set(specNos.map((specNo) => specNo.trim()).filter(Boolean))];
  const batchSize = stockClient.queryStocks ? WDT_STOCK_BATCH_SIZE : 1;
  return chunk(uniqueSpecNos, batchSize);
}

async function queryStockBatchWithRetry(stockClient: StockLookupClient, specNos: string[]): Promise<WdtStockResponse> {
  let latestFailure: unknown;
  for (const delayMs of [0, ...WDT_STOCK_RETRY_DELAYS_MS]) {
    if (delayMs > 0) await sleep(delayMs);
    try {
      const response = await enqueueWdtStockRequest(() => queryStockBatch(stockClient, specNos));
      if (!isRetryableWdtStockResponse(response)) return response;
      latestFailure = new Error(wdtStockResponseErrorDetail(response));
    } catch (error) {
      latestFailure = error;
      if (!isRetryableWdtStockError(error)) throw error;
    }
  }
  if (latestFailure instanceof Error) throw latestFailure;
  throw new Error("库存查询失败");
}

async function queryStockBatch(stockClient: StockLookupClient, specNos: string[]): Promise<WdtStockResponse> {
  if (stockClient.queryStocks) return stockClient.queryStocks(specNos);
  return stockClient.queryStock(specNos[0] ?? "");
}

function enqueueWdtStockRequest<T>(request: () => Promise<T>): Promise<T> {
  const run = async () => {
    const waitMs = Math.max(0, lastWdtStockRequestStartedAt + WDT_STOCK_MIN_INTERVAL_MS - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    lastWdtStockRequestStartedAt = Date.now();
    return request();
  };
  const result = wdtStockRequestQueue.catch(() => undefined).then(run);
  wdtStockRequestQueue = result.then(() => undefined, () => undefined);
  return result;
}

function isRetryableWdtStockResponse(response: WdtStockResponse): boolean {
  if (!response.status || response.status === 0) return false;
  return isRetryableWdtStockDetail(wdtStockResponseErrorDetail(response));
}

function isRetryableWdtStockError(error: unknown): boolean {
  return isRetryableWdtStockDetail(error instanceof Error ? error.message : String(error));
}

function isRetryableWdtStockDetail(detail: string): boolean {
  return detail.includes("并发") || detail.includes("频率") || detail.includes("status=100");
}

function wdtStockResponseErrorDetail(response: WdtStockResponse): string {
  return `status=${response.status ?? ""} message=${response.message ?? ""}`;
}

function groupWdtStockRowsBySpecNo(rows: WdtStockRow[]): Map<string, WdtStockRow[]> {
  const rowsBySpecNo = new Map<string, WdtStockRow[]>();
  for (const row of rows) {
    const specNo = (row.spec_no ?? "").trim();
    if (!specNo) continue;
    rowsBySpecNo.set(specNo, [...(rowsBySpecNo.get(specNo) ?? []), row]);
  }
  return rowsBySpecNo;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StockLookupError {
  userMessage: string;
  developerDetail: string;
}

function buildStockLookupError(developerDetail: string): StockLookupError {
  return {
    userMessage: "确定单库存查询失败。仅提示，不调整做单数量",
    developerDetail,
  };
}

type WarehouseStockType = "main" | "near_expiry" | "defect" | "other";

function classifyWdtWarehouse(row: WdtStockRow): WarehouseStockType {
  const warehouseNo = (row.warehouse_no ?? "").trim().toUpperCase();
  const warehouseName = (row.warehouse_name ?? "").trim();
  if (warehouseNo === "001" || warehouseName.includes("主仓")) return "main";
  if (warehouseNo === "LINQI" || warehouseName.includes("临期")) return "near_expiry";
  if (warehouseNo === "CIPIN" || row.defect === true || warehouseName.includes("次品")) return "defect";
  return "other";
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
    sourceType: batch.sourceType,
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
    isVip: Boolean(row.isVip),
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
    wdtMakeOrderCode: line.wdtMakeOrderCode || line.wdtSpecNo,
    matchStatus: line.matchStatus,
    matchMessage: line.matchMessage,
    stockErrorDetail: line.stockErrorDetail,
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

async function attachProductCandidateStock(
  candidates: ProductMatchCandidateDto[],
  database: DatabaseContext,
  stockClient: StockLookupClient | undefined,
): Promise<ProductMatchCandidateDto[]> {
  if (!stockClient || candidates.length === 0) return candidates;
  const stockBySpecNo = await queryStockBySpecNo(candidates.map((candidate) => candidate.wdtSpecNo), database, stockClient);
  return candidates.map((candidate) => ({ ...candidate, ...(stockBySpecNo.get(candidate.wdtSpecNo) ?? {}) }));
}

async function attachWdtGoodsSpecSearchStock(
  specs: WdtGoodsSpecSearchResultDto[],
  database: DatabaseContext,
  stockClient: StockLookupClient | undefined,
): Promise<WdtGoodsSpecSearchResultDto[]> {
  if (!stockClient || specs.length === 0) return specs;
  const stockBySpecNo = await queryStockBySpecNo(specs.map((spec) => spec.specNo), database, stockClient);
  return specs.map((spec) => ({ ...spec, ...(stockBySpecNo.get(spec.specNo) ?? {}) }));
}

async function queryStockBySpecNo(
  specNos: string[],
  database: DatabaseContext,
  stockClient: StockLookupClient,
): Promise<Map<string, Pick<ProductMatchCandidateDto, "stockTotalAvailable" | "stockRows" | "stockError">>> {
  const settings = toWarehouseUsageSettingsDto(await getWarehouseUsageSettingsRow(database));
  const stockBySpecNo = new Map<string, Pick<ProductMatchCandidateDto, "stockTotalAvailable" | "stockRows" | "stockError">>();
  for (const batch of stockQueryBatches(specNos, stockClient)) {
    try {
      const response = await queryStockBatchWithRetry(stockClient, batch);
      if (response.status && response.status !== 0) {
        const stockError = `库存查询失败 ${wdtStockResponseErrorDetail(response)}`;
        for (const specNo of batch) stockBySpecNo.set(specNo, { stockError });
        continue;
      }
      const rowsBySpecNo = groupWdtStockRowsBySpecNo(response.data?.detail_list ?? []);
      for (const specNo of batch) {
        const rows = (rowsBySpecNo.get(specNo) ?? []).map((row) => ({
          warehouseNo: row.warehouse_no ?? "",
          warehouseName: row.warehouse_name ?? "",
          availableSendStock: getWdtAvailableSendStock(row),
          included: isIncludedWarehouseStock(row, settings),
        }));
        stockBySpecNo.set(specNo, {
          stockTotalAvailable: rows.filter((row) => row.included).reduce((total, row) => total + row.availableSendStock, 0),
          stockRows: rows,
        });
      }
    } catch (error) {
      const stockError = error instanceof Error ? error.message : "库存查询失败";
      for (const specNo of batch) stockBySpecNo.set(specNo, { stockError });
    }
  }
  return stockBySpecNo;
}

function isIncludedWarehouseStock(row: WdtStockRow, settings: WarehouseUsageSettingsDto) {
  const warehouseType = classifyWdtWarehouse(row);
  if (warehouseType === "main") return settings.includeMainWarehouse;
  if (warehouseType === "near_expiry") return settings.includeNearExpiryWarehouse;
  if (warehouseType === "defect") return settings.includeDefectWarehouse;
  return settings.includeOtherWarehouses;
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
  await ensureBatchColumns(database);
  await ensureReviewLineColumns(database);
  await ensureWarehouseUsageSettings(database);
  await ensureStoreAddresses(database);
  await ensureExternalProducts(database);
  await ensureBootstrapUsers(database, bootstrapUsers);
}

async function ensureBatchColumns(database: DatabaseContext) {
  const columns = await getTableColumns(database, "batches");
  if (columns.length === 0) return;
  if (!columns.includes("source_type")) {
    await database.client.execute("alter table batches add column source_type text not null default 'order'");
  }
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
      is_vip integer not null default 0,
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
  if (!columns.includes("is_vip")) {
    await database.client.execute("alter table store_addresses add column is_vip integer not null default 0");
  }
  await database.client.execute("create index if not exists store_addresses_store_no_idx on store_addresses (store_no)");
  await database.client.execute("create index if not exists store_addresses_normalized_store_name_idx on store_addresses (normalized_store_name)");
  await database.client.execute("create index if not exists store_addresses_updated_at_idx on store_addresses (updated_at)");
}

async function ensureExternalProducts(database: DatabaseContext) {
  await database.client.execute(`
    create table if not exists external_products (
      id text primary key not null,
      type text not null,
      external_barcode text not null default '',
      external_goods_code text not null default '',
      external_goods_name text not null default '',
      status text not null,
      source_file_name text not null default '',
      source_sheet text not null default '',
      source_row integer not null default 0,
      imported_at text not null default '',
      raw_json text not null default '{}',
      note text not null default '',
      updated_by_user_id text,
      updated_by_username text,
      created_at text not null,
      updated_at text not null
    )
  `);
  await database.client.execute(`
    create table if not exists external_product_components (
      id text primary key not null,
      external_product_id text not null,
      sort_order integer not null,
      role text not null default 'primary',
      component_barcode text not null default '',
      component_goods_code text not null default '',
      component_name text not null default '',
      component_spec text not null default '',
      quantity_multiplier real not null default 1,
      wdt_spec_no text not null default '',
      wdt_goods_no text not null default '',
      wdt_goods_name text not null default '',
      wdt_spec_name text not null default '',
      wdt_barcode text not null default '',
      match_status text not null,
      match_message text not null default '',
      note text not null default '',
      source_sheet text not null default '',
      source_row integer not null default 0,
      raw_json text not null default '{}',
      created_at text not null,
      updated_at text not null
    )
  `);
  await database.client.execute("create index if not exists external_products_type_idx on external_products (type)");
  await database.client.execute("create index if not exists external_products_external_barcode_idx on external_products (external_barcode)");
  await database.client.execute("create index if not exists external_products_external_goods_code_idx on external_products (external_goods_code)");
  await database.client.execute("create index if not exists external_products_updated_at_idx on external_products (updated_at)");
  await database.client.execute("create index if not exists external_product_components_product_id_idx on external_product_components (external_product_id)");
  await database.client.execute("create index if not exists external_product_components_component_barcode_idx on external_product_components (component_barcode)");
  await database.client.execute("create index if not exists external_product_components_wdt_spec_no_idx on external_product_components (wdt_spec_no)");
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
  sourcePriority: number;
  sourceOrder: number;
  sourceRow: number;
  rawFields: Record<string, string>;
}

interface StoreAddressImportGroup {
  address: ParsedStoreAddress;
  rawAddresses: ParsedStoreAddress[];
}

interface ParsedExternalProduct {
  type: ExternalProductDto["type"];
  externalBarcode: string;
  externalGoodsCode: string;
  externalGoodsName: string;
  sourceSheet: string;
  sourceSheetIndex: number;
  sourceRow: number;
  sourceOrder: number;
  note: string;
  rawFields: Record<string, string>;
  components: ParsedExternalProductComponent[];
}

interface ParsedExternalProductComponent {
  role: ExternalProductComponentDto["role"];
  componentBarcode: string;
  componentGoodsCode: string;
  componentName: string;
  componentSpec: string;
  quantityMultiplier: number;
  note: string;
  sourceSheet: string;
  sourceRow: number;
  rawFields: Record<string, string>;
}

interface ExternalProductImportParseResult {
  workbookSheetCount: number;
  sheetCount: number;
  skippedRowCount: number;
  products: ParsedExternalProduct[];
}

interface MakeOrderAddressIndex {
  byStoreNo: Map<string, MakeOrderAddress>;
  byStoreName: Map<string, MakeOrderAddress>;
}

function renderExportWorkbook(
  batch: BatchRow,
  type: ExportDto["type"],
  lines: ReviewLineDto[],
  addressIndex?: MakeOrderAddressIndex,
  actor?: AuthUserDto,
) {
  if (type === "wdt_import") {
    return renderWdtImportWorkbook(batch, lines, addressIndex ?? emptyMakeOrderAddressIndex(), actor);
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

function renderWdtImportWorkbook(batch: BatchRow, lines: ReviewLineDto[], addressIndex: MakeOrderAddressIndex, actor?: AuthUserDto) {
  const exportLines = lines.filter((line) => line.decision === "ship" && line.approvedShipQty > 0);
  const context = buildWdtImportContext(batch, exportLines);
  const rows = [
    [...WDT_IMPORT_HEADERS],
    ...exportLines.map((line) => renderWdtImportRow(line, addressIndex, WDT_IMPORT_HEADERS, context, actor)),
  ];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, WDT_IMPORT_SHEET_NAME);
  return XLSX.write(workbook, { bookType: "biff8", type: "buffer" }) as Buffer;
}

function renderWdtImportRow(
  line: ReviewLineDto,
  addressIndex: MakeOrderAddressIndex,
  headers: readonly string[],
  context: WdtImportContext,
  actor?: AuthUserDto,
) {
  const makeOrderAddress = findMakeOrderAddress(addressIndex, line);
  const values: Partial<Record<string, string | number>> = {
    店铺名称: WDT_IMPORT_DEFAULTS.shopName,
    原始单号: context.originalNoByLineId.get(line.id) ?? line.id,
    收件人: makeOrderAddress?.receiver ?? "",
    网名: WDT_IMPORT_DEFAULTS.customerName,
    地址: makeOrderAddress?.address ?? "",
    手机: makeOrderAddress?.phone ?? "",
    发货条件: WDT_IMPORT_DEFAULTS.deliveryCondition,
    邮费: 0,
    优惠金额: 0,
    仓库名称: WDT_IMPORT_DEFAULTS.warehouseName,
    物流公司: WDT_IMPORT_DEFAULTS.logisticsCompany,
    客服备注: context.customerRemarkByStoreKey.get(makeOrderStoreKey(line)) ?? line.orderNoticeNo,
    发票类型: WDT_IMPORT_DEFAULTS.invoiceType,
    发票抬头: WDT_IMPORT_DEFAULTS.invoiceTitle,
    业务员: actor?.username ?? "",
    商家编码: line.wdtMakeOrderCode || line.wdtSpecNo,
    货品数量: line.approvedShipQty,
    货品价格: numberOrBlank(line.contractPrice),
  };

  return headers.map((header) => values[header] ?? "");
}

interface WdtImportContext {
  originalNoByLineId: Map<string, string>;
  customerRemarkByStoreKey: Map<string, string>;
}

function buildWdtImportContext(batch: BatchRow, lines: ReviewLineDto[]): WdtImportContext {
  const originalNoByLineId = new Map<string, string>();
  const customerRemarkByStoreKey = new Map<string, string>();
  const noticeNosByStoreKey = new Map<string, string[]>();

  for (const [index, line] of lines.entries()) {
    originalNoByLineId.set(line.id, buildWdtOriginalNo(batch, index + 1));
    const storeKey = makeOrderStoreKey(line);
    const noticeNos = noticeNosByStoreKey.get(storeKey) ?? [];
    if (line.orderNoticeNo && !noticeNos.includes(line.orderNoticeNo)) {
      noticeNos.push(line.orderNoticeNo);
    }
    noticeNosByStoreKey.set(storeKey, noticeNos);
  }

  for (const [storeKey, noticeNos] of noticeNosByStoreKey) {
    customerRemarkByStoreKey.set(storeKey, noticeNos.join("、"));
  }

  return { originalNoByLineId, customerRemarkByStoreKey };
}

function buildWdtOriginalNo(batch: BatchRow, sequence: number) {
  const datePart = compactDate(batch.createdAt);
  const batchPart = batch.id.replace(/^batch-/, "").replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase().padEnd(4, "0");
  const sequencePart = sequence.toString(36).toUpperCase().padStart(4, "0");
  return `JY${datePart}${batchPart}${sequencePart}`.slice(0, 16);
}

function compactDate(isoTime: string) {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(2, 10).replaceAll("-", "");
  return date.toISOString().slice(2, 10).replaceAll("-", "");
}

function makeOrderStoreKey(line: Pick<ReviewLineDto, "storeNo" | "storeName">) {
  return line.storeNo ? `no:${normalizeStoreNo(line.storeNo)}` : `name:${normalizeStoreName(line.storeName)}`;
}

function numberOrBlank(value: string) {
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
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

function parseExternalProductImportInput(input: ImportExternalProductsRequest): ExternalProductImportParseResult {
  const workbook = XLSX.read(Buffer.from(input.contentBase64, "base64"), { type: "buffer", cellDates: false });
  const products: ParsedExternalProduct[] = [];
  let skippedRowCount = 0;
  let sourceOrder = 0;
  const parsedSheetNames = new Set<string>();

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<Array<string | number>>(workbook.Sheets[sheetName], { header: 1, defval: "" });
    if (sheetName === "小样价格") {
      const result = parseSampleProductSheet(rows, sheetName, sourceOrder);
      products.push(...result.products);
      sourceOrder = result.sourceOrder;
      skippedRowCount += result.skippedRowCount;
      if (result.products.length > 0) parsedSheetNames.add(sheetName);
    } else if (sheetName === "套盒") {
      const result = parseBundleProductSheet(rows, sheetName, sourceOrder);
      products.push(...result.products);
      sourceOrder = result.sourceOrder;
      skippedRowCount += result.skippedRowCount;
      if (result.products.length > 0) parsedSheetNames.add(sheetName);
    } else if (sheetName === "联营套盒") {
      const result = parseJointBundleProductSheet(rows, sheetName, sourceOrder);
      products.push(...result.products);
      sourceOrder = result.sourceOrder;
      skippedRowCount += result.skippedRowCount;
      if (result.products.length > 0) parsedSheetNames.add(sheetName);
    }
  }

  return {
    workbookSheetCount: workbook.SheetNames.length,
    sheetCount: parsedSheetNames.size,
    skippedRowCount,
    products,
  };
}

function parseSampleProductSheet(rows: Array<Array<string | number>>, sheetName: string, initialSourceOrder: number) {
  const products: ParsedExternalProduct[] = [];
  let skippedRowCount = 0;
  let sourceOrder = initialSourceOrder;
  if (rows.length < 2) return { products, skippedRowCount, sourceOrder };

  const headers = rows[0].map((value) => normalizeHeader(value));
  const rawHeaders = buildRawHeaderLabels(rows[0]);
  const goodsCodeIndex = findHeaderIndex(headers, ["商品编码"]);
  const barcodeIndex = findHeaderIndex(headers, ["商品条码"]);
  const nameIndex = findHeaderIndex(headers, ["商品全称", "商品名称"]);
  const tagPriceIndex = findHeaderIndex(headers, ["标签价格"]);
  const supplyPriceIndex = findHeaderIndex(headers, ["系统供货价"]);
  if (barcodeIndex < 0 || nameIndex < 0) return { products, skippedRowCount: rows.length, sourceOrder };

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row.some((value) => cellText(value))) continue;
    const externalBarcode = cellText(row[barcodeIndex]);
    const externalGoodsName = cellText(row[nameIndex]);
    const externalGoodsCode = goodsCodeIndex >= 0 ? cellText(row[goodsCodeIndex]) : "";
    if (!externalBarcode && !externalGoodsName && !externalGoodsCode) {
      skippedRowCount += 1;
      continue;
    }
    const note = [
      tagPriceIndex >= 0 && cellText(row[tagPriceIndex]) ? `标签价格:${cellText(row[tagPriceIndex])}` : "",
      supplyPriceIndex >= 0 && cellText(row[supplyPriceIndex]) ? `系统供货价:${cellText(row[supplyPriceIndex])}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    const rawFields = rawFieldsForRow(rawHeaders, row);
    const component: ParsedExternalProductComponent = {
      role: "primary",
      componentBarcode: externalBarcode,
      componentGoodsCode: externalGoodsCode,
      componentName: externalGoodsName,
      componentSpec: "",
      quantityMultiplier: 1,
      note,
      sourceSheet: sheetName,
      sourceRow: rowIndex + 1,
      rawFields,
    };
    products.push({
      type: "sample",
      externalBarcode,
      externalGoodsCode,
      externalGoodsName,
      sourceSheet: sheetName,
      sourceSheetIndex: 0,
      sourceRow: rowIndex + 1,
      sourceOrder: sourceOrder += 1,
      note,
      rawFields,
      components: [component],
    });
  }
  return { products, skippedRowCount, sourceOrder };
}

function parseBundleProductSheet(rows: Array<Array<string | number>>, sheetName: string, initialSourceOrder: number) {
  const products: ParsedExternalProduct[] = [];
  let skippedRowCount = 0;
  let sourceOrder = initialSourceOrder;
  let current: ParsedExternalProduct | undefined;
  const rawHeaders = bundleRawHeaders();

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row.some((value) => cellText(value))) continue;
    if (cellText(row[0])) {
      current = {
        type: "bundle",
        externalBarcode: cellText(row[2]),
        externalGoodsCode: "",
        externalGoodsName: cellText(row[0]),
        sourceSheet: sheetName,
        sourceSheetIndex: 0,
        sourceRow: rowIndex + 1,
        sourceOrder: sourceOrder += 1,
        note: cellText(row[5]) ? `合同价:${cellText(row[5])}` : "",
        rawFields: rawFieldsForRow(rawHeaders, row),
        components: [],
      };
      products.push(current);
    }
    if (!current) {
      skippedRowCount += 1;
      continue;
    }
    const componentSlots: Array<{ role: ParsedExternalProductComponent["role"]; codeIndex: number; noteIndex: number; nameIndex?: number; priceIndex?: number }> = [
      { role: "primary", codeIndex: 3, noteIndex: 4 },
      { role: "replacement", codeIndex: 6, noteIndex: 7, nameIndex: 8, priceIndex: 9 },
      { role: "extra", codeIndex: 10, noteIndex: 11 },
    ];
    for (const slot of componentSlots) {
      const code = cellText(row[slot.codeIndex]);
      if (!isLikelyProductIdentifier(code)) continue;
      const note = [
        cellText(row[slot.noteIndex]),
        slot.priceIndex !== undefined && cellText(row[slot.priceIndex]) ? `价格:${cellText(row[slot.priceIndex])}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      current.components.push({
        role: slot.role,
        componentBarcode: code,
        componentGoodsCode: "",
        componentName: slot.nameIndex !== undefined ? cellText(row[slot.nameIndex]) : "",
        componentSpec: "",
        quantityMultiplier: quantityFromCell(row[slot.noteIndex]),
        note,
        sourceSheet: sheetName,
        sourceRow: rowIndex + 1,
        rawFields: rawFieldsForRow(rawHeaders, row),
      });
    }
  }
  return { products: products.filter((product) => product.components.length > 0), skippedRowCount, sourceOrder };
}

function parseJointBundleProductSheet(rows: Array<Array<string | number>>, sheetName: string, initialSourceOrder: number) {
  const products: ParsedExternalProduct[] = [];
  let skippedRowCount = 0;
  let sourceOrder = initialSourceOrder;
  let current: ParsedExternalProduct | undefined;
  const rawHeaders = ["套盒名称", "商品条码", "商品名称", "规格", "原价", "特售价", "数量备注", "备注1", "备注2", "备注3", "备注4"];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row.some((value) => cellText(value))) continue;
    if (cellText(row[0])) {
      current = {
        type: "bundle",
        externalBarcode: "",
        externalGoodsCode: "",
        externalGoodsName: cellText(row[0]),
        sourceSheet: sheetName,
        sourceSheetIndex: 0,
        sourceRow: rowIndex + 1,
        sourceOrder: sourceOrder += 1,
        note: [cellText(row[4]) ? `原价:${cellText(row[4])}` : "", cellText(row[5]) ? `特售价:${cellText(row[5])}` : ""].filter(Boolean).join("; "),
        rawFields: rawFieldsForRow(rawHeaders, row),
        components: [],
      };
      products.push(current);
    }
    if (!current) {
      skippedRowCount += 1;
      continue;
    }
    const componentBarcode = cellText(row[1]);
    const note = [cellText(row[6]), cellText(row[7]), cellText(row[8]), cellText(row[9]), cellText(row[10])].filter(Boolean).join("; ");
    if (!componentBarcode && !cellText(row[2]) && !note) continue;
    current.components.push({
      role: "primary",
      componentBarcode,
      componentGoodsCode: "",
      componentName: cellText(row[2]),
      componentSpec: cellText(row[3]),
      quantityMultiplier: quantityFromCell(row[6]),
      note,
      sourceSheet: sheetName,
      sourceRow: rowIndex + 1,
      rawFields: rawFieldsForRow(rawHeaders, row),
    });
  }
  return { products: products.filter((product) => product.components.length > 0), skippedRowCount, sourceOrder };
}

async function buildExternalProductImportPreview(
  database: DatabaseContext,
  products: ParsedExternalProduct[],
): Promise<ExternalProductImportPreviewItem[]> {
  const goodsSpecs = await database.db.select().from(wdtGoodsSpecs);
  const matcher = buildWdtSpecIdentifierMatcher(goodsSpecs);
  const items: ExternalProductImportPreviewItem[] = [];
  for (const product of products) {
    const components = product.components.map((component) => toExternalProductComponentPreview(component, matcher));
    const status: ExternalProductDto["status"] = components.every((component) => component.matchStatus === "unique_wdt_hit")
      ? "confirmed"
      : "needs_review";
    const itemBase = {
      type: product.type,
      externalBarcode: product.externalBarcode,
      externalGoodsCode: product.externalGoodsCode,
      externalGoodsName: product.externalGoodsName,
    };
    const existing = await findExternalProductRow(database, itemBase);
    const previewWithoutAction = {
      ...itemBase,
      status,
      sourceSheet: product.sourceSheet,
      sourceRow: product.sourceRow,
      note: product.note,
      rawJson: JSON.stringify(product.rawFields),
      componentCount: components.length,
      resolvedComponentCount: components.filter((component) => component.matchStatus === "unique_wdt_hit").length,
      needsReviewComponentCount: components.filter((component) => component.matchStatus !== "unique_wdt_hit").length,
      existing: existing
        ? {
            id: existing.id,
            status: existing.status,
            componentCount: await countExternalProductComponents(database, existing.id),
            updatedAt: existing.updatedAt,
          }
        : null,
      components,
    };
    items.push({
      action: await externalProductPreviewAction(database, existing, previewWithoutAction),
      ...previewWithoutAction,
    });
  }
  return items;
}

function summarizeExternalProductPreview(
  fileName: string,
  parsed: ExternalProductImportParseResult,
  items: ExternalProductImportPreviewItem[],
): ImportExternalProductsPreviewResponse {
  return {
    fileName,
    sheetCount: parsed.sheetCount,
    parsedProductCount: items.length,
    parsedComponentCount: items.reduce((total, item) => total + item.components.length, 0),
    skippedRowCount: parsed.skippedRowCount,
    createCount: items.filter((item) => item.action === "create").length,
    updateCount: items.filter((item) => item.action === "update").length,
    unchangedCount: items.filter((item) => item.action === "unchanged").length,
    needsReviewCount: items.filter((item) => item.status === "needs_review").length,
    items,
  };
}

function toExternalProductComponentPreview(
  component: ParsedExternalProductComponent,
  matcher: (identifier: string) => ReturnType<typeof matchWdtSpecIdentifier>,
): ExternalProductImportComponentPreview {
  const identifier = component.componentBarcode || component.componentGoodsCode;
  const match = matcher(identifier);
  const forceReview = component.role !== "primary";
  const matchStatus = forceReview ? "needs_review" : match.matchStatus;
  const matchMessage = forceReview ? `非主组件/替换备注需人工确认；${match.matchMessage}` : match.matchMessage;
  return {
    role: component.role,
    componentBarcode: component.componentBarcode,
    componentGoodsCode: component.componentGoodsCode,
    componentName: component.componentName,
    componentSpec: component.componentSpec,
    quantityMultiplier: component.quantityMultiplier,
    wdtSpecNo: forceReview ? "" : match.spec?.specNo ?? "",
    wdtGoodsNo: forceReview ? "" : match.spec?.goodsNo ?? "",
    wdtGoodsName: forceReview ? "" : match.spec?.goodsName ?? "",
    wdtSpecName: forceReview ? "" : match.spec?.specName ?? "",
    wdtBarcode: forceReview ? "" : match.spec?.barcode ?? "",
    matchStatus,
    matchMessage,
    note: component.note,
    sourceSheet: component.sourceSheet,
    sourceRow: component.sourceRow,
    rawJson: JSON.stringify(component.rawFields),
  };
}

function buildWdtSpecIdentifierMatcher(goodsSpecs: WdtGoodsSpecRow[]) {
  const barcodeIndex = new Map<string, WdtGoodsSpecRow[]>();
  const codeIndex = new Map<string, WdtGoodsSpecRow[]>();
  for (const spec of goodsSpecs) {
    for (const barcode of [...parseBarcodes(spec.barcodesJson), spec.barcode].map(normalizeIdentifier).filter(Boolean)) {
      const rows = barcodeIndex.get(barcode) ?? [];
      rows.push(spec);
      barcodeIndex.set(barcode, rows);
    }
    for (const code of [spec.goodsNo, spec.specNo, spec.specCode].map(normalizeIdentifier).filter(Boolean)) {
      const rows = codeIndex.get(code) ?? [];
      rows.push(spec);
      codeIndex.set(code, rows);
    }
  }
  return (identifier: string) => matchWdtSpecIdentifier(identifier, barcodeIndex, codeIndex);
}

function matchWdtSpecIdentifier(
  identifier: string,
  barcodeIndex: Map<string, WdtGoodsSpecRow[]>,
  codeIndex: Map<string, WdtGoodsSpecRow[]>,
) {
  const key = normalizeIdentifier(identifier);
  if (!key) {
    return { matchStatus: "needs_review" as const, matchMessage: "缺少组件编号", spec: undefined };
  }
  const matches = [...(barcodeIndex.get(key) ?? []), ...(codeIndex.get(key) ?? [])];
  const activeBySpecNo = new Map(matches.filter((spec) => spec.deleted !== 1).map((spec) => [spec.specNo, spec]));
  const active = [...activeBySpecNo.values()];
  if (active.length === 1) {
    return { matchStatus: "unique_wdt_hit" as const, matchMessage: "唯一命中 WDT 规格", spec: active[0] };
  }
  if (active.length > 1) {
    return { matchStatus: "ambiguous_wdt_hit" as const, matchMessage: `命中多个 WDT 规格：${active.map((spec) => spec.specNo).join(", ")}`, spec: undefined };
  }
  if (matches.length > 0) {
    return { matchStatus: "deleted_only_wdt_hit" as const, matchMessage: "仅命中已删除 WDT 规格", spec: undefined };
  }
  return { matchStatus: "no_wdt_hit" as const, matchMessage: "未命中本地 WDT 商品档案", spec: undefined };
}

async function findExternalProductRow(
  database: DatabaseContext,
  input: Pick<ExternalProductImportPreviewItem, "type" | "externalBarcode" | "externalGoodsCode" | "externalGoodsName">,
): Promise<ExternalProductRow | undefined> {
  const conditions = [eq(externalProducts.type, input.type)];
  if (input.externalBarcode) {
    conditions.push(eq(externalProducts.externalBarcode, input.externalBarcode));
  } else if (input.externalGoodsCode) {
    conditions.push(eq(externalProducts.externalGoodsCode, input.externalGoodsCode));
  } else if (input.externalGoodsName) {
    conditions.push(eq(externalProducts.externalGoodsName, input.externalGoodsName));
  } else {
    return undefined;
  }
  const [row] = await database.db.select().from(externalProducts).where(and(...conditions)).limit(1);
  return row;
}

async function externalProductPreviewAction(
  database: DatabaseContext,
  existing: ExternalProductRow | undefined,
  item: Omit<ExternalProductImportPreviewItem, "action">,
): Promise<ExternalProductImportPreviewItem["action"]> {
  if (!existing) return "create";
  const components = await database.db.select().from(externalProductComponents).where(eq(externalProductComponents.externalProductId, existing.id));
  const currentFingerprint = externalProductFingerprint(toExternalProductDto(existing, components));
  const nextFingerprint = externalProductPreviewFingerprint(item);
  return currentFingerprint === nextFingerprint ? "unchanged" : "update";
}

async function countExternalProductComponents(database: DatabaseContext, externalProductId: string): Promise<number> {
  const rows = await database.db.select().from(externalProductComponents).where(eq(externalProductComponents.externalProductId, externalProductId));
  return rows.length;
}

function externalProductFingerprint(product: ExternalProductDto): string {
  return JSON.stringify({
    type: product.type,
    externalBarcode: product.externalBarcode,
    externalGoodsCode: product.externalGoodsCode,
    externalGoodsName: product.externalGoodsName,
    status: product.status,
    note: product.note,
    components: product.components.map((component) => ({
      role: component.role,
      componentBarcode: component.componentBarcode,
      componentGoodsCode: component.componentGoodsCode,
      componentName: component.componentName,
      componentSpec: component.componentSpec,
      quantityMultiplier: component.quantityMultiplier,
      wdtSpecNo: component.wdtSpecNo,
      matchStatus: component.matchStatus,
      note: component.note,
    })),
  });
}

function externalProductPreviewFingerprint(item: Omit<ExternalProductImportPreviewItem, "action">): string {
  return JSON.stringify({
    type: item.type,
    externalBarcode: item.externalBarcode,
    externalGoodsCode: item.externalGoodsCode,
    externalGoodsName: item.externalGoodsName,
    status: item.status,
    note: item.note,
    components: item.components.map((component) => ({
      role: component.role,
      componentBarcode: component.componentBarcode,
      componentGoodsCode: component.componentGoodsCode,
      componentName: component.componentName,
      componentSpec: component.componentSpec,
      quantityMultiplier: component.quantityMultiplier,
      wdtSpecNo: component.wdtSpecNo,
      matchStatus: component.matchStatus,
      note: component.note,
    })),
  });
}

async function toExternalProductDtos(database: DatabaseContext, rows: ExternalProductRow[]): Promise<ExternalProductDto[]> {
  const result: ExternalProductDto[] = [];
  for (const row of rows) {
    const components = await database.db
      .select()
      .from(externalProductComponents)
      .where(eq(externalProductComponents.externalProductId, row.id))
      .orderBy(externalProductComponents.sortOrder);
    result.push(toExternalProductDto(row, components));
  }
  return result;
}

function toExternalProductDto(row: ExternalProductRow, components: ExternalProductComponentRow[]): ExternalProductDto {
  return {
    id: row.id,
    type: row.type,
    externalBarcode: row.externalBarcode,
    externalGoodsCode: row.externalGoodsCode,
    externalGoodsName: row.externalGoodsName,
    status: row.status,
    sourceFileName: row.sourceFileName,
    sourceSheet: row.sourceSheet,
    sourceRow: row.sourceRow,
    importedAt: row.importedAt,
    rawJson: row.rawJson,
    note: row.note,
    updatedByUserId: row.updatedByUserId ?? null,
    updatedByUsername: row.updatedByUsername ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    components: components.map(toExternalProductComponentDto),
  };
}

function toExternalProductComponentDto(row: ExternalProductComponentRow): ExternalProductComponentDto {
  return {
    id: row.id,
    externalProductId: row.externalProductId,
    sortOrder: row.sortOrder,
    role: row.role,
    componentBarcode: row.componentBarcode,
    componentGoodsCode: row.componentGoodsCode,
    componentName: row.componentName,
    componentSpec: row.componentSpec,
    quantityMultiplier: row.quantityMultiplier,
    wdtSpecNo: row.wdtSpecNo,
    wdtGoodsNo: row.wdtGoodsNo,
    wdtGoodsName: row.wdtGoodsName,
    wdtSpecName: row.wdtSpecName,
    wdtBarcode: row.wdtBarcode,
    matchStatus: row.matchStatus,
    matchMessage: row.matchMessage,
    note: row.note,
    sourceSheet: row.sourceSheet,
    sourceRow: row.sourceRow,
    rawJson: row.rawJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeIdentifier(value: unknown) {
  return cellText(value).replace(/\.0$/, "");
}

function isLikelyProductIdentifier(value: unknown) {
  const candidate = normalizeIdentifier(value);
  return /^\d{5,}$/.test(candidate) || /^[A-Z]{1,4}-/.test(candidate) || /^A\d[A-Z0-9]+/.test(candidate) || /^KY\d+/.test(candidate);
}

function quantityFromCell(value: unknown) {
  const match = cellText(value).match(/(\d+(?:\.\d+)?)\s*(?:个|支|件|瓶|片)?/);
  if (!match) return 1;
  const quantity = Number(match[1]);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function bundleRawHeaders() {
  return ["品名", "规格", "套盒条码", "组件编码1", "组件备注1", "合同价", "组件编码2", "组件备注2", "组件名称2", "组件价格2", "组件编码3", "组件备注3"];
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

async function loadVipStoreIndex(database: DatabaseContext): Promise<VipStoreIndex> {
  const rows = await database.db.select().from(storeAddresses).where(eq(storeAddresses.isVip, 1));
  return {
    byStoreNo: new Set(rows.map((row) => row.storeNo).filter(Boolean)),
    byStoreName: new Set(rows.map((row) => normalizeStoreName(row.storeName)).filter(Boolean)),
  };
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
          isVip: Boolean(existing.isVip),
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
      isVip: Boolean(existing?.isVip),
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
  if (next.sourcePriority < current.sourcePriority || (next.sourcePriority === current.sourcePriority && next.sourceOrder > current.sourceOrder)) {
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
        sourcePriority: storeAddressSheetPriority(sheetName, sheetIndex),
        sourceOrder: sourceOrder += 1,
        sourceRow: rowIndex + 1,
        rawFields: rawFieldsForRow(headerLabels, row),
      });
      parsedSheetNames.add(sheetName);
    }
  }

  return { addresses, sheetCount: parsedSheetNames.size, skippedRowCount };
}

function storeAddressSheetPriority(sheetName: string, sheetIndex: number) {
  const normalizedSheetName = normalizeHeader(sheetName);
  if (normalizedSheetName.includes("ole门店兼职收货人") || normalizedSheetName.includes("仓库发货主要用的")) return 0;
  if (normalizedSheetName.includes("2025.6.3经理新表") || normalizedSheetName.includes("经理新表主要")) return 1;
  return 2 + sheetIndex;
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
    .replace(/^(ole|olé|blt)/g, "")
    .replace(/精品超市/g, "")
    .replace(/超市/g, "")
    .replace(/店$/g, "");
}

function normalizeStoreNameLegacy(value: unknown) {
  return cellText(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）]/g, "")
    .replace(/精品超市/g, "")
    .replace(/超市/g, "")
    .replace(/店$/g, "");
}

function legacyCompatibleStoreNameKeys(normalizedStoreName: string) {
  const keys = new Set<string>();
  if (normalizedStoreName) keys.add(normalizedStoreName);
  for (const prefix of ["ole", "olé", "blt"]) {
    const legacyKey = normalizeStoreNameLegacy(`${prefix}${normalizedStoreName}`);
    if (legacyKey) keys.add(legacyKey);
  }
  return [...keys];
}

function cellText(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function parseNumberCell(value: unknown) {
  const text = cellText(value).replaceAll(",", "");
  return text ? Number(text) : 0;
}

function sheetNameFor(type: ExportDto["type"]) {
  if (type === "confirmed") return "confirmed";
  if (type === "wdt_import") return WDT_IMPORT_SHEET_NAME;
  return "review";
}
