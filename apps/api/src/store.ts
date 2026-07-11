import type {
  ApplyProductMappingRequest,
  ApplyProductMappingResponse,
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
  RebuildConfirmedOrderRequest,
  RunRealReviewRequest,
  ReviewDecisionDto,
  ReviewLineDto,
  SubmitReviewRequest,
  SubmitReviewResultDto,
  SubmitReviewResponseDto,
  CreateWdtGoodsSyncRunRequest,
  StoreAddressDto,
  StoreAddressImportPreviewItem,
  UpdateWarehouseUsageSettingsRequest,
  UpdateWdtSyncSettingsRequest,
  UpdateBatchStoreFieldsRequest,
  UpdateBatchStoreFieldsResponse,
  UpdateReviewLinePriorityRequest,
  UpdateProductMappingStatusRequest,
  UpsertStoreAddressRequest,
  WarehouseUsageSettingsDto,
  WarehouseSnapshotType,
  WdtAutoSyncIntervalHours,
  WdtSyncSettingsDto,
  WdtGoodsSpecSearchResultDto,
  WdtGoodsSyncRunDto,
  WdtSyncRunDto,
  StartWdtSyncResponseDto,
} from "@jy-trade/shared";
import { buildMockReview } from "@jy-trade/workflow";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
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
  wdtSyncSettings,
  wdtGoodsSpecs,
  wdtGoodsSyncRuns,
  wdtSyncRuns,
  wdtStockSnapshotSpecs,
  wdtStockSnapshotRows,
  wdtStockSnapshotWarehouseCoverage,
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
import { startCombinedSync, type CombinedSyncRepository, type StockSyncScope } from "./wdtCombinedSync.js";
import {
  createLocalProductMatcher,
  decideLocalProductMatch,
  loadOrderLines,
  type LocalGoodsSpecCandidate,
  type LocalSuiteCandidate,
  type ProductMappingCandidate,
  type ProductMatchInput,
  type ProductMatchDecision,
} from "@jy-trade/workflow";
import { effectiveWdtAvailableSendStock, getWdtAvailableSendStock, type WdtStockResponse, type WdtStockRow } from "../../../backend/src/integrations/wdtClient.js";

type BatchRow = typeof batches.$inferSelect;
type ReviewLineRow = typeof reviewLines.$inferSelect;
type ReviewDecisionRow = typeof reviewDecisions.$inferSelect;
type ExportRow = typeof exportsTable.$inferSelect;
type UserRow = typeof users.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;
type StoreAddressRow = typeof storeAddresses.$inferSelect;
type WarehouseUsageSettingsRow = typeof warehouseUsageSettings.$inferSelect;
type WdtSyncSettingsRow = typeof wdtSyncSettings.$inferSelect;
type WdtGoodsSyncRunRow = typeof wdtGoodsSyncRuns.$inferSelect;
type WdtGoodsSpecRow = typeof wdtGoodsSpecs.$inferSelect;
type WdtSyncRunRow = typeof wdtSyncRuns.$inferSelect;
type WdtSuiteRow = typeof wdtSuites.$inferSelect;
type WdtSuiteComponentRow = typeof wdtSuiteComponents.$inferSelect;
type ProductMappingRow = typeof productMappings.$inferSelect;
type ProductMatchCandidateRow = typeof productMatchCandidates.$inferSelect;
type ExternalProductRow = typeof externalProducts.$inferSelect;
type ExternalProductComponentRow = typeof externalProductComponents.$inferSelect;

export interface StockLookupClient {
  queryStock(specNo: string, warehouseNo?: string): Promise<WdtStockResponse>;
  queryStocks?(specNos: string[], warehouseNo?: string): Promise<WdtStockResponse>;
}

interface WarehouseStockSummary {
  mainAvailableStock: number;
  nearExpiryAvailableStock: number;
  defectAvailableStock: number;
  otherAvailableStock: number;
  usableAvailableStock: number;
  warehouseBreakdown: string;
  warehouses: WarehouseStockCandidate[];
}

interface WarehouseStockCandidate {
  warehouseNo: string;
  warehouseName: string;
  availableStock: number;
  type: WarehouseStockType;
}

interface LocalStockSnapshot {
  runId: string;
  syncedAt: string;
  stockBySpecNo: Map<string, WarehouseStockSummary>;
  verifiedSpecNos: Set<string>;
  warehouseTypes: Set<WarehouseSnapshotType>;
  missingWarehouseTypes: WarehouseSnapshotType[];
}

interface ReviewAllocation {
  quantity: number;
  warehouseNo: string;
  warehouseName: string;
}

interface ReviewAllocationInput {
  id: string;
  specNo: string;
  demandQty: number;
  storeNo: string;
  storeName: string;
  stock: WarehouseStockSummary | undefined;
}

const HOUR_MS = 60 * 60 * 1_000;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1_000;

export interface StoreOptions {
  databaseUrl?: string;
  projectRoot?: string;
  wdtGoodsClient?: WdtGoodsWindowClient;
  stockClient?: StockLookupClient;
  autoSyncEnabled?: boolean;
}

export class StoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreValidationError";
  }
}

