import { randomUUID } from "node:crypto";

import type { WarehouseSnapshotType, WdtSyncRunDto } from "@jy-trade/shared";
import type { WdtStockRow } from "../../../backend/src/integrations/wdtClient.js";
import type { StockLookupClient } from "./store.js";

export const WDT_SYNC_BATCH_SIZE = 40;
export const WDT_SYNC_MIN_INTERVAL_MS = 1_100;
const DEFAULT_RETRY_DELAYS_MS = [1_500];

export interface StockSyncScope {
  warehouseTypes: WarehouseSnapshotType[];
  apiWarehouseNo: string;
}

export interface CombinedSyncRepository {
  findActiveRun(): Promise<WdtSyncRunDto | undefined>;
  createRun(input: { id: string; trigger: WdtSyncRunDto["trigger"]; now: string }): Promise<WdtSyncRunDto>;
  updateRun(runId: string, patch: Partial<WdtSyncRunDto>): Promise<void>;
  runGoodsIncremental(): Promise<{ id: string; status: "success" | "failed"; errorMessage: string }>;
  loadStockSpecNos(): Promise<string[]>;
  loadStockScope(): Promise<StockSyncScope>;
  writeStockBatch(runId: string, requestedSpecNos: string[], rows: WdtStockRow[], syncedAt: string, scope: StockSyncScope): Promise<number>;
  activateRun(runId: string, finishedAt: string, scope: StockSyncScope): Promise<void>;
  failRun(runId: string, errorCode: string, errorMessage: string, errorDetail: string, finishedAt: string): Promise<void>;
}

export async function startCombinedSync(
  repository: CombinedSyncRepository,
  stockClient: StockLookupClient,
  trigger: WdtSyncRunDto["trigger"],
): Promise<{ run: WdtSyncRunDto; alreadyRunning: boolean; task?: Promise<void> }> {
  const active = await repository.findActiveRun();
  if (active) return { run: active, alreadyRunning: true };
  const now = new Date().toISOString();
  const run = await repository.createRun({ id: `wdt-sync-${randomUUID()}`, trigger, now });
  const task = executeCombinedSync(repository, stockClient, run.id);
  return { run, alreadyRunning: false, task };
}

export async function executeCombinedSync(repository: CombinedSyncRepository, stockClient: StockLookupClient, runId: string) {
  try {
    let now = new Date().toISOString();
    await repository.updateRun(runId, { status: "running", stage: "goods", lastProgressAt: now });
    const goodsRun = await repository.runGoodsIncremental();
    if (goodsRun.status !== "success") throw new SyncRunError("GOODS_SYNC_FAILED", "商品档案同步失败", goodsRun.errorMessage);
    await repository.updateRun(runId, { goodsSyncRunId: goodsRun.id, stage: "prepare_stock", lastProgressAt: new Date().toISOString() });

    const specNos = [...new Set((await repository.loadStockSpecNos()).map((value) => value.trim()).filter(Boolean))].sort();
    const scope = await repository.loadStockScope();
    const batches = chunk(specNos, stockClient.queryStocks ? WDT_SYNC_BATCH_SIZE : 1);
    await repository.updateRun(runId, {
      stage: "stock",
      totalSpecCount: specNos.length,
      totalBatchCount: batches.length,
      lastProgressAt: new Date().toISOString(),
    });
    let processed = 0;
    let rowCount = 0;
    let lastStockRequestStartedAt = 0;
    for (const [index, batch] of batches.entries()) {
      const minimumInterval = process.env.NODE_ENV === "test" ? 0 : WDT_SYNC_MIN_INTERVAL_MS;
      const waitMs = Math.max(0, lastStockRequestStartedAt + minimumInterval - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      lastStockRequestStartedAt = Date.now();
      let response: Awaited<ReturnType<StockLookupClient["queryStock"]>>;
      try {
        response = scope.warehouseTypes.length === 0
          ? { status: 0, data: { total_count: 0, detail_list: [] } }
          : await queryStockWithRetry(stockClient, batch, scope.apiWarehouseNo);
      } catch (error) {
        throw new SyncRunError(
          "WDT_STOCK_ERROR",
          "旺店通库存同步失败",
          `requested=${batch.join(",")} error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status && response.status !== 0) {
        throw new SyncRunError(
          "WDT_STOCK_ERROR",
          "旺店通库存同步失败",
          `requested=${batch.join(",")} status=${response.status} message=${response.message ?? ""} response=${JSON.stringify(response)}`,
        );
      }
      validateStockBatchResponse(batch, response);
      now = new Date().toISOString();
      rowCount += await repository.writeStockBatch(runId, batch, response.data?.detail_list ?? [], now, scope);
      processed += batch.length;
      await repository.updateRun(runId, {
        processedSpecCount: processed,
        completedBatchCount: index + 1,
        stockRowCount: rowCount,
        lastProgressAt: now,
      });
    }
    now = new Date().toISOString();
    await repository.updateRun(runId, { stage: "activate", lastProgressAt: now });
    await repository.activateRun(runId, now, scope);
  } catch (error) {
    const failure = error instanceof SyncRunError
      ? error
      : new SyncRunError("SYNC_FAILED", "商品与库存同步失败", error instanceof Error ? error.message : String(error));
    await repository.failRun(runId, failure.code, failure.userMessage, failure.detail, new Date().toISOString());
  }
}

class SyncRunError extends Error {
  constructor(public code: string, public userMessage: string, public detail: string) {
    super(detail);
  }
}

async function queryStockWithRetry(stockClient: StockLookupClient, specNos: string[], warehouseNo: string) {
  let lastError: unknown;
  const retryDelays = process.env.NODE_ENV === "test" ? [0] : parseRetryDelays(process.env.WDT_STOCK_SYNC_RETRY_DELAYS_MS);
  for (const delayMs of [0, ...retryDelays]) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const response = stockClient.queryStocks
        ? await stockClient.queryStocks(specNos, warehouseNo || undefined)
        : await stockClient.queryStock(specNos[0] ?? "", warehouseNo || undefined);
      if (!response.status || response.status === 0 || !isRetryable(`${response.status} ${response.message ?? ""}`)) return response;
      lastError = new Error(`status=${response.status} message=${response.message ?? ""}`);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("库存同步失败");
}

function parseRetryDelays(value: string | undefined) {
  if (!value?.trim()) return DEFAULT_RETRY_DELAYS_MS;
  const delays = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 0);
  return delays.length > 0 ? delays : DEFAULT_RETRY_DELAYS_MS;
}

function validateStockBatchResponse(specNos: string[], response: Awaited<ReturnType<StockLookupClient["queryStock"]>>) {
  const rows = response.data?.detail_list ?? [];
  const totalCount = response.data?.total_count;
  if (totalCount !== undefined && (!Number.isInteger(totalCount) || totalCount !== rows.length)) {
    throw new SyncRunError(
      "WDT_STOCK_INCOMPLETE",
      "旺店通库存响应不完整，本次快照未生效",
      `requested=${specNos.length} total_count=${totalCount} received=${rows.length}`,
    );
  }
  const requested = new Set(specNos);
  for (const row of rows) {
    const specNo = (row.spec_no ?? "").trim();
    if (!specNo || !requested.has(specNo)) {
      throw new SyncRunError(
        "WDT_STOCK_UNEXPECTED_ROW",
        "旺店通库存响应无法与请求商品对应，本次快照未生效",
        `requested=${specNos.join(",")} response_spec_no=${specNo || "<empty>"}`,
      );
    }
  }
}

function isRetryable(detail: string) {
  return detail.includes("并发") || detail.includes("频率") || detail.includes("100");
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
