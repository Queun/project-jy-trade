import { randomUUID } from "node:crypto";

import type { WdtSyncRunDto } from "@jy-trade/shared";
import type { WdtStockRow } from "../../../backend/src/integrations/wdtClient.js";
import type { StockLookupClient } from "./store.js";
import {
  chunk,
  queryStockWithRetry,
  validateStockBatchResponse,
  WDT_SYNC_BATCH_SIZE,
  WDT_SYNC_MIN_INTERVAL_MS,
  type StockSyncScope,
} from "./wdtCombinedSync.js";
import { flattenWdtGoodsSpecs, type WdtGoodsSpecPayload, type WdtGoodsWindowClient } from "./wdtGoodsSync.js";
import { flattenWdtSuites, type WdtSuitePayload, type WdtSuiteWindowClient } from "./wdtSuiteSync.js";

export const QUICK_SYNC_LOOKBACK_HOURS = 24;
export const QUICK_SYNC_MAX_CHANGED_RECORDS = 500;
export const QUICK_SYNC_MAX_STOCK_SPECS = 400;
const QUICK_SYNC_PAGE_SIZE = 500;
const QUICK_SYNC_RETRY_DELAYS_MS = [1_000, 3_000];

type RawGoods = Awaited<ReturnType<WdtGoodsWindowClient["queryGoodsWindow"]>>["goods"][number];

export interface QuickGoodsChanges {
  goodsNos: string[];
  deletedGoodsNos: string[];
  specs: WdtGoodsSpecPayload[];
  recordCount: number;
  pageCount: number;
}

export interface QuickSuiteChanges {
  suites: WdtSuitePayload[];
  recordCount: number;
  pageCount: number;
}

export interface QuickSyncPlan {
  baseRunId: string;
  scope: StockSyncScope;
  affectedSpecNos: string[];
  refreshSpecNos: string[];
  goods: QuickGoodsChanges;
  suites: QuickSuiteChanges;
}

export interface QuickSyncRepository {
  findActiveRun(): Promise<WdtSyncRunDto | undefined>;
  createRun(input: { id: string; trigger: "quick_manual"; now: string }): Promise<WdtSyncRunDto>;
  updateRun(runId: string, patch: Partial<WdtSyncRunDto>): Promise<void>;
  buildPlan(goods: QuickGoodsChanges, suites: QuickSuiteChanges): Promise<QuickSyncPlan>;
  prepareSnapshot(runId: string, plan: QuickSyncPlan, syncedAt: string): Promise<void>;
  writeStockBatch(runId: string, requestedSpecNos: string[], rows: WdtStockRow[], syncedAt: string, scope: StockSyncScope): Promise<number>;
  activateRun(runId: string, plan: QuickSyncPlan, finishedAt: string): Promise<void>;
  failRun(runId: string, errorCode: string, errorMessage: string, errorDetail: string, finishedAt: string): Promise<void>;
}

export async function startQuickSync(
  repository: QuickSyncRepository,
  goodsClient: WdtGoodsWindowClient,
  suiteClient: WdtSuiteWindowClient,
  stockClient: StockLookupClient,
): Promise<{ run: WdtSyncRunDto; alreadyRunning: boolean; task?: Promise<void> }> {
  const active = await repository.findActiveRun();
  if (active) return { run: active, alreadyRunning: true };
  const now = new Date().toISOString();
  const run = await repository.createRun({ id: `wdt-quick-sync-${randomUUID()}`, trigger: "quick_manual", now });
  return {
    run,
    alreadyRunning: false,
    task: executeQuickSync(repository, goodsClient, suiteClient, stockClient, run.id),
  };
}