export function createSqliteStore(options: StoreOptions = {}) {
  const bootstrapUsers = resolveBootstrapUsers();
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
  const ready = prepareDatabase(database, bootstrapUsers);
  const goodsSyncRepository = createGoodsSyncRepository(database);
  const combinedSyncRepository = createCombinedSyncRepository(database, goodsSyncRepository, wdtGoodsClient);
  let activeSyncTask: Promise<void> | undefined;
  let autoSyncTimer: ReturnType<typeof setTimeout> | undefined;
  let schedulerVersion = 0;
  let syncStartQueue: Promise<void> = Promise.resolve();
  let schedulerStarted = false;
  let closed = false;
  const autoSyncEnabled = options.autoSyncEnabled ?? (process.env.NODE_ENV !== "test" && process.env.WDT_AUTO_SYNC_ENABLED !== "false");

  const enqueueSync = async (trigger: WdtSyncRunDto["trigger"], actor?: AuthUserDto): Promise<StartWdtSyncResponseDto> => {
    await ready;
    let releaseStart!: () => void;
    const previousStart = syncStartQueue;
    syncStartQueue = new Promise<void>((resolve) => { releaseStart = resolve; });
    await previousStart;
    try {
      if (closed) throw new StoreValidationError("服务正在关闭，不能启动新的同步任务");
      if (!wdtGoodsClient || !stockClient) throw new StoreValidationError("WDT商品或库存同步客户端未配置");
      const started = await startCombinedSync(combinedSyncRepository, stockClient, trigger);
      if (started.task) {
        const trackedTask = started.task.catch(() => undefined).finally(() => {
          if (activeSyncTask === trackedTask) activeSyncTask = undefined;
        });
        activeSyncTask = trackedTask;
        void trackedTask;
      }
      await insertAuditLog(database, actor?.id ?? null, started.alreadyRunning ? "wdt.sync.reused" : "wdt.sync.started", "wdt_sync_run", started.run.id, { trigger });
      return { run: started.run, alreadyRunning: started.alreadyRunning };
    } finally {
      releaseStart();
    }
  };

  const scheduleNextAutoSync = async () => {
    const version = ++schedulerVersion;
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    autoSyncTimer = undefined;
    if (!schedulerStarted || closed || !autoSyncEnabled || !wdtGoodsClient || !stockClient) return;
    const settings = await getWdtSyncSettingsRow(database);
    if (version !== schedulerVersion || closed) return;
    const delay = millisecondsUntilNextShanghaiSyncBoundary(Date.now(), normalizeSyncIntervalHours(settings.intervalHours));
    autoSyncTimer = setTimeout(() => {
      if (version !== schedulerVersion || closed) return;
      void enqueueSync("hourly").catch(() => undefined).finally(() => {
        if (version === schedulerVersion) void scheduleNextAutoSync();
      });
    }, delay);
  };

  return {
    ready,

    async startWdtSync(trigger: WdtSyncRunDto["trigger"] = "manual", actor?: AuthUserDto) {
      return enqueueSync(trigger, actor);
    },

    async listWdtSyncRuns(): Promise<WdtSyncRunDto[]> {
      await ready;
      const rows = await database.db.select().from(wdtSyncRuns).orderBy(desc(wdtSyncRuns.startedAt)).limit(30);
      return Promise.all(rows.map((row) => toWdtSyncRunDto(database, row)));
    },

    async getLatestWdtSyncRun(): Promise<WdtSyncRunDto | undefined> {
      await ready;
      const [row] = await database.db.select().from(wdtSyncRuns).orderBy(desc(wdtSyncRuns.startedAt)).limit(1);
      return row ? toWdtSyncRunDto(database, row) : undefined;
    },

    async startAutoSyncScheduler() {
      await ready;
      if (schedulerStarted || closed) return;
      schedulerStarted = true;
      await recoverInterruptedSyncRuns(database);
      if (!autoSyncEnabled || !wdtGoodsClient || !stockClient) return;
      const settings = await getWdtSyncSettingsRow(database);
      const maximumAgeMs = normalizeSyncIntervalHours(settings.intervalHours) * HOUR_MS;
      const latest = await getLatestSuccessfulWdtSyncRun(database);
      if (!latest || snapshotIsOlderThan(latest.finishedAt, Date.now(), maximumAgeMs)) {
        void enqueueSync("startup").catch(() => undefined);
      }
      await scheduleNextAutoSync();
    },

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
        stockSnapshotRunId: "",
        stockSnapshotAt: "",
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
      const cacheStatus = await getGoodsCacheStatus(database, Boolean(input.allowStaleCache));
      assertReviewGoodsCacheUsable(cacheStatus);

      const goodsSpecs = (await database.db.select().from(wdtGoodsSpecs)).map(toLocalGoodsSpecCandidate);
      const suites = await loadLocalSuiteCandidates(database);
      const mappings = (await database.db.select().from(productMappings).where(eq(productMappings.status, "confirmed"))).map(toProductMappingCandidate);
      const warehouseSettings = toWarehouseUsageSettingsDto(await getWarehouseUsageSettingsRow(database));
      const vipStoreIndex = await loadVipStoreIndex(database);
      const stockSnapshot = await loadActiveStockSnapshot(database, warehouseSettings);
      const result = await buildRealReview({
        batchId,
        orderFile: batch.filePath,
        goodsSpecs,
        suites,
        mappings,
        warehouseSettings,
        vipStoreIndex,
        stockSnapshot,
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
        stockSnapshotRunId: stockSnapshot?.runId ?? "",
        stockSnapshotAt: stockSnapshot?.syncedAt ?? "",
        updatedAt: now,
      };
      await database.db
        .update(batches)
        .set({
          status: updatedBatch.status,
          orderLineCount: updatedBatch.orderLineCount,
          uniqueBarcodeCount: updatedBatch.uniqueBarcodeCount,
          matchedBarcodeCount: updatedBatch.matchedBarcodeCount,
          stockSnapshotRunId: updatedBatch.stockSnapshotRunId,
          stockSnapshotAt: updatedBatch.stockSnapshotAt,
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
      const vipStoreIndex = await loadVipStoreIndex(database);
      const stockSnapshot = await loadActiveStockSnapshot(database, warehouseSettings);
      const buildResult = await buildConfirmedOrderReview({
        batchId: `batch-${randomUUID()}`,
        lines: parsed.lines,
        goodsSpecs,
        suites,
        mappings,
        externalProductMatches,
        stockSnapshot,
        warehouseSettings,
        vipStoreIndex,
      });
      const batch: BatchRow = {
        id: buildResult.batchId,
        filePath,
        fileName: input.fileName.split(/[\\/]/).at(-1) ?? input.fileName,
        mode: "production_api",
        sourceType: "confirmed_order",
        status: "review_generated",
        orderLineCount: parsed.lines.length,
        uniqueBarcodeCount: new Set(parsed.lines.map((line) => line.externalBarcode).filter(Boolean)).size,
        matchedBarcodeCount: new Set(buildResult.reviewLines.filter((line) => line.matchStatus === "matched").map((line) => line.externalBarcode).filter(Boolean)).size,
        stockSnapshotRunId: stockSnapshot?.runId ?? "",
        stockSnapshotAt: stockSnapshot?.syncedAt ?? "",
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

    async rebuildConfirmedOrder(
      batchId: string,
      input: RebuildConfirmedOrderRequest,
      actor?: AuthUserDto,
    ): Promise<ImportConfirmedOrderResponse | undefined> {
      await ready;
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;
      if (batch.sourceType !== "confirmed_order") {
        throw new StoreValidationError("当前批次不是确定单批次，不能使用确定单重新校验");
      }

      return rebuildConfirmedOrderBatch(database, batch, input, actor);
    },

    async applyProductMapping(
      batchId: string,
      input: ApplyProductMappingRequest,
      actor?: AuthUserDto,
    ): Promise<ApplyProductMappingResponse | undefined> {
      await ready;
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;
      if (batch.sourceType !== "confirmed_order") {
        throw new StoreValidationError("当前批次不是确定单批次，不能应用确定单商品映射");
      }
      return applyProductMappingToConfirmedOrder(database, batch, input, actor);
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

    async getWdtSyncSettings(): Promise<WdtSyncSettingsDto> {
      await ready;
      return toWdtSyncSettingsDto(await getWdtSyncSettingsRow(database), autoSyncEnabled);
    },

    async updateWdtSyncSettings(input: UpdateWdtSyncSettingsRequest, actor?: AuthUserDto): Promise<WdtSyncSettingsDto> {
      await ready;
      const previous = await getWdtSyncSettingsRow(database);
      const now = new Date().toISOString();
      const row: WdtSyncSettingsRow = {
        id: "default",
        intervalHours: input.intervalHours,
        updatedByUserId: actor?.id ?? null,
        updatedByUsername: actor?.username ?? null,
        updatedAt: now,
      };
      await database.db.insert(wdtSyncSettings).values(row).onConflictDoUpdate({
        target: wdtSyncSettings.id,
        set: {
          intervalHours: row.intervalHours,
          updatedByUserId: row.updatedByUserId,
          updatedByUsername: row.updatedByUsername,
          updatedAt: row.updatedAt,
        },
      });
      await insertAuditLog(database, actor?.id ?? null, "settings.update_wdt_sync", "settings", "wdt_sync", {
        previous: toWdtSyncSettingsDto(previous, autoSyncEnabled),
        next: toWdtSyncSettingsDto(row, autoSyncEnabled),
      });
      await scheduleNextAutoSync();
      return toWdtSyncSettingsDto(row, autoSyncEnabled);
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
              fulfillmentWarehouseNo: previousDecision.fulfillmentWarehouseNo,
              fulfillmentWarehouseName: previousDecision.fulfillmentWarehouseName,
              reason: previousDecision.reason,
            }
          : null,
        next: {
          decision: nextDecision.decision,
          approvedShipQty: nextDecision.approvedShipQty,
          fulfillmentWarehouseNo: nextDecision.fulfillmentWarehouseNo,
          fulfillmentWarehouseName: nextDecision.fulfillmentWarehouseName,
          reason: nextDecision.reason,
        },
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
          {
            decision: "ship",
            approvedShipQty: line.suggestedShipQty,
            fulfillmentWarehouseNo: line.suggestedWarehouseNo,
            fulfillmentWarehouseName: line.suggestedWarehouseName,
            reason: "",
          },
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

    async submitReview(
      batchId: string,
      input: SubmitReviewRequest = { confirmUnverifiedStock: false },
      actor?: AuthUserDto,
    ): Promise<SubmitReviewResultDto | undefined> {
      await ready;
      const batch = await getBatchRow(database, batchId);
      if (!batch) return undefined;

      const lines = await getReviewLineDtos(database, batchId);
      const shippableLines = lines.filter((line) => line.approvedShipQty > 0);
      const invalidQuantityCount = lines.filter((line) => !Number.isInteger(line.approvedShipQty) || line.approvedShipQty < 0).length;
      if (invalidQuantityCount > 0) {
        throw new StoreValidationError(`还有 ${invalidQuantityCount} 条发货明细的最终数量不是非负整数`);
      }
      const missingMappingCount = shippableLines.filter(
        (line) => line.matchStatus !== "matched" || !(line.wdtMakeOrderCode || line.wdtSpecNo),
      ).length;
      if (missingMappingCount > 0) {
        throw new StoreValidationError(`还有 ${missingMappingCount} 条发货明细没有有效商品映射`);
      }
      const warehouseSettings = toWarehouseUsageSettingsDto(await getWarehouseUsageSettingsRow(database));
      const missingWarehouseCount = shippableLines.filter((line) => !hasFulfillmentWarehouse(line)).length;
      if (missingWarehouseCount > 0) {
        throw new StoreValidationError(`还有 ${missingWarehouseCount} 条发货明细未选择仓库`);
      }
      const invalidWarehouseCount = shippableLines.filter(
        (line) => !isWarehouseEnabled(line.fulfillmentWarehouseNo, line.fulfillmentWarehouseName, warehouseSettings),
      ).length;
      if (invalidWarehouseCount > 0) {
        throw new StoreValidationError(`还有 ${invalidWarehouseCount} 条发货明细选择了当前未启用的仓库`);
      }
      const unverifiedStockCount = shippableLines.filter((line) => Boolean(line.stockErrorDetail?.trim())).length;
      if (unverifiedStockCount > 0 && !input.confirmUnverifiedStock) {
        return {
          requiresConfirmation: true,
          code: "UNVERIFIED_STOCK",
          affectedCount: unverifiedStockCount,
          message: `有 ${unverifiedStockCount} 条明细未完成库存校验，当前结果依赖人工决定`,
        };
      }
      const now = new Date().toISOString();
      const nextBatch: BatchRow = { ...batch, status: "reviewed", updatedAt: now };
      await database.db.update(batches).set({ status: "reviewed", updatedAt: now }).where(eq(batches.id, batchId));
      const pendingCount = lines.filter((line) => line.decision === "pending").length;
      const shipCount = lines.filter((line) => line.decision === "ship").length;
      const doNotShipCount = lines.filter((line) => line.decision === "do_not_ship").length;

      await insertAuditLog(database, actor?.id ?? null, "batch.submit_review", "batch", batchId, {
        pendingCount,
        shipCount,
        doNotShipCount,
        unverifiedStockCount,
        confirmedUnverifiedStock: input.confirmUnverifiedStock,
      });

      return {
        requiresConfirmation: false,
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
      if (batch.status !== "reviewed" && batch.status !== "exported") {
        throw new StoreValidationError("当前批次还没有提交审核，不能生成导出文件");
      }
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
      const goodsRows = await database.db
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
      const suiteRows = (await loadLocalSuiteCandidates(database))
        .filter((suite) => suiteMatchesSearchQuery(suite, trimmed))
        .map(toSuiteSearchResultDto);
      const rows = dedupeWdtSearchResults([...goodsRows.map(toWdtGoodsSpecSearchResultDto), ...suiteRows])
        .sort((left, right) => compareWdtSearchResults(left, right, trimmed))
        .slice(0, 30);
      return attachWdtGoodsSpecSearchStock(rows, database);
    },

    async confirmProductMapping(input: ConfirmProductMappingRequest, actor?: AuthUserDto): Promise<ProductMappingDto> {
      await ready;
      const target = await findProductMappingTarget(database, input.wdtSpecNo, input.wdtMakeOrderCode);
      if (!target) {
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
        wdtGoodsNo: target.goodsNo,
        wdtGoodsName: target.goodsName,
        wdtSpecNo: target.specNo,
        wdtSpecName: target.specName,
        wdtBarcode: target.barcode,
        wdtMakeOrderCode: target.makeOrderCode || target.specNo,
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
      return (await attachProductCandidateStock(candidates, database)).sort(compareProductMatchCandidates);
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
      closed = true;
      schedulerVersion += 1;
      if (autoSyncTimer) clearTimeout(autoSyncTimer);
      await ready.catch(() => undefined);
      await syncStartQueue.catch(() => undefined);
      await activeSyncTask?.catch(() => undefined);
      await database.close();
    },
  };
}

type BootstrapUser = {
  username: string;
  password: string;
  role: AuthUserDto["role"];
  syncExistingPassword?: boolean;
};

function resolveBootstrapUsers(): BootstrapUser[] {
  const username = process.env.JY_TRADE_BOOTSTRAP_USERNAME?.trim() || "admin";
  const configuredPassword = process.env.JY_TRADE_BOOTSTRAP_PASSWORD?.trim();

  if (process.env.NODE_ENV === "production") {
    return [{ username, password: configuredPassword || "yjmy", role: "admin", syncExistingPassword: true }];
  }

  return [
    { username, password: configuredPassword || "yjmy", role: "admin" },
    { username: "operator", password: "operator123", role: "operator" },
    { username: "reviewer", password: "reviewer123", role: "reviewer" },
  ];
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

async function getWdtSyncSettingsRow(database: DatabaseContext): Promise<WdtSyncSettingsRow> {
  const [row] = await database.db.select().from(wdtSyncSettings).where(eq(wdtSyncSettings.id, "default")).limit(1);
  if (row) return row;
  const defaultRow: WdtSyncSettingsRow = {
    id: "default",
    intervalHours: 1,
    updatedByUserId: null,
    updatedByUsername: null,
    updatedAt: new Date().toISOString(),
  };
  await database.db.insert(wdtSyncSettings).values(defaultRow);
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
  stockSnapshot?: LocalStockSnapshot;
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

interface ConfirmedOrderMatchedInput {
  line: ParsedConfirmedOrderLine;
  id: string;
  decision: ProductMatchDecision;
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
    if (!Number.isFinite(shipQty) || shipQty < 0) {
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
  stockSnapshot?: LocalStockSnapshot;
  warehouseSettings: WarehouseUsageSettingsDto;
  vipStoreIndex: VipStoreIndex;
  matchedInputs?: ConfirmedOrderMatchedInput[];
}): Promise<ConfirmedOrderReviewBuildResult> {
  const reviewLines: ReviewLineDto[] = [];
  const candidateRows: RealReviewCandidateRow[] = [];
  const matchedInputs = options.matchedInputs ?? prepareConfirmedOrderMatches(options);
  const specNos = matchedInputs.map((input) => input.decision.candidate?.specNo ?? "").filter(Boolean);
  const stockLookup = stockLookupFromSnapshot(specNos, options.stockSnapshot);
  const allocationInputs: ReviewAllocationInput[] = matchedInputs.map((input) => {
    const specNo = input.decision.status === "matched" ? input.decision.candidate?.specNo ?? "" : "";
    return {
      id: input.id,
      specNo,
      demandQty: input.line.shipQty,
      storeNo: input.line.storeNo,
      storeName: input.line.storeName,
      stock: specNo ? stockLookup.stockBySpecNo.get(specNo) : undefined,
    };
  });
  const allocations = allocateReviewShipQuantities(allocationInputs, options.warehouseSettings, options.vipStoreIndex);

  for (const { line, id, decision } of matchedInputs) {
    if (decision.status === "ambiguous") {
      candidateRows.push(...toRealReviewCandidateRows(id, confirmedLineToCandidateOrderLine(line), decision));
    }
    const matched = decision.status === "matched";
    const specNo = matched ? decision.candidate?.specNo ?? "" : "";
    const stock = specNo ? stockLookup.stockBySpecNo.get(specNo) : undefined;
    const stockError = specNo ? stockLookup.stockErrorsBySpecNo.get(specNo) : undefined;
    const allocation = allocations.get(id);
    const suggestedShipQty = allocation?.quantity ?? 0;
    const status = confirmedOrderStatusFor(decision.status, line.shipQty, suggestedShipQty, stockError);
    const systemMessage = confirmedOrderSystemMessageFor({ matched, plannedShipQty: line.shipQty, suggestedShipQty, stockError });
    const reviewDecision: ReviewLineDto["decision"] = line.shipQty === 0 ? "do_not_ship" : suggestedShipQty > 0 ? "ship" : "pending";
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
      plannedShipQty: line.shipQty,
      mainAvailableBefore: stock?.mainAvailableStock ?? 0,
      nearExpiryAvailableBefore: stock?.nearExpiryAvailableStock ?? 0,
      suggestedShipQty,
      suggestedWarehouseNo: allocation?.warehouseNo ?? "",
      suggestedWarehouseName: allocation?.warehouseName ?? "",
      status,
      decision: reviewDecision,
      approvedShipQty: reviewDecision === "ship" ? suggestedShipQty : 0,
      fulfillmentWarehouseNo: reviewDecision === "ship" ? allocation?.warehouseNo ?? "" : "",
      fulfillmentWarehouseName: reviewDecision === "ship" ? allocation?.warehouseName ?? "" : "",
      reason: "",
      priority: false,
      priorityReason: "",
    });
  }

  return { batchId: options.batchId, reviewLines, candidateRows, stockQueriedCount: stockLookup.stockQueriedCount };
}

function prepareConfirmedOrderMatches(options: {
  batchId: string;
  lines: ParsedConfirmedOrderLine[];
  goodsSpecs: LocalGoodsSpecCandidate[];
  suites: LocalSuiteCandidate[];
  mappings: ProductMappingCandidate[];
  externalProductMatches: ExternalProductMatchCandidate[];
}): ConfirmedOrderMatchedInput[] {
  const matchLocalProduct = createLocalProductMatcher({
    goodsSpecs: options.goodsSpecs,
    suites: options.suites,
    mappings: options.mappings,
  });
  return options.lines.map((line, index) => ({
    line,
    id: `${options.batchId}-line-${index + 1}`,
    decision: decideConfirmedOrderProductMatch(line, options, matchLocalProduct),
  }));
}

function confirmedOrderStatusFor(
  matchStatus: ReviewLineDto["matchStatus"],
  plannedShipQty: number,
  suggestedShipQty: number,
  stockError: StockLookupError | undefined,
): ReviewLineDto["status"] {
  if (matchStatus !== "matched") return "未匹配";
  if (stockError) return "库存未验证";
  if (suggestedShipQty >= plannedShipQty) return "库存充足";
  if (suggestedShipQty > 0) return "部分满足";
  return "库存不足";
}

function confirmedOrderSystemMessageFor(options: {
  matched: boolean;
  plannedShipQty: number;
  suggestedShipQty: number;
  stockError: StockLookupError | undefined;
}) {
  if (!options.matched) return "确定单导入时商品未匹配，需补充商品映射";
  if (options.stockError) return options.stockError.userMessage;
  if (options.suggestedShipQty >= options.plannedShipQty) return "";
  return `确定单计划发货 ${options.plannedShipQty}，系统按当前库存建议 ${options.suggestedShipQty}`;
}

function decideConfirmedOrderProductMatch(
  line: ParsedConfirmedOrderLine,
  sources: Pick<ConfirmedOrderReviewBuildResult, never> & {
    goodsSpecs: LocalGoodsSpecCandidate[];
    suites: LocalSuiteCandidate[];
    mappings: ProductMappingCandidate[];
    externalProductMatches: ExternalProductMatchCandidate[];
  },
  matchLocalProduct: (input: ProductMatchInput) => ProductMatchDecision,
): ProductMatchDecision {
  const input = {
    barcode: line.externalBarcode,
    goodsCode: line.externalGoodsCode,
    goodsName: line.externalGoodsName,
    specName: line.spec,
  };
  const direct = matchLocalProduct(input);
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

async function buildRealReview(options: RealReviewBuildOptions): Promise<RealReviewBuildResult> {
  const orderLines = loadOrderLines(options.orderFile);
  const lineInputs: RealReviewLineInput[] = [];
  const candidateRows: RealReviewCandidateRow[] = [];
  const matchLocalProduct = createLocalProductMatcher({
    goodsSpecs: options.goodsSpecs,
    suites: options.suites,
    mappings: options.mappings,
  });
  let stockQueriedCount = 0;

  for (const [index, line] of orderLines.entries()) {
    const decision = matchLocalProduct({
      barcode: line.externalBarcode,
      goodsCode: line.externalGoodsCode,
      goodsName: line.externalGoodsName,
      specName: line.spec,
    });

    const id = `${options.batchId}-line-${index + 1}`;
    let stock: WarehouseStockSummary | undefined;
    let matchStatus: ReviewLineDto["matchStatus"] = decision.status;
    let matchMessage = decision.message;
    const specNo = decision.candidate?.specNo ?? "";

    if (decision.status === "matched" && specNo) {
      stock = options.stockSnapshot?.stockBySpecNo.get(specNo);
      if (!options.stockSnapshot?.verifiedSpecNos.has(specNo)) {
        matchMessage = [matchMessage, "本地库存快照未覆盖该商品，请人工确认"].filter(Boolean).join("；");
      } else stockQueriedCount += 1;
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

  const allocations = allocateReviewShipQuantities(
    lineInputs.map((input) => ({
      id: input.id,
      specNo: input.matchStatus === "matched" ? input.decision.candidate?.specNo ?? "" : "",
      demandQty: input.orderLine.orderQty,
      storeNo: input.orderLine.storeNo,
      storeName: input.orderLine.storeName,
      stock: input.stock,
    })),
    options.warehouseSettings,
    options.vipStoreIndex,
  );
  const reviewLines = lineInputs.map((input) => buildRealReviewLine(input, allocations.get(input.id), Boolean(
    input.decision.candidate?.specNo && options.stockSnapshot?.verifiedSpecNos.has(input.decision.candidate.specNo),
  )));

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

function buildRealReviewLine(input: RealReviewLineInput, allocation?: ReviewAllocation, stockVerified = true): ReviewLineDto {
  const suggestedShipQty = allocation?.quantity ?? 0;
  const specNo = input.matchStatus === "matched" ? input.decision.candidate?.specNo ?? "" : "";
  const makeOrderCode = input.matchStatus === "matched" ? input.decision.candidate?.makeOrderCode ?? specNo : "";
  const mainBefore = input.stock?.mainAvailableStock ?? 0;
  const nearExpiryBefore = input.stock?.nearExpiryAvailableStock ?? 0;

  const status = input.matchStatus === "matched" && !stockVerified
    ? "库存未验证"
    : reviewStatusFor(input.matchStatus, input.orderLine.orderQty, suggestedShipQty);
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
    stockErrorDetail: stockVerified ? "" : "LOCAL_STOCK_SNAPSHOT_MISSING",
    orderQty: input.orderLine.orderQty,
    plannedShipQty: input.orderLine.orderQty,
    mainAvailableBefore: mainBefore,
    nearExpiryAvailableBefore: nearExpiryBefore,
    suggestedShipQty,
    suggestedWarehouseNo: allocation?.warehouseNo ?? "",
    suggestedWarehouseName: allocation?.warehouseName ?? "",
    status,
    decision,
    approvedShipQty: decision === "ship" ? suggestedShipQty : 0,
    fulfillmentWarehouseNo: decision === "ship" ? allocation?.warehouseNo ?? "" : "",
    fulfillmentWarehouseName: decision === "ship" ? allocation?.warehouseName ?? "" : "",
    reason: "",
    priority: false,
    priorityReason: "",
  };
}

function allocateReviewShipQuantities(
  inputs: ReviewAllocationInput[],
  warehouseSettings: WarehouseUsageSettingsDto,
  vipStoreIndex: VipStoreIndex,
): Map<string, ReviewAllocation> {
  const allocations = new Map<string, ReviewAllocation>();
  const matchedBySpecNo = new Map<string, ReviewAllocationInput[]>();
  for (const input of inputs) {
    if (!input.specNo || !input.stock || input.demandQty <= 0) continue;
    const rows = matchedBySpecNo.get(input.specNo) ?? [];
    rows.push(input);
    matchedBySpecNo.set(input.specNo, rows);
  }

  for (const rows of matchedBySpecNo.values()) {
    const stock = rows[0]?.stock;
    if (!stock) continue;
    let remainingAvailable = usableStockForSettings(stock, warehouseSettings);
    const vipRows = rows.filter((row) => isVipReviewLine(row, vipStoreIndex));
    const regularRows = rows.filter((row) => !isVipReviewLine(row, vipStoreIndex));

    const desiredAllocations = new Map<string, number>();
    const vipAllocations = allocateFairlyByDemand(vipRows, remainingAvailable);
    for (const [id, quantity] of vipAllocations) {
      desiredAllocations.set(id, quantity);
      remainingAvailable -= quantity;
    }

    const regularAllocations = allocateFairlyByDemand(regularRows, remainingAvailable);
    for (const [id, quantity] of regularAllocations) {
      desiredAllocations.set(id, quantity);
    }

    const remainingByWarehouse = stock.warehouses.map((warehouse) => ({ ...warehouse }));
    const allocationOrder = [...vipRows, ...regularRows];
    for (const row of allocationOrder) {
      const desiredQuantity = desiredAllocations.get(row.id) ?? 0;
      if (desiredQuantity <= 0) continue;
      const warehouse = selectFulfillmentWarehouse(remainingByWarehouse, row.demandQty);
      if (!warehouse) continue;
      const quantity = Math.min(desiredQuantity, warehouse.availableStock);
      if (quantity <= 0) continue;
      warehouse.availableStock -= quantity;
      allocations.set(row.id, {
        quantity,
        warehouseNo: warehouse.warehouseNo,
        warehouseName: warehouse.warehouseName,
      });
    }
  }

  return allocations;
}

function selectFulfillmentWarehouse(warehouses: WarehouseStockCandidate[], orderQty: number) {
  const available = warehouses.filter((warehouse) => warehouse.availableStock > 0);
  const satisfying = available.filter((warehouse) => warehouse.availableStock >= orderQty).sort(compareWarehouseCandidates);
  if (satisfying.length > 0) return satisfying[0];
  return [...available].sort((left, right) => right.availableStock - left.availableStock || compareWarehouseCandidates(left, right))[0];
}

function allocateFairlyByDemand(rows: ReviewAllocationInput[], available: number): Map<string, number> {
  const allocations = new Map(rows.map((row) => [row.id, 0]));
  let remainingAvailable = Math.max(0, Math.floor(available));
  let activeRows = rows.filter((row) => row.demandQty > 0);

  while (remainingAvailable > 0 && activeRows.length > 0) {
    const share = Math.floor(remainingAvailable / activeRows.length);
    const extraCount = remainingAvailable % activeRows.length;
    let consumed = 0;
    const nextRows: ReviewAllocationInput[] = [];

    for (const [index, row] of activeRows.entries()) {
      const current = allocations.get(row.id) ?? 0;
      const remainingDemand = Math.max(0, row.demandQty - current);
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

function isVipReviewLine(input: ReviewAllocationInput, vipStoreIndex: VipStoreIndex): boolean {
  return Boolean(
    (input.storeNo && vipStoreIndex.byStoreNo.has(input.storeNo))
      || (input.storeName && vipStoreIndex.byStoreName.has(normalizeStoreName(input.storeName))),
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

async function rebuildConfirmedOrderBatch(
  database: DatabaseContext,
  batch: BatchRow,
  input: RebuildConfirmedOrderRequest,
  actor?: AuthUserDto,
): Promise<ImportConfirmedOrderResponse> {
  const parsed = parseConfirmedOrderWorkbook(await readFile(batch.filePath));
  if (parsed.lines.length === 0) throw new StoreValidationError("确定单中没有可导入的发货明细");

  const [goodsRows, suites, mappingRows, externalProductMatches, warehouseSettingsRow, vipStoreIndex, previousLines, previousDecisions] = await Promise.all([
    database.db.select().from(wdtGoodsSpecs),
    loadLocalSuiteCandidates(database),
    database.db.select().from(productMappings).where(eq(productMappings.status, "confirmed")),
    loadExternalProductMatchIndex(database),
    getWarehouseUsageSettingsRow(database),
    loadVipStoreIndex(database),
    getReviewLineDtos(database, batch.id),
    database.db.select().from(reviewDecisions).where(eq(reviewDecisions.batchId, batch.id)),
  ]);
  const goodsSpecs = goodsRows.map(toLocalGoodsSpecCandidate);
  const mappings = mappingRows.map(toProductMappingCandidate);
  const warehouseSettings = toWarehouseUsageSettingsDto(warehouseSettingsRow);
  const matchedInputs = prepareConfirmedOrderMatches({
    batchId: batch.id,
    lines: parsed.lines,
    goodsSpecs,
    suites,
    mappings,
    externalProductMatches,
  });
  const matchedSpecNos = matchedInputs.map((item) => item.decision.candidate?.specNo ?? "").filter(Boolean);
  const stockSnapshot = await loadActiveStockSnapshot(database, warehouseSettings, { specNos: matchedSpecNos });
  const buildResult = await buildConfirmedOrderReview({
    batchId: batch.id,
    lines: parsed.lines,
    goodsSpecs,
    suites,
    mappings,
    externalProductMatches,
    stockSnapshot,
    warehouseSettings,
    vipStoreIndex,
    matchedInputs,
  });
  const rebuiltLines = mergeRebuiltConfirmedOrderLines(buildResult.reviewLines, previousLines, input.strategy);
  const now = new Date().toISOString();
  const updatedBatch: BatchRow = {
    ...batch,
    status: "review_generated",
    orderLineCount: parsed.lines.length,
    uniqueBarcodeCount: new Set(parsed.lines.map((line) => line.externalBarcode).filter(Boolean)).size,
    matchedBarcodeCount: new Set(rebuiltLines.filter((line) => line.matchStatus === "matched").map((line) => line.externalBarcode).filter(Boolean)).size,
    stockSnapshotRunId: stockSnapshot?.runId ?? "",
    stockSnapshotAt: stockSnapshot?.syncedAt ?? "",
    updatedAt: now,
  };

  await database.db.update(batches).set({
    status: updatedBatch.status,
    orderLineCount: updatedBatch.orderLineCount,
    uniqueBarcodeCount: updatedBatch.uniqueBarcodeCount,
    matchedBarcodeCount: updatedBatch.matchedBarcodeCount,
    stockSnapshotRunId: updatedBatch.stockSnapshotRunId,
    stockSnapshotAt: updatedBatch.stockSnapshotAt,
    updatedAt: updatedBatch.updatedAt,
  }).where(eq(batches.id, batch.id));
  await replaceBatchReviewLines(database, batch.id, rebuiltLines, now, previousDecisions);
  await replaceProductMatchCandidates(database, batch.id, buildResult.candidateRows, now);
  await insertAuditLog(database, actor?.id ?? null, "confirmed_order.rebuild", "batch", batch.id, {
    fileName: batch.fileName,
    sheetName: parsed.sheetName,
    parsedRowCount: parsed.lines.length,
    matchedRowCount: rebuiltLines.filter((line) => line.matchStatus === "matched").length,
    unmatchedRowCount: rebuiltLines.filter((line) => line.matchStatus !== "matched").length,
    skippedRowCount: parsed.skippedRowCount,
    stockQueriedCount: buildResult.stockQueriedCount,
    strategy: input.strategy,
  });

  return {
    batch: toBatchSummary(updatedBatch),
    fileName: batch.fileName,
    sheetName: parsed.sheetName,
    parsedRowCount: parsed.lines.length,
    matchedRowCount: rebuiltLines.filter((line) => line.matchStatus === "matched").length,
    unmatchedRowCount: rebuiltLines.filter((line) => line.matchStatus !== "matched").length,
    skippedRowCount: parsed.skippedRowCount,
  };
}

async function applyProductMappingToConfirmedOrder(
  database: DatabaseContext,
  batch: BatchRow,
  input: ApplyProductMappingRequest,
  actor?: AuthUserDto,
): Promise<ApplyProductMappingResponse> {
  const [mapping] = await database.db.select().from(productMappings)
    .where(and(eq(productMappings.id, input.mappingId), eq(productMappings.status, "confirmed")))
    .limit(1);
  if (!mapping) throw new StoreValidationError("长期商品映射不存在或尚未确认");

  const currentLines = await getReviewLineDtos(database, batch.id);
  const targetLines = currentLines.filter((line) => reviewLineMatchesProductMapping(line, mapping));
  if (targetLines.length === 0) {
    return {
      batch: toBatchSummary(batch),
      mode: "targeted",
      affectedExternalRowCount: 0,
      affectedSkuPoolCount: 0,
      affectedReviewLineCount: 0,
      stockSnapshotRunId: batch.stockSnapshotRunId,
      stockSnapshotAt: batch.stockSnapshotAt,
      reviewLines: [],
    };
  }

  const [goodsRows, suites, mappingRows, externalProductMatches, warehouseSettingsRow, vipStoreIndex] = await Promise.all([
    database.db.select().from(wdtGoodsSpecs),
    loadLocalSuiteCandidates(database),
    database.db.select().from(productMappings).where(eq(productMappings.status, "confirmed")),
    loadExternalProductMatchIndex(database),
    getWarehouseUsageSettingsRow(database),
    loadVipStoreIndex(database),
  ]);
  const goodsSpecs = goodsRows.map(toLocalGoodsSpecCandidate);
  const mappings = mappingRows.map(toProductMappingCandidate);
  const warehouseSettings = toWarehouseUsageSettingsDto(warehouseSettingsRow);
  const matcher = createLocalProductMatcher({ goodsSpecs, suites, mappings });
  const targetIds = new Set(targetLines.map((line) => line.id));
  const targetMatchedInputs = targetLines.map((line) => {
    const parsed = reviewLineToParsedConfirmedOrderLine(line, batch.fileName);
    return { line: parsed, id: line.id, decision: decideConfirmedOrderProductMatch(parsed, { goodsSpecs, suites, mappings, externalProductMatches }, matcher) };
  });
  const affectedSpecNos = new Set([
    ...targetLines.map((line) => line.wdtSpecNo),
    ...targetMatchedInputs.map((item) => item.decision.candidate?.specNo ?? ""),
  ].filter(Boolean));
  const poolLines = currentLines.filter((line) => targetIds.has(line.id) || affectedSpecNos.has(line.wdtSpecNo));

  const stockSnapshot = batch.stockSnapshotRunId
    ? await loadActiveStockSnapshot(database, warehouseSettings, { runId: batch.stockSnapshotRunId, specNos: [...affectedSpecNos] })
    : undefined;
  if (batch.stockSnapshotRunId && !stockSnapshot) {
    const fallback = await rebuildConfirmedOrderBatch(database, batch, { strategy: "preserve" }, actor);
    const rebuiltLines = await getReviewLineDtos(database, batch.id);
    return {
      batch: fallback.batch,
      mode: "full_rebuild_fallback",
      affectedExternalRowCount: targetLines.length,
      affectedSkuPoolCount: affectedSpecNos.size,
      affectedReviewLineCount: rebuiltLines.length,
      stockSnapshotRunId: fallback.batch.stockSnapshotRunId,
      stockSnapshotAt: fallback.batch.stockSnapshotAt,
      reviewLines: rebuiltLines,
    };
  }

  const poolParsedLines = poolLines.map((line) => reviewLineToParsedConfirmedOrderLine(line, batch.fileName));
  const matchedInputs = poolLines.map((line, index) => ({
    line: poolParsedLines[index],
    id: line.id,
    decision: decideConfirmedOrderProductMatch(poolParsedLines[index], { goodsSpecs, suites, mappings, externalProductMatches }, matcher),
  }));
  const buildResult = await buildConfirmedOrderReview({
    batchId: batch.id,
    lines: poolParsedLines,
    goodsSpecs,
    suites,
    mappings,
    externalProductMatches,
    stockSnapshot,
    warehouseSettings,
    vipStoreIndex,
    matchedInputs,
  });
  const updatedPoolLines = mergeRebuiltConfirmedOrderLines(buildResult.reviewLines, poolLines, "preserve");
  const updatedById = new Map(updatedPoolLines.map((line) => [line.id, line]));
  const allUpdatedLines = currentLines.map((line) => updatedById.get(line.id) ?? line);
  const now = new Date().toISOString();
  const updatedBatch: BatchRow = {
    ...batch,
    status: "review_generated",
    matchedBarcodeCount: new Set(allUpdatedLines.filter((line) => line.matchStatus === "matched").map((line) => line.externalBarcode).filter(Boolean)).size,
    updatedAt: now,
  };
  const previousDecisions = await database.db.select().from(reviewDecisions).where(inArray(reviewDecisions.reviewLineId, poolLines.map((line) => line.id)));
  const previousDecisionByLineId = new Map(previousDecisions.map((decision) => [decision.reviewLineId, decision]));

  await database.db.transaction(async (tx) => {
    await tx.update(batches).set({
      status: updatedBatch.status,
      matchedBarcodeCount: updatedBatch.matchedBarcodeCount,
      updatedAt: updatedBatch.updatedAt,
    }).where(eq(batches.id, batch.id));
    for (const line of updatedPoolLines) {
      await tx.update(reviewLines).set(calculatedReviewLineValues(line)).where(eq(reviewLines.id, line.id));
      const previous = previousDecisionByLineId.get(line.id);
      if (previous) {
        await tx.update(reviewDecisions).set({
          decision: line.decision,
          approvedShipQty: line.approvedShipQty,
          fulfillmentWarehouseNo: line.fulfillmentWarehouseNo,
          fulfillmentWarehouseName: line.fulfillmentWarehouseName,
          reason: line.reason,
          updatedAt: now,
        }).where(eq(reviewDecisions.id, previous.id));
      } else {
        await tx.insert(reviewDecisions).values({
          id: `decision-${randomUUID()}`,
          batchId: batch.id,
          reviewLineId: line.id,
          reviewerId: null,
          decision: line.decision,
          approvedShipQty: line.approvedShipQty,
          fulfillmentWarehouseNo: line.fulfillmentWarehouseNo,
          fulfillmentWarehouseName: line.fulfillmentWarehouseName,
          reason: line.reason,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    await tx.delete(productMatchCandidates).where(inArray(productMatchCandidates.reviewLineId, poolLines.map((line) => line.id)));
    const candidates = dedupeRealReviewCandidateRows(buildResult.candidateRows);
    if (candidates.length > 0) {
      await tx.insert(productMatchCandidates).values(candidates.map((candidate) => ({
        id: `candidate-${randomUUID()}`,
        batchId: batch.id,
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
      })));
    }
  });
  await insertAuditLog(database, actor?.id ?? null, "confirmed_order.apply_product_mapping", "batch", batch.id, {
    mappingId: mapping.id,
    affectedExternalRowCount: targetLines.length,
    affectedSpecNos: [...affectedSpecNos],
    affectedReviewLineCount: updatedPoolLines.length,
    stockSnapshotRunId: stockSnapshot?.runId ?? "",
  });

  return {
    batch: toBatchSummary(updatedBatch),
    mode: "targeted",
    affectedExternalRowCount: targetLines.length,
    affectedSkuPoolCount: affectedSpecNos.size,
    affectedReviewLineCount: updatedPoolLines.length,
    stockSnapshotRunId: stockSnapshot?.runId ?? "",
    stockSnapshotAt: stockSnapshot?.syncedAt ?? "",
    reviewLines: updatedPoolLines,
  };
}

function reviewLineMatchesProductMapping(line: ReviewLineDto, mapping: ProductMappingRow): boolean {
  return Boolean(
    (mapping.externalBarcode && line.externalBarcode === mapping.externalBarcode)
    || (mapping.externalGoodsCode && line.externalGoodsCode === mapping.externalGoodsCode),
  );
}

function reviewLineToParsedConfirmedOrderLine(line: ReviewLineDto, sourceFile: string): ParsedConfirmedOrderLine {
  let raw: Record<string, string> = {};
  try {
    raw = JSON.parse(line.orderRawJson) as Record<string, string>;
  } catch {
    raw = {};
  }
  return {
    sourceFile,
    sourceSheet: "确定单",
    excelRow: line.excelRow,
    orderApprovalNo: line.orderApprovalNo,
    orderNoticeNo: line.orderNoticeNo,
    storeNo: line.storeNo,
    storeName: line.storeName,
    salesperson: line.salesperson,
    deadlineDate: line.deadlineDate,
    externalGoodsCode: line.externalGoodsCode,
    externalBarcode: line.externalBarcode,
    externalGoodsName: line.externalGoodsName,
    spec: line.originalSpec,
    orderQty: line.orderQty,
    shipQty: line.plannedShipQty,
    contractPrice: line.contractPrice,
    raw,
  };
}

function calculatedReviewLineValues(line: ReviewLineDto): Partial<ReviewLineRow> {
  return {
    goodsName: line.goodsName,
    specName: line.specName,
    wdtSpecNo: line.wdtSpecNo,
    wdtMakeOrderCode: line.wdtMakeOrderCode || line.wdtSpecNo,
    matchStatus: line.matchStatus,
    matchMessage: line.matchMessage,
    stockErrorDetail: line.stockErrorDetail ?? "",
    mainAvailableBefore: line.mainAvailableBefore,
    nearExpiryAvailableBefore: line.nearExpiryAvailableBefore,
    suggestedShipQty: line.suggestedShipQty,
    suggestedWarehouseNo: line.suggestedWarehouseNo,
    suggestedWarehouseName: line.suggestedWarehouseName,
    priority: line.priority ? 1 : 0,
    priorityReason: line.priorityReason,
    status: line.status,
  };
}

function mergeRebuiltConfirmedOrderLines(
  nextLines: ReviewLineDto[],
  previousLines: ReviewLineDto[],
  strategy: RebuildConfirmedOrderRequest["strategy"],
): ReviewLineDto[] {
  const previousById = new Map(previousLines.map((line) => [line.id, line]));
  return nextLines.map((line) => {
    const previous = previousById.get(line.id);
    if (!previous) return line;
    const withPreservedMetadata: ReviewLineDto = {
      ...line,
      reason: previous.reason,
      priority: previous.priority,
      priorityReason: previous.priorityReason,
    };
    if (strategy === "replace" || (previous.matchStatus !== "matched" && line.matchStatus === "matched")) {
      return withPreservedMetadata;
    }
    return {
      ...withPreservedMetadata,
      decision: previous.decision,
      approvedShipQty: previous.approvedShipQty,
      fulfillmentWarehouseNo: previous.fulfillmentWarehouseNo,
      fulfillmentWarehouseName: previous.fulfillmentWarehouseName,
    };
  });
}

async function replaceBatchReviewLines(
  database: DatabaseContext,
  batchId: string,
  lines: ReviewLineDto[],
  now: string,
  previousDecisions: ReviewDecisionRow[] = [],
): Promise<void> {
  const previousDecisionByLineId = new Map(previousDecisions.map((decision) => [decision.reviewLineId, decision]));
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
      plannedShipQty: line.plannedShipQty,
      mainAvailableBefore: line.mainAvailableBefore,
      nearExpiryAvailableBefore: line.nearExpiryAvailableBefore,
      suggestedShipQty: line.suggestedShipQty,
      suggestedWarehouseNo: line.suggestedWarehouseNo,
      suggestedWarehouseName: line.suggestedWarehouseName,
      priority: line.priority ? 1 : 0,
      priorityReason: line.priorityReason ?? "",
      status: line.status,
    })),
  );

  await database.db.insert(reviewDecisions).values(
    lines.map((line) => {
      const previous = previousDecisionByLineId.get(line.id);
      return {
        id: previous?.id ?? `decision-${randomUUID()}`,
        batchId,
        reviewLineId: line.id,
        reviewerId: previous?.reviewerId ?? null,
        decision: line.decision,
        approvedShipQty: line.approvedShipQty,
        fulfillmentWarehouseNo: line.fulfillmentWarehouseNo,
        fulfillmentWarehouseName: line.fulfillmentWarehouseName,
        reason: line.reason ?? "",
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
    }),
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
  const matchLocalProduct = createLocalProductMatcher({ goodsSpecs, suites, mappings: [] });
  const candidates: ProductMatchCandidateDto[] = [];

  for (const line of inputs) {
    const fullDecision = matchLocalProduct(reviewLineToProductMatchInput(line));
    const nameDecision = matchLocalProduct(reviewLineToNameOnlyProductMatchInput(line));
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
    modified: suite.modified,
    syncedAt: suite.syncedAt,
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
    wdtMakeOrderCode: row.wdtMakeOrderCode || row.wdtSpecNo,
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
  const warehouseByKey = new Map<string, WarehouseStockCandidate & { rawAvailableStock: number }>();

  for (const row of rows) {
    const warehouseType = classifyWdtWarehouse(row);
    const warehouseNo = (row.warehouse_no ?? "").trim();
    const warehouseName = (row.warehouse_name ?? "").trim() || defaultWarehouseName(warehouseType);
    const key = `${warehouseType}|${warehouseNo.toUpperCase()}|${warehouseName}`;
    const current = warehouseByKey.get(key);
    warehouseByKey.set(key, {
      warehouseNo: warehouseNo || defaultWarehouseNo(warehouseType, warehouseName),
      warehouseName,
      availableStock: 0,
      rawAvailableStock: (current?.rawAvailableStock ?? 0) + getWdtAvailableSendStock(row),
      type: warehouseType,
    });
  }

  for (const warehouse of warehouseByKey.values()) {
    warehouse.availableStock = effectiveWdtAvailableSendStock(warehouse.rawAvailableStock);
    if (warehouse.type === "main") mainAvailableStock += warehouse.availableStock;
    else if (warehouse.type === "near_expiry") nearExpiryAvailableStock += warehouse.availableStock;
    else if (warehouse.type === "defect") defectAvailableStock += warehouse.availableStock;
    else otherAvailableStock += warehouse.availableStock;
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
    warehouseBreakdown: [...warehouseByKey.values()]
      .map((warehouse) => `${warehouse.warehouseNo}/${warehouse.warehouseName}:可发库存${warehouse.rawAvailableStock}`)
      .join("; "),
    warehouses: [...warehouseByKey.values()]
      .filter((warehouse) => warehouseIncluded(warehouse.type, settings) && warehouse.availableStock > 0)
      .map(({ rawAvailableStock: _rawAvailableStock, ...warehouse }) => warehouse)
      .sort(compareWarehouseCandidates),
  };
}

function warehouseIncluded(type: WarehouseStockType, settings: WarehouseUsageSettingsDto) {
  if (type === "main") return settings.includeMainWarehouse;
  if (type === "near_expiry") return settings.includeNearExpiryWarehouse;
  if (type === "defect") return settings.includeDefectWarehouse;
  return settings.includeOtherWarehouses;
}

function enabledWarehouseTypes(settings: WarehouseUsageSettingsDto): WarehouseSnapshotType[] {
  const types: WarehouseSnapshotType[] = [];
  if (settings.includeMainWarehouse) types.push("main");
  if (settings.includeNearExpiryWarehouse) types.push("near_expiry");
  if (settings.includeDefectWarehouse) types.push("defect");
  if (settings.includeOtherWarehouses) types.push("other");
  return types;
}

function concreteWarehouseNo(type: WarehouseSnapshotType | undefined) {
  if (type === "main") return "001";
  if (type === "near_expiry") return "LINQI";
  if (type === "defect") return "CIPIN";
  return "";
}

function defaultWarehouseNo(type: WarehouseStockType, warehouseName: string) {
  if (type === "main") return "001";
  if (type === "near_expiry") return "LINQI";
  if (type === "defect") return "CIPIN";
  return `OTHER:${warehouseName.toUpperCase()}`;
}

function defaultWarehouseName(type: WarehouseStockType) {
  if (type === "main") return "主仓";
  if (type === "near_expiry") return "临期仓";
  if (type === "defect") return "次品仓";
  return "其他仓";
}

function compareWarehouseCandidates(left: WarehouseStockCandidate, right: WarehouseStockCandidate) {
  const priority: Record<WarehouseStockType, number> = { main: 0, near_expiry: 1, defect: 2, other: 3 };
  return priority[left.type] - priority[right.type]
    || left.warehouseNo.localeCompare(right.warehouseNo)
    || left.warehouseName.localeCompare(right.warehouseName);
}

function stockLookupFromSnapshot(specNos: string[], snapshot: LocalStockSnapshot | undefined) {
  const error = snapshot?.missingWarehouseTypes.length
    ? {
        userMessage: `当前库存快照未覆盖已启用仓库：${snapshot.missingWarehouseTypes.map(warehouseTypeText).join("、")}，请同步后再使用系统建议`,
        developerDetail: `LOCAL_STOCK_SNAPSHOT_WAREHOUSE_SCOPE_MISMATCH missing=${snapshot.missingWarehouseTypes.join(",")}`,
      }
    : buildStockLookupError("LOCAL_STOCK_SNAPSHOT_MISSING");
  const stockErrorsBySpecNo = new Map<string, StockLookupError>();
  const stockBySpecNo = new Map<string, WarehouseStockSummary>();
  for (const specNo of [...new Set(specNos.filter(Boolean))]) {
    if (snapshot?.missingWarehouseTypes.length === 0 && snapshot.verifiedSpecNos.has(specNo)) {
      stockBySpecNo.set(specNo, snapshot.stockBySpecNo.get(specNo) ?? emptyWarehouseStockSummary());
    } else stockErrorsBySpecNo.set(specNo, error);
  }
  return { stockBySpecNo, stockErrorsBySpecNo, stockQueriedCount: stockBySpecNo.size };
}

function emptyWarehouseStockSummary(): WarehouseStockSummary {
  return {
    mainAvailableStock: 0,
    nearExpiryAvailableStock: 0,
    defectAvailableStock: 0,
    otherAvailableStock: 0,
    usableAvailableStock: 0,
    warehouseBreakdown: "",
    warehouses: [],
  };
}

async function loadActiveStockSnapshot(
  database: DatabaseContext,
  settings: WarehouseUsageSettingsDto,
  options: { runId?: string; specNos?: string[] } = {},
): Promise<LocalStockSnapshot | undefined> {
  const runQuery = database.db.select().from(wdtSyncRuns)
    .where(options.runId
      ? and(eq(wdtSyncRuns.id, options.runId), eq(wdtSyncRuns.status, "success"))
      : eq(wdtSyncRuns.status, "success"));
  const [run] = options.runId
    ? await runQuery.limit(1)
    : await runQuery.orderBy(desc(wdtSyncRuns.finishedAt)).limit(1);
  if (!run) return undefined;
  const uniqueSpecNos = options.specNos ? [...new Set(options.specNos.filter(Boolean))] : undefined;
  const specFilter = uniqueSpecNos && uniqueSpecNos.length > 0
    ? and(eq(wdtStockSnapshotSpecs.syncRunId, run.id), inArray(wdtStockSnapshotSpecs.specNo, uniqueSpecNos))
    : eq(wdtStockSnapshotSpecs.syncRunId, run.id);
  const rowFilter = uniqueSpecNos && uniqueSpecNos.length > 0
    ? and(eq(wdtStockSnapshotRows.syncRunId, run.id), inArray(wdtStockSnapshotRows.specNo, uniqueSpecNos))
    : eq(wdtStockSnapshotRows.syncRunId, run.id);
  const [verifiedRows, snapshotRows, coverageRows] = await Promise.all([
    uniqueSpecNos?.length === 0 ? Promise.resolve([]) : database.db.select().from(wdtStockSnapshotSpecs).where(specFilter),
    uniqueSpecNos?.length === 0 ? Promise.resolve([]) : database.db.select().from(wdtStockSnapshotRows).where(rowFilter),
    database.db.select().from(wdtStockSnapshotWarehouseCoverage).where(eq(wdtStockSnapshotWarehouseCoverage.syncRunId, run.id)),
  ]);
  const warehouseTypes = new Set(coverageRows.map((row) => row.warehouseType));
  const missingWarehouseTypes = enabledWarehouseTypes(settings).filter((type) => !warehouseTypes.has(type));
  const rowsBySpecNo = new Map<string, WdtStockRow[]>();
  for (const row of snapshotRows) {
    const wdtRow: WdtStockRow = {
      spec_no: row.specNo,
      warehouse_no: row.warehouseNo,
      warehouse_name: row.warehouseName,
      available_send_stock: row.availableSendStock,
    };
    rowsBySpecNo.set(row.specNo, [...(rowsBySpecNo.get(row.specNo) ?? []), wdtRow]);
  }
  return {
    runId: run.id,
    syncedAt: run.finishedAt,
    verifiedSpecNos: new Set(verifiedRows.map((row) => row.specNo)),
    warehouseTypes,
    missingWarehouseTypes,
    stockBySpecNo: new Map(verifiedRows.map((row) => [row.specNo, summarizeWarehouseStock(rowsBySpecNo.get(row.specNo) ?? [], settings)])),
  };
}

interface StockLookupError {
  userMessage: string;
  developerDetail: string;
}

function buildStockLookupError(developerDetail: string): StockLookupError {
  return {
    userMessage: "确定单库存查询失败，系统未生成数量和仓库建议，请人工确认",
    developerDetail,
  };
}

type WarehouseStockType = "main" | "near_expiry" | "defect" | "other";

function warehouseTypeText(type: WarehouseSnapshotType) {
  if (type === "main") return "主仓";
  if (type === "near_expiry") return "临期仓";
  if (type === "defect") return "次品仓";
  return "其他仓";
}

function classifyWdtWarehouse(row: WdtStockRow): WarehouseStockType {
  const warehouseNo = (row.warehouse_no ?? "").trim().toUpperCase();
  const warehouseName = (row.warehouse_name ?? "").trim();
  if (warehouseNo === "CIPIN" || row.defect === true || warehouseName.includes("次品")) return "defect";
  return classifyWarehouseIdentity(warehouseNo, warehouseName);
}

function classifyWarehouseIdentity(warehouseNo: string, warehouseName: string): WarehouseStockType {
  const normalizedNo = warehouseNo.trim().toUpperCase();
  const normalizedName = warehouseName.trim();
  if (normalizedNo === "001" || normalizedName.includes("主仓")) return "main";
  if (normalizedNo === "LINQI" || normalizedName.includes("临期")) return "near_expiry";
  if (normalizedNo === "CIPIN" || normalizedName.includes("次品")) return "defect";
  return "other";
}

function isWarehouseEnabled(warehouseNo: string, warehouseName: string, settings: WarehouseUsageSettingsDto) {
  const type = classifyWarehouseIdentity(warehouseNo, warehouseName);
  if (type === "main") return settings.includeMainWarehouse;
  if (type === "near_expiry") return settings.includeNearExpiryWarehouse;
  if (type === "defect") return settings.includeDefectWarehouse;
  return settings.includeOtherWarehouses;
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
  const normalizedDecision = decision.approvedShipQty > 0 ? "ship" : decision.decision;
  const nextDecision: ReviewDecisionRow = {
    id: previousDecision?.id ?? `decision-${randomUUID()}`,
    batchId: line.batchId,
    reviewLineId: line.id,
    reviewerId: reviewerId ?? previousDecision?.reviewerId ?? null,
    decision: normalizedDecision,
    approvedShipQty: decision.approvedShipQty,
    fulfillmentWarehouseNo: normalizedDecision === "do_not_ship" ? "" : decision.fulfillmentWarehouseNo.trim(),
    fulfillmentWarehouseName: normalizedDecision === "do_not_ship" ? "" : decision.fulfillmentWarehouseName.trim(),
    reason: decision.reason ?? "",
    createdAt: previousDecision?.createdAt ?? updatedAt,
    updatedAt,
  };
  await database.db.insert(reviewDecisions).values(nextDecision);
  return nextDecision;
}

function validateReviewDecision(line: ReviewLineRow, decision: ReviewDecisionDto) {
  if (!Number.isInteger(decision.approvedShipQty) || decision.approvedShipQty < 0) {
    throw new StoreValidationError("发货数量必须是非负整数");
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
    stockSnapshotRunId: batch.stockSnapshotRunId,
    stockSnapshotAt: batch.stockSnapshotAt,
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

function toWdtSyncSettingsDto(row: WdtSyncSettingsRow, autoSyncEnabled: boolean): WdtSyncSettingsDto {
  return {
    intervalHours: normalizeSyncIntervalHours(row.intervalHours),
    autoSyncEnabled,
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
    plannedShipQty: line.plannedShipQty,
    mainAvailableBefore: line.mainAvailableBefore,
    nearExpiryAvailableBefore: line.nearExpiryAvailableBefore,
    suggestedShipQty: line.suggestedShipQty,
    suggestedWarehouseNo: line.suggestedWarehouseNo,
    suggestedWarehouseName: line.suggestedWarehouseName,
    status: line.status,
    decision: decision?.decision ?? "pending",
    approvedShipQty: decision?.approvedShipQty ?? 0,
    fulfillmentWarehouseNo: decision?.fulfillmentWarehouseNo ?? "",
    fulfillmentWarehouseName: decision?.fulfillmentWarehouseName ?? "",
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

function createCombinedSyncRepository(
  database: DatabaseContext,
  goodsRepository: GoodsSyncRepository,
  goodsClient: WdtGoodsWindowClient | undefined,
): CombinedSyncRepository {
  return {
    async findActiveRun() {
      const [row] = await database.db.select().from(wdtSyncRuns).where(inArray(wdtSyncRuns.status, ["queued", "running"])).orderBy(desc(wdtSyncRuns.startedAt)).limit(1);
      return row ? toWdtSyncRunDto(database, row) : undefined;
    },
    async createRun(input) {
      const row: typeof wdtSyncRuns.$inferInsert = {
        id: input.id, trigger: input.trigger, status: "queued", stage: "queued", goodsSyncRunId: "",
        totalSpecCount: 0, processedSpecCount: 0, totalBatchCount: 0, completedBatchCount: 0, stockRowCount: 0,
        startedAt: input.now, finishedAt: "", lastProgressAt: input.now, errorCode: "", errorMessage: "", errorDetail: "",
      };
      await database.db.insert(wdtSyncRuns).values(row);
      return toWdtSyncRunDto(database, row as WdtSyncRunRow);
    },
    async updateRun(runId, patch) {
      const dbPatch = syncRunPatchToDb(patch);
      if (Object.keys(dbPatch).length) await database.db.update(wdtSyncRuns).set(dbPatch).where(eq(wdtSyncRuns.id, runId));
    },
    async runGoodsIncremental() {
      if (!goodsClient) return { id: "", status: "failed", errorMessage: "WDT goods sync client is not configured" };
      const run = await runWdtGoodsSync(goodsRepository, goodsClient, { mode: "incremental" });
      return { id: run.id, status: run.status === "success" ? "success" : "failed", errorMessage: run.errorMessage };
    },
    async loadStockSpecNos() {
      const goods = await database.db.select({ specNo: wdtGoodsSpecs.specNo }).from(wdtGoodsSpecs).where(eq(wdtGoodsSpecs.deleted, 0));
      const activeSuites = await database.db.select({ suiteNo: wdtSuites.suiteNo }).from(wdtSuites).where(eq(wdtSuites.deleted, 0));
      const activeSuiteNos = new Set(activeSuites.map((row) => row.suiteNo));
      const components = (await database.db.select({ suiteNo: wdtSuiteComponents.suiteNo, specNo: wdtSuiteComponents.specNo })
        .from(wdtSuiteComponents)
        .where(eq(wdtSuiteComponents.deleted, 0)))
        .filter((row) => activeSuiteNos.has(row.suiteNo));
      return [...goods, ...components].map((row) => row.specNo);
    },
    async loadStockScope() {
      const settings = toWarehouseUsageSettingsDto(await getWarehouseUsageSettingsRow(database));
      const warehouseTypes = enabledWarehouseTypes(settings);
      const apiWarehouseNo = warehouseTypes.length === 1 ? concreteWarehouseNo(warehouseTypes[0]) : "";
      return { warehouseTypes, apiWarehouseNo };
    },
    async writeStockBatch(runId, requestedSpecNos, rows, syncedAt, scope) {
      if (requestedSpecNos.length) await database.db.insert(wdtStockSnapshotSpecs).values(requestedSpecNos.map((specNo) => ({ syncRunId: runId, specNo, syncedAt })));
      const requested = new Set(requestedSpecNos);
      const enabledTypes = new Set(scope.warehouseTypes);
      const groupedRows = new Map<string, { row: WdtStockRow; availableSendStock: number; rawRows: WdtStockRow[] }>();
      for (const row of rows) {
        const specNo = (row.spec_no ?? "").trim();
        const warehouseNo = (row.warehouse_no ?? "").trim();
        const warehouseName = (row.warehouse_name ?? "").trim();
        if (!requested.has(specNo) || (!warehouseNo && !warehouseName) || !enabledTypes.has(classifyWdtWarehouse(row))) continue;
        const key = `${specNo}\u0000${warehouseNo}\u0000${warehouseName}`;
        const current = groupedRows.get(key);
        groupedRows.set(key, {
          row: { ...row, spec_no: specNo, warehouse_no: warehouseNo, warehouse_name: warehouseName },
          availableSendStock: (current?.availableSendStock ?? 0) + getWdtAvailableSendStock(row),
          rawRows: [...(current?.rawRows ?? []), row],
        });
      }
      const validRows = [...groupedRows.values()];
      if (validRows.length) await database.db.insert(wdtStockSnapshotRows).values(validRows.map(({ row, availableSendStock, rawRows }) => ({
        id: `stock-snapshot-${randomUUID()}`,
        syncRunId: runId,
        specNo: (row.spec_no ?? "").trim(),
        warehouseNo: (row.warehouse_no ?? "").trim(),
        warehouseName: (row.warehouse_name ?? "").trim(),
        availableSendStock,
        rawJson: JSON.stringify(rawRows),
        syncedAt,
      })));
      return validRows.length;
    },
    async activateRun(runId, finishedAt, scope) {
      await database.client.batch([
        ...scope.warehouseTypes.map((warehouseType) => ({
          sql: `insert into wdt_stock_snapshot_warehouse_coverage
                (sync_run_id, warehouse_type, api_warehouse_no, synced_at) values (?, ?, ?, ?)`,
          args: [runId, warehouseType, scope.apiWarehouseNo, finishedAt],
        })),
        {
          sql: `update wdt_sync_runs
                set status = 'success', stage = 'complete', finished_at = ?, last_progress_at = ?
                where id = ? and status in ('queued', 'running')`,
          args: [finishedAt, finishedAt, runId],
        },
      ], "write");
      await pruneOldStockSnapshots(database);
    },
    async failRun(runId, errorCode, errorMessage, errorDetail, finishedAt) {
      await database.client.batch([
        { sql: "delete from wdt_stock_snapshot_rows where sync_run_id = ?", args: [runId] },
        { sql: "delete from wdt_stock_snapshot_specs where sync_run_id = ?", args: [runId] },
        { sql: "delete from wdt_stock_snapshot_warehouse_coverage where sync_run_id = ?", args: [runId] },
        {
          sql: `update wdt_sync_runs
                set status = 'failed', stage = 'complete', finished_at = ?, last_progress_at = ?,
                    error_code = ?, error_message = ?, error_detail = ?
                where id = ?`,
          args: [finishedAt, finishedAt, errorCode, errorMessage, errorDetail, runId],
        },
      ], "write");
    },
  };
}

function syncRunPatchToDb(patch: Partial<WdtSyncRunDto>): Partial<WdtSyncRunRow> {
  const allowed = ["status", "stage", "goodsSyncRunId", "totalSpecCount", "processedSpecCount", "totalBatchCount", "completedBatchCount", "stockRowCount", "finishedAt", "lastProgressAt", "errorCode", "errorMessage", "errorDetail"] as const;
  return Object.fromEntries(allowed.flatMap((key) => patch[key] === undefined ? [] : [[key, patch[key]]])) as Partial<WdtSyncRunRow>;
}

async function getLatestSuccessfulWdtSyncRun(database: DatabaseContext) {
  const [row] = await database.db.select().from(wdtSyncRuns).where(eq(wdtSyncRuns.status, "success")).orderBy(desc(wdtSyncRuns.finishedAt)).limit(1);
  return row;
}

export function snapshotIsOlderThan(finishedAt: string, nowMs: number, maximumAgeMs = HOUR_MS) {
  const finishedAtMs = Date.parse(finishedAt);
  return !Number.isFinite(finishedAtMs) || nowMs - finishedAtMs > maximumAgeMs;
}

export function millisecondsUntilNextShanghaiSyncBoundary(nowMs: number, intervalHours: WdtAutoSyncIntervalHours) {
  const shifted = nowMs + SHANGHAI_UTC_OFFSET_MS;
  const intervalMs = intervalHours * HOUR_MS;
  const nextBoundary = Math.floor(shifted / intervalMs + 1) * intervalMs;
  return nextBoundary - shifted;
}

export const millisecondsUntilNextShanghaiHour = (nowMs: number) => millisecondsUntilNextShanghaiSyncBoundary(nowMs, 1);

function normalizeSyncIntervalHours(value: number): WdtAutoSyncIntervalHours {
  return value === 2 || value === 6 || value === 24 ? value : 1;
}

async function toWdtSyncRunDto(database: DatabaseContext, row: WdtSyncRunRow | typeof wdtSyncRuns.$inferInsert): Promise<WdtSyncRunDto> {
  const active = await getLatestSuccessfulWdtSyncRun(database);
  const coverageRows = active
    ? await database.db.select().from(wdtStockSnapshotWarehouseCoverage).where(eq(wdtStockSnapshotWarehouseCoverage.syncRunId, active.id))
    : [];
  const activeSnapshotWarehouseTypes = coverageRows.map((coverage) => coverage.warehouseType);
  const settings = toWarehouseUsageSettingsDto(await getWarehouseUsageSettingsRow(database));
  const activeSnapshotMissingWarehouseTypes = enabledWarehouseTypes(settings).filter((type) => !activeSnapshotWarehouseTypes.includes(type));
  return {
    id: row.id, trigger: row.trigger, status: row.status, stage: row.stage, goodsSyncRunId: row.goodsSyncRunId ?? "",
    totalSpecCount: row.totalSpecCount ?? 0, processedSpecCount: row.processedSpecCount ?? 0,
    totalBatchCount: row.totalBatchCount ?? 0, completedBatchCount: row.completedBatchCount ?? 0, stockRowCount: row.stockRowCount ?? 0,
    startedAt: row.startedAt, finishedAt: row.finishedAt ?? "", lastProgressAt: row.lastProgressAt,
    activeSnapshotRunId: active?.id ?? "", activeSnapshotAt: active?.finishedAt ?? "", activeSnapshotTrigger: active?.trigger ?? "",
    activeSnapshotWarehouseTypes,
    activeSnapshotMissingWarehouseTypes,
    errorCode: row.errorCode ?? "", errorMessage: row.errorMessage ?? "", errorDetail: row.errorDetail ?? "",
  };
}

async function pruneOldStockSnapshots(database: DatabaseContext) {
  const successful = await database.db.select({ id: wdtSyncRuns.id }).from(wdtSyncRuns).where(eq(wdtSyncRuns.status, "success")).orderBy(desc(wdtSyncRuns.finishedAt));
  const obsolete = successful.slice(2).map((row) => row.id);
  if (!obsolete.length) return;
  await database.db.delete(wdtStockSnapshotRows).where(inArray(wdtStockSnapshotRows.syncRunId, obsolete));
  await database.db.delete(wdtStockSnapshotSpecs).where(inArray(wdtStockSnapshotSpecs.syncRunId, obsolete));
  await database.db.delete(wdtStockSnapshotWarehouseCoverage).where(inArray(wdtStockSnapshotWarehouseCoverage.syncRunId, obsolete));
}

async function recoverInterruptedSyncRuns(database: DatabaseContext) {
  const rows = await database.db.select().from(wdtSyncRuns).where(inArray(wdtSyncRuns.status, ["queued", "running"]));
  for (const row of rows) {
    const now = new Date().toISOString();
    await database.client.batch([
      { sql: "delete from wdt_stock_snapshot_rows where sync_run_id = ?", args: [row.id] },
      { sql: "delete from wdt_stock_snapshot_specs where sync_run_id = ?", args: [row.id] },
      { sql: "delete from wdt_stock_snapshot_warehouse_coverage where sync_run_id = ?", args: [row.id] },
      {
        sql: `update wdt_sync_runs
              set status = 'failed', stage = 'complete', finished_at = ?, last_progress_at = ?,
                  error_code = 'INTERRUPTED', error_message = '上次同步因服务重启而中断',
                  error_detail = 'process restarted before sync completed'
              where id = ?`,
        args: [now, now, row.id],
      },
    ], "write");
  }
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
    source: "goods",
    goodsNo: row.goodsNo,
    goodsName: row.goodsName,
    specNo: row.specNo,
    specName: row.specName,
    specCode: row.specCode,
    makeOrderCode: row.specNo,
    barcode: row.barcode,
    barcodes: parseBarcodes(row.barcodesJson),
    deleted: row.deleted,
    modified: row.modified,
    syncedAt: row.syncedAt,
  };
}

function toSuiteSearchResultDto(suite: LocalSuiteCandidate): WdtGoodsSpecSearchResultDto {
  return {
    id: `wdt-suite-${suite.suiteNo}`,
    source: "suite",
    goodsNo: suite.suiteNo,
    goodsName: suite.suiteName || suite.componentGoodsName || suite.suiteNo,
    specNo: suite.componentSpecNo,
    specName: suite.componentSpecName || "",
    specCode: suite.suiteNo,
    makeOrderCode: suite.suiteNo,
    barcode: suite.barcode || suite.suiteNo,
    barcodes: [...new Set([suite.barcode, suite.suiteNo, suite.componentBarcode].filter((item): item is string => Boolean(item)))],
    deleted: suite.deleted ?? 0,
    modified: suite.modified ?? "",
    syncedAt: suite.syncedAt ?? "",
  };
}

function suiteMatchesSearchQuery(suite: LocalSuiteCandidate, query: string): boolean {
  const normalizedQuery = normalizeProductCandidateKeyPart(query);
  return [
    suite.suiteNo,
    suite.suiteName,
    suite.barcode,
    suite.componentSpecNo,
    suite.componentGoodsNo,
    suite.componentGoodsName,
    suite.componentSpecName,
    suite.componentBarcode,
  ].some((value) => normalizeProductCandidateKeyPart(value ?? "").includes(normalizedQuery));
}

function dedupeWdtSearchResults(rows: WdtGoodsSpecSearchResultDto[]): WdtGoodsSpecSearchResultDto[] {
  const byKey = new Map<string, WdtGoodsSpecSearchResultDto>();
  for (const row of rows) {
    const key = [row.source ?? "goods", row.makeOrderCode || row.specNo, row.specNo].join("|");
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function compareWdtSearchResults(left: WdtGoodsSpecSearchResultDto, right: WdtGoodsSpecSearchResultDto, query: string): number {
  return searchResultRank(right, query) - searchResultRank(left, query)
    || (left.source === "suite" ? 1 : 0) - (right.source === "suite" ? 1 : 0)
    || left.goodsName.localeCompare(right.goodsName);
}

function searchResultRank(row: WdtGoodsSpecSearchResultDto, query: string): number {
  const normalizedQuery = normalizeProductCandidateKeyPart(query);
  const identifiers = [row.barcode, row.makeOrderCode, row.specNo, row.specCode, row.goodsNo, ...row.barcodes]
    .filter((value): value is string => Boolean(value))
    .map(normalizeProductCandidateKeyPart);
  if (identifiers.some((value) => value === normalizedQuery)) return 100;
  if (identifiers.some((value) => value.includes(normalizedQuery))) return 80;
  const names = [row.goodsName, row.specName].map(normalizeProductCandidateKeyPart);
  if (names.some((value) => value === normalizedQuery)) return 70;
  if (names.some((value) => value.includes(normalizedQuery))) return 60;
  return 0;
}

async function findProductMappingTarget(
  database: DatabaseContext,
  specNo: string,
  makeOrderCode: string,
): Promise<WdtGoodsSpecSearchResultDto | undefined> {
  const [spec] = await database.db.select().from(wdtGoodsSpecs).where(eq(wdtGoodsSpecs.specNo, specNo)).limit(1);
  if (spec) {
    return { ...toWdtGoodsSpecSearchResultDto(spec), makeOrderCode: makeOrderCode || spec.specNo };
  }

  const suites = await loadLocalSuiteCandidates(database);
  const suite = suites.find((item) => {
    if (item.componentSpecNo !== specNo) return false;
    return !makeOrderCode || item.suiteNo === makeOrderCode;
  });
  return suite ? toSuiteSearchResultDto(suite) : undefined;
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
    wdtMakeOrderCode: row.wdtMakeOrderCode || row.wdtSpecNo,
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
): Promise<ProductMatchCandidateDto[]> {
  if (candidates.length === 0) return candidates;
  const stockBySpecNo = await queryStockBySpecNo(candidates.map((candidate) => candidate.wdtSpecNo), database);
  return candidates.map((candidate) => ({ ...candidate, ...(stockBySpecNo.get(candidate.wdtSpecNo) ?? {}) }));
}

async function attachWdtGoodsSpecSearchStock(
  specs: WdtGoodsSpecSearchResultDto[],
  database: DatabaseContext,
): Promise<WdtGoodsSpecSearchResultDto[]> {
  if (specs.length === 0) return specs;
  const stockBySpecNo = await queryStockBySpecNo(specs.map((spec) => spec.specNo), database);
  return specs.map((spec) => ({ ...spec, ...(stockBySpecNo.get(spec.specNo) ?? {}) }));
}

async function queryStockBySpecNo(
  specNos: string[],
  database: DatabaseContext,
): Promise<Map<string, Pick<ProductMatchCandidateDto, "stockTotalAvailable" | "stockRows" | "stockError">>> {
  const settings = toWarehouseUsageSettingsDto(await getWarehouseUsageSettingsRow(database));
  const stockBySpecNo = new Map<string, Pick<ProductMatchCandidateDto, "stockTotalAvailable" | "stockRows" | "stockError">>();
  const snapshot = await loadActiveStockSnapshot(database, settings);
  const rawRows = snapshot
    ? await database.db.select().from(wdtStockSnapshotRows).where(eq(wdtStockSnapshotRows.syncRunId, snapshot.runId))
    : [];
  const rawRowsBySpecNo = new Map<string, typeof rawRows>();
  for (const row of rawRows) {
    const rows = rawRowsBySpecNo.get(row.specNo) ?? [];
    rows.push(row);
    rawRowsBySpecNo.set(row.specNo, rows);
  }
  for (const specNo of [...new Set(specNos.filter(Boolean))]) {
    if (!snapshot?.verifiedSpecNos.has(specNo)) {
      stockBySpecNo.set(specNo, { stockError: "本地库存快照未覆盖该商品" });
      continue;
    }
    const summary = snapshot.stockBySpecNo.get(specNo) ?? emptyWarehouseStockSummary();
    const rows = (rawRowsBySpecNo.get(specNo) ?? []).map((row) => ({
      warehouseNo: row.warehouseNo,
      warehouseName: row.warehouseName,
      availableSendStock: row.availableSendStock,
      included: isWarehouseEnabled(row.warehouseNo, row.warehouseName, settings),
    }));
    stockBySpecNo.set(specNo, { stockTotalAvailable: summary.usableAvailableStock, stockRows: rows });
  }
  return stockBySpecNo;
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
  await ensureReviewDecisionColumns(database);
  await ensureWarehouseUsageSettings(database);
  await ensureWdtSyncSettings(database);
  await ensureStockSnapshotWarehouseCoverage(database);
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
  if (!columns.includes("stock_snapshot_run_id")) {
    await database.client.execute("alter table batches add column stock_snapshot_run_id text not null default ''");
  }
  if (!columns.includes("stock_snapshot_at")) {
    await database.client.execute("alter table batches add column stock_snapshot_at text not null default ''");
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
    ["suggested_warehouse_no", "''"],
    ["suggested_warehouse_name", "''"],
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
  if (!columns.includes("planned_ship_qty")) {
    await database.client.execute("alter table review_lines add column planned_ship_qty real not null default 0");
    await database.client.execute(`
      update review_lines
      set planned_ship_qty = case
        when exists (
          select 1 from batches
          where batches.id = review_lines.batch_id
            and batches.source_type = 'confirmed_order'
        ) then suggested_ship_qty
        else order_qty
      end
    `);
  }
  if (columns.includes("is_priority")) {
    await database.client.execute("update review_lines set priority = coalesce(is_priority, 0) where coalesce(priority, 0) = 0");
  }
  if (columns.includes("priority_reason")) {
    await database.client.execute("update review_lines set priority_reason = coalesce(priority_reason, '')");
  }
}

async function ensureReviewDecisionColumns(database: DatabaseContext) {
  const columns = await getTableColumns(database, "review_decisions");
  if (columns.length === 0) return;
  if (!columns.includes("fulfillment_warehouse_no")) {
    await database.client.execute("alter table review_decisions add column fulfillment_warehouse_no text not null default ''");
  }
  if (!columns.includes("fulfillment_warehouse_name")) {
    await database.client.execute("alter table review_decisions add column fulfillment_warehouse_name text not null default ''");
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

async function ensureWdtSyncSettings(database: DatabaseContext) {
  await database.client.execute(`
    create table if not exists wdt_sync_settings (
      id text primary key not null,
      interval_hours integer not null default 1,
      updated_by_user_id text,
      updated_by_username text,
      updated_at text not null
    )
  `);
  await getWdtSyncSettingsRow(database);
}

async function ensureStockSnapshotWarehouseCoverage(database: DatabaseContext) {
  const tableExisted = (await getTableColumns(database, "wdt_stock_snapshot_warehouse_coverage")).length > 0;
  await database.client.execute(`
    create table if not exists wdt_stock_snapshot_warehouse_coverage (
      sync_run_id text not null,
      warehouse_type text not null,
      api_warehouse_no text not null default '',
      synced_at text not null
    )
  `);
  await database.client.execute(`
    create unique index if not exists wdt_stock_snapshot_warehouse_coverage_unique
    on wdt_stock_snapshot_warehouse_coverage (sync_run_id, warehouse_type)
  `);
  if (!tableExisted) {
    for (const warehouseType of ["main", "near_expiry", "defect", "other"] as const) {
      await database.client.execute({
        sql: `insert or ignore into wdt_stock_snapshot_warehouse_coverage
              (sync_run_id, warehouse_type, api_warehouse_no, synced_at)
              select id, ?, '', finished_at from wdt_sync_runs where status = 'success'`,
        args: [warehouseType],
      });
    }
  }
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

async function ensureBootstrapUsers(database: DatabaseContext, bootstrapUsers: BootstrapUser[]) {
  await database.ready;
  const now = new Date().toISOString();
  for (const user of bootstrapUsers) {
    const existing = await findUserByUsername(database, user.username);
    if (existing) {
      if (user.syncExistingPassword) {
        await database.db
          .update(users)
          .set({ passwordHash: await hashPassword(user.password), role: user.role })
          .where(eq(users.id, existing.id));
      }
      continue;
    }
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
const WDT_DO_NOT_IMPORT_SHEET_NAME = "不做单表";

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
    主仓: line.suggestedWarehouseNo === "001" || line.suggestedWarehouseName.includes("主仓") ? line.suggestedShipQty : "",
    临期仓: line.suggestedWarehouseNo === "LINQI" || line.suggestedWarehouseName.includes("临期") ? line.suggestedShipQty : "",
  };

  return REVIEW_EXPORT_HEADERS.map((header) => values[header] ?? "");
}

function renderConfirmedExportWorkbook(lines: ReviewLineDto[]) {
  const exportLines = lines.filter((line) => line.approvedShipQty > 0);
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
    主仓: line.fulfillmentWarehouseNo === "001" || line.fulfillmentWarehouseName.includes("主仓") ? line.approvedShipQty : "",
    临期仓: line.fulfillmentWarehouseNo === "LINQI" || line.fulfillmentWarehouseName.includes("临期") ? line.approvedShipQty : "",
    备注: line.reason,
  };

  return CONFIRMED_EXPORT_HEADERS.map((header) => values[header] ?? "");
}

function renderWdtImportWorkbook(batch: BatchRow, lines: ReviewLineDto[], addressIndex: MakeOrderAddressIndex, actor?: AuthUserDto) {
  const exportLines = lines.filter((line) => line.approvedShipQty > 0);
  const doNotExportLines = lines.filter((line) => line.decision === "do_not_ship");
  const rows = renderWdtImportRows(batch, exportLines, addressIndex, actor);
  const doNotRows = renderWdtImportRows(batch, doNotExportLines, addressIndex, actor);
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, WDT_IMPORT_SHEET_NAME);
  const doNotSheet = XLSX.utils.aoa_to_sheet(doNotRows);
  XLSX.utils.book_append_sheet(workbook, doNotSheet, WDT_DO_NOT_IMPORT_SHEET_NAME);
  return XLSX.write(workbook, { bookType: "biff8", type: "buffer" }) as Buffer;
}

function renderWdtImportRows(
  batch: BatchRow,
  lines: ReviewLineDto[],
  addressIndex: MakeOrderAddressIndex,
  actor?: AuthUserDto,
) {
  const context = buildWdtImportContext(batch, lines);
  return [
    [...WDT_IMPORT_HEADERS],
    ...lines.map((line) => renderWdtImportRow(line, addressIndex, WDT_IMPORT_HEADERS, context, actor)),
  ];
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
    仓库名称: line.fulfillmentWarehouseName,
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

  const originalNoByGroupKey = new Map<string, string>();
  for (const line of lines) {
    const groupKey = makeOrderFulfillmentKey(line);
    let originalNo = originalNoByGroupKey.get(groupKey);
    if (!originalNo) {
      originalNo = buildWdtOriginalNo(batch, originalNoByGroupKey.size + 1);
      originalNoByGroupKey.set(groupKey, originalNo);
    }
    originalNoByLineId.set(line.id, originalNo);
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

function makeOrderFulfillmentKey(line: Pick<ReviewLineDto, "storeNo" | "storeName" | "fulfillmentWarehouseNo" | "fulfillmentWarehouseName">) {
  const warehouseKey = line.fulfillmentWarehouseNo
    ? `no:${line.fulfillmentWarehouseNo.trim().toUpperCase()}`
    : `name:${line.fulfillmentWarehouseName.trim().toLocaleLowerCase("zh-CN")}`;
  return `${makeOrderStoreKey(line)}|warehouse:${warehouseKey}`;
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
  const shippableLines = lines.filter((line) => line.approvedShipQty > 0);
  const missingByStore = new Map<string, MissingMakeOrderStoreDto>();
  const missingWarehouseLines = shippableLines
    .filter((line) => !hasFulfillmentWarehouse(line))
    .map((line) => ({
      reviewLineId: line.id,
      storeNo: line.storeNo,
      storeName: line.storeName,
      goodsName: line.externalGoodsName || line.goodsName,
      orderNoticeNo: line.orderNoticeNo,
    }));

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
    shippableLineCount: shippableLines.length,
    missingAddressCount: missingStores.length,
    missingStores,
    missingWarehouseCount: missingWarehouseLines.length,
    missingWarehouseLines,
    canExport: shippableLines.length > 0 && missingStores.length === 0 && missingWarehouseLines.length === 0,
  };
}

function hasFulfillmentWarehouse(line: Pick<ReviewLineDto, "fulfillmentWarehouseNo" | "fulfillmentWarehouseName">) {
  return Boolean(line.fulfillmentWarehouseNo.trim() && line.fulfillmentWarehouseName.trim());
}

function makeOrderReadinessError(readiness: MakeOrderReadinessDto) {
  if (readiness.shippableLineCount === 0) return "没有可做单的发货明细";
  if (readiness.missingWarehouseCount > 0) return `还有 ${readiness.missingWarehouseCount} 条发货明细未选择仓库`;
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