export async function executeQuickSync(
  repository: QuickSyncRepository,
  goodsClient: WdtGoodsWindowClient,
  suiteClient: WdtSuiteWindowClient,
  stockClient: StockLookupClient,
  runId: string,
  now = new Date(),
): Promise<void> {
  try {
    const rangeEnd = now;
    const rangeStart = new Date(rangeEnd.getTime() - QUICK_SYNC_LOOKBACK_HOURS * 60 * 60 * 1_000);

    await repository.updateRun(runId, { status: "running", stage: "goods", lastProgressAt: new Date().toISOString() });
    const goods = await fetchQuickGoodsChanges(goodsClient, rangeStart, rangeEnd);
    assertRecordLimit("商品", goods.recordCount);

    await repository.updateRun(runId, { stage: "suites", lastProgressAt: new Date().toISOString() });
    const suites = await fetchQuickSuiteChanges(suiteClient, rangeStart, rangeEnd);
    assertRecordLimit("组合装", suites.recordCount);

    await repository.updateRun(runId, { stage: "prepare_stock", lastProgressAt: new Date().toISOString() });
    const plan = await repository.buildPlan(goods, suites);
    if (plan.refreshSpecNos.length > QUICK_SYNC_MAX_STOCK_SPECS) {
      throw new QuickSyncError(
        "QUICK_SYNC_TOO_MANY_SPECS",
        "本次变化商品过多，请使用完整同步",
        `refresh_spec_count=${plan.refreshSpecNos.length} limit=${QUICK_SYNC_MAX_STOCK_SPECS}`,
      );
    }

    const startedAt = new Date().toISOString();
    await repository.prepareSnapshot(runId, plan, startedAt);
    const batches = chunk(plan.refreshSpecNos, stockClient.queryStocks ? WDT_SYNC_BATCH_SIZE : 1);
    await repository.updateRun(runId, {
      stage: "stock",
      totalSpecCount: plan.refreshSpecNos.length,
      totalBatchCount: batches.length,
      lastProgressAt: startedAt,
    });

    let processedSpecCount = 0;
    let stockRowCount = 0;
    let lastRequestStartedAt = 0;
    for (const [index, batch] of batches.entries()) {
      const minimumInterval = isTestRuntime() ? 0 : WDT_SYNC_MIN_INTERVAL_MS;
      const waitMs = Math.max(0, lastRequestStartedAt + minimumInterval - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      lastRequestStartedAt = Date.now();
      const response = plan.scope.warehouseTypes.length === 0
        ? { status: 0, data: { total_count: 0, detail_list: [] } }
        : await queryStockWithRetry(stockClient, batch, plan.scope.apiWarehouseNo);
      if (response.status && response.status !== 0) {
        throw new QuickSyncError(
          "WDT_STOCK_ERROR",
          "旺店通库存同步失败，快速同步未生效",
          `requested=${batch.join(",")} status=${response.status} message=${response.message ?? ""}`,
        );
      }
      validateStockBatchResponse(batch, response);
      const syncedAt = new Date().toISOString();
      stockRowCount += await repository.writeStockBatch(runId, batch, response.data?.detail_list ?? [], syncedAt, plan.scope);
      processedSpecCount += batch.length;
      await repository.updateRun(runId, {
        processedSpecCount,
        completedBatchCount: index + 1,
        stockRowCount,
        lastProgressAt: syncedAt,
      });
    }

    const finishedAt = new Date().toISOString();
    await repository.updateRun(runId, { stage: "activate", lastProgressAt: finishedAt });
    await repository.activateRun(runId, plan, finishedAt);
  } catch (error) {
    const failure = error instanceof QuickSyncError
      ? error
      : new QuickSyncError(
        "QUICK_SYNC_FAILED",
        "快速同步未生效，请使用完整同步",
        error instanceof Error ? error.message : String(error),
      );
    await repository.failRun(runId, failure.code, failure.userMessage, failure.detail, new Date().toISOString());
  }
}

async function fetchQuickGoodsChanges(client: WdtGoodsWindowClient, start: Date, end: Date): Promise<QuickGoodsChanges> {
  const rawGoods: RawGoods[] = [];
  let pageNo = 0;
  let totalCount = 0;
  do {
    const response = await queryWithRetry(() => client.queryGoodsWindow({
      startTime: formatShanghaiDateTime(start),
      endTime: formatShanghaiDateTime(end),
      pageNo,
      pageSize: QUICK_SYNC_PAGE_SIZE,
      hideDeleted: false,
    }));
    totalCount = response.totalCount;
    assertRecordLimit("商品", totalCount);
    if (totalCount > 0 && response.goods.length === 0) {
      throw new QuickSyncError("QUICK_SYNC_INCOMPLETE_GOODS", "商品增量响应不完整，请使用完整同步", `page_no=${pageNo} total_count=${totalCount}`);
    }
    rawGoods.push(...response.goods);
    pageNo += 1;
  } while (pageNo * QUICK_SYNC_PAGE_SIZE < totalCount);

  const goodsNos = [...new Set(rawGoods.map((goods) => goods.goods_no?.trim()).filter((value): value is string => Boolean(value)))];
  const specs = dedupeBy(flattenWdtGoodsSpecs(rawGoods), (spec) => spec.specNo);
  if (rawGoods.some((goods) => !goods.goods_no?.trim() && !(goods.spec_list ?? []).some((spec) => spec.spec_no?.trim()))) {
    throw new QuickSyncError("QUICK_SYNC_UNIDENTIFIED_GOODS", "商品增量存在无法识别的记录，请使用完整同步", "goods_no and spec_no are both empty");
  }
  const deletedGoodsNos = [...new Set(rawGoods.filter((goods) => Number(goods.deleted ?? 0) > 0).map((goods) => goods.goods_no?.trim()).filter((value): value is string => Boolean(value)))];
  return { goodsNos, deletedGoodsNos, specs, recordCount: totalCount, pageCount: pageNo };
}

async function fetchQuickSuiteChanges(client: WdtSuiteWindowClient, start: Date, end: Date): Promise<QuickSuiteChanges> {
  const suites: WdtSuitePayload[] = [];
  let pageNo = 0;
  let totalCount = 0;
  do {
    const response = await queryWithRetry(() => client.querySuitesWindow({
      startTime: formatShanghaiDateTime(start),
      endTime: formatShanghaiDateTime(end),
      pageNo,
      pageSize: QUICK_SYNC_PAGE_SIZE,
      hideDeleted: false,
    }));
    totalCount = response.totalCount;
    assertRecordLimit("组合装", totalCount);
    if (totalCount > 0 && response.suites.length === 0) {
      throw new QuickSyncError("QUICK_SYNC_INCOMPLETE_SUITES", "组合装增量响应不完整，请使用完整同步", `page_no=${pageNo} total_count=${totalCount}`);
    }
    suites.push(...flattenWdtSuites(response.suites));
    pageNo += 1;
  } while (pageNo * QUICK_SYNC_PAGE_SIZE < totalCount);
  return { suites: dedupeBy(suites, (suite) => suite.suiteNo), recordCount: totalCount, pageCount: pageNo };
}

async function queryWithRetry<T>(query: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= QUICK_SYNC_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await query();
    } catch (error) {
      lastError = error;
      if (attempt < QUICK_SYNC_RETRY_DELAYS_MS.length) {
        await sleep(isTestRuntime() ? 0 : QUICK_SYNC_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function assertRecordLimit(label: string, count: number): void {
  if (count <= QUICK_SYNC_MAX_CHANGED_RECORDS) return;
  throw new QuickSyncError(
    "QUICK_SYNC_TOO_MANY_CHANGES",
    `最近变化${label}过多，请使用完整同步`,
    `record_count=${count} limit=${QUICK_SYNC_MAX_CHANGED_RECORDS}`,
  );
}

export function formatShanghaiDateTime(date: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

class QuickSyncError extends Error {
  constructor(public code: string, public userMessage: string, public detail: string) {
    super(detail);
  }
}

function dedupeBy<T>(values: T[], keyOf: (value: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const value of values) byKey.set(keyOf(value), value);
  return [...byKey.values()];
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function isTestRuntime(): boolean {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}
