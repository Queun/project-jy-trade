import { randomUUID } from "node:crypto";

export interface WdtGoodsSpecPayload {
  goodsNo: string;
  goodsName: string;
  specNo: string;
  specName: string;
  specCode: string;
  barcode: string;
  barcodes: string[];
  deleted: number;
  modified: string;
  raw: unknown;
}

export interface WdtGoodsWindowClient {
  queryGoodsWindow(input: { startTime: string; endTime: string; pageNo: number; pageSize: number; hideDeleted?: boolean }): Promise<{
    totalCount: number;
    goods: Array<{
      goods_no?: string;
      goods_name?: string;
      deleted?: number;
      modified?: string;
      spec_list?: Array<{
        spec_no?: string;
        spec_code?: string;
        barcode?: string;
        spec_name?: string;
        deleted?: number;
        modified?: string;
        spec_modified?: string | number;
        barcode_list?: Array<{ barcode?: string; is_master?: number; type?: number }>;
      }>;
    }>;
  }>;
}

export interface GoodsSyncRepository {
  createGoodsSyncRun(input: GoodsSyncRunInsert): Promise<GoodsSyncRunRecord>;
  finishGoodsSyncRun(runId: string, patch: GoodsSyncRunFinishPatch): Promise<GoodsSyncRunRecord>;
  getLatestSuccessfulGoodsSyncRun(): Promise<GoodsSyncRunRecord | undefined>;
  upsertGoodsSpecs(specs: WdtGoodsSpecPayload[], syncedAt: string): Promise<number>;
}

export interface GoodsSyncRunInsert {
  id: string;
  mode: GoodsSyncMode;
  status: "running";
  startedAt: string;
  rangeStart: string;
  rangeEnd: string;
}

export interface GoodsSyncRunFinishPatch {
  status: "success" | "failed";
  finishedAt: string;
  windowCount: number;
  pageCount: number;
  fetchedCount: number;
  upsertedCount: number;
  errorMessage: string;
}

export interface GoodsSyncRunRecord {
  id: string;
  mode: GoodsSyncMode;
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt: string;
  rangeStart: string;
  rangeEnd: string;
  windowCount: number;
  pageCount: number;
  fetchedCount: number;
  upsertedCount: number;
  errorMessage: string;
}

export type GoodsSyncMode = "full" | "incremental";

export interface RunGoodsSyncOptions {
  mode: GoodsSyncMode;
  startDate?: string;
  endDate?: string;
  pageSize?: number;
  now?: Date;
  defaultStartDate?: string;
  overlapDays?: number;
  maxRetries?: number;
  retryDelaysMs?: number[];
}

export const DEFAULT_GOODS_SYNC_START_DATE = "2026-06-01";
export const DEFAULT_GOODS_SYNC_PAGE_SIZE = 500;
const DEFAULT_OVERLAP_DAYS = 1;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 8000];
const MAX_WINDOW_DAYS = 30;

export async function runWdtGoodsSync(
  repository: GoodsSyncRepository,
  client: WdtGoodsWindowClient,
  options: RunGoodsSyncOptions,
): Promise<GoodsSyncRunRecord> {
  const now = options.now ?? new Date();
  const rangeEnd = parseDateBoundary(options.endDate, false) ?? now;
  const rangeStart = await resolveRangeStart(repository, options, rangeEnd);
  const pageSize = options.pageSize ?? Number(process.env.WDT_GOODS_SYNC_PAGE_SIZE ?? DEFAULT_GOODS_SYNC_PAGE_SIZE);
  const maxRetries = options.maxRetries ?? Number(process.env.WDT_GOODS_SYNC_MAX_RETRIES ?? DEFAULT_MAX_RETRIES);
  const retryDelaysMs = options.retryDelaysMs ?? parseRetryDelays(process.env.WDT_GOODS_SYNC_RETRY_DELAYS_MS) ?? DEFAULT_RETRY_DELAYS_MS;
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > 1000) {
    throw new Error("WDT goods sync pageSize must be an integer between 1 and 1000");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new Error("WDT goods sync maxRetries must be a positive integer");
  }
  if (rangeStart > rangeEnd) {
    throw new Error("WDT goods sync start date must be before end date");
  }

  const startedAt = now.toISOString();
  const run = await repository.createGoodsSyncRun({
    id: `wdt-goods-sync-${randomUUID()}`,
    mode: options.mode,
    status: "running",
    startedAt,
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
  });

  let windowCount = 0;
  let pageCount = 0;
  let fetchedCount = 0;
  let upsertedCount = 0;

  try {
    for (const window of buildDateWindows(rangeStart, rangeEnd)) {
      windowCount += 1;
      let pageNo = 0;
      let totalCount: number | undefined;
      do {
        const startTime = formatWdtDateTime(window.start);
        const endTime = formatWdtDateTime(window.end);
        const response = await queryGoodsWindowWithRetry(client, {
          startTime,
          endTime,
          pageNo,
          pageSize,
          maxRetries,
          retryDelaysMs,
        });
        pageCount += 1;
        totalCount = response.totalCount;
        const specs = flattenWdtGoodsSpecs(response.goods);
        fetchedCount += specs.length;
        if (specs.length > 0) {
          upsertedCount += await repository.upsertGoodsSpecs(specs, new Date().toISOString());
        }
        pageNo += 1;
      } while (totalCount !== undefined && pageNo * pageSize < totalCount);
    }

    return repository.finishGoodsSyncRun(run.id, {
      status: "success",
      finishedAt: new Date().toISOString(),
      windowCount,
      pageCount,
      fetchedCount,
      upsertedCount,
      errorMessage: "",
    });
  } catch (error) {
    return repository.finishGoodsSyncRun(run.id, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      windowCount,
      pageCount,
      fetchedCount,
      upsertedCount,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

interface QueryGoodsWindowWithRetryOptions {
  startTime: string;
  endTime: string;
  pageNo: number;
  pageSize: number;
  maxRetries: number;
  retryDelaysMs: number[];
}

async function queryGoodsWindowWithRetry(client: WdtGoodsWindowClient, options: QueryGoodsWindowWithRetryOptions) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxRetries; attempt += 1) {
    try {
      return await client.queryGoodsWindow({
        startTime: options.startTime,
        endTime: options.endTime,
        pageNo: options.pageNo,
        pageSize: options.pageSize,
      });
    } catch (error) {
      lastError = error;
      if (attempt < options.maxRetries) {
        await sleep(options.retryDelaysMs[Math.min(attempt - 1, options.retryDelaysMs.length - 1)] ?? 0);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    [
      "WDT goods query failed after retries",
      "method=goods.Goods.queryWithSpec",
      `window=${options.startTime}~${options.endTime}`,
      `page_no=${options.pageNo}`,
      `page_size=${options.pageSize}`,
      `attempts=${options.maxRetries}`,
      `error=${message}`,
    ].join(" "),
  );
}

export function flattenWdtGoodsSpecs(goods: Awaited<ReturnType<WdtGoodsWindowClient["queryGoodsWindow"]>>["goods"]): WdtGoodsSpecPayload[] {
  const specs: WdtGoodsSpecPayload[] = [];
  for (const item of goods) {
    for (const spec of item.spec_list ?? []) {
      if (!spec.spec_no) continue;
      const barcodes = collectSpecBarcodes(spec);
      specs.push({
        goodsNo: item.goods_no ?? "",
        goodsName: item.goods_name ?? "",
        specNo: spec.spec_no,
        specName: spec.spec_name ?? "",
        specCode: spec.spec_code ?? "",
        barcode: pickMasterBarcode(spec, barcodes),
        barcodes,
        deleted: Number(spec.deleted ?? item.deleted ?? 0),
        modified: String(spec.modified ?? spec.spec_modified ?? item.modified ?? ""),
        raw: { goods: item, spec },
      });
    }
  }
  return specs;
}

function parseRetryDelays(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const delays = value.split(",").map((item) => Number(item.trim()));
  if (delays.some((item) => !Number.isFinite(item) || item < 0)) {
    throw new Error("WDT goods sync retry delays must be comma-separated non-negative numbers");
  }
  return delays;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildDateWindows(start: Date, end: Date): Array<{ start: Date; end: Date }> {
  const windows: Array<{ start: Date; end: Date }> = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const windowEnd = new Date(cursor);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + MAX_WINDOW_DAYS);
    windowEnd.setUTCMilliseconds(windowEnd.getUTCMilliseconds() - 1);
    const cappedEnd = windowEnd < end ? windowEnd : new Date(end);
    windows.push({ start: new Date(cursor), end: cappedEnd });
    cursor = new Date(cappedEnd);
    cursor.setUTCMilliseconds(cursor.getUTCMilliseconds() + 1);
  }
  return windows;
}

export function formatWdtDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

async function resolveRangeStart(repository: GoodsSyncRepository, options: RunGoodsSyncOptions, rangeEnd: Date): Promise<Date> {
  const explicitStart = parseDateBoundary(options.startDate, true);
  if (explicitStart) return explicitStart;

  if (options.mode === "incremental") {
    const latest = await repository.getLatestSuccessfulGoodsSyncRun();
    if (latest?.rangeEnd) {
      const overlapDays = options.overlapDays ?? Number(process.env.WDT_GOODS_SYNC_OVERLAP_DAYS ?? DEFAULT_OVERLAP_DAYS);
      const start = new Date(latest.rangeEnd);
      start.setUTCDate(start.getUTCDate() - overlapDays);
      return start;
    }
  }

  const defaultStart = options.defaultStartDate ?? process.env.WDT_GOODS_SYNC_START_DATE ?? DEFAULT_GOODS_SYNC_START_DATE;
  return parseDateBoundary(defaultStart, true) ?? new Date(rangeEnd);
}

function parseDateBoundary(value: string | undefined, startOfDay: boolean): Date | undefined {
  if (!value) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${startOfDay ? "00:00:00.000" : "23:59:59.999"}Z`
    : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

function collectSpecBarcodes(spec: { barcode?: string; barcode_list?: Array<{ barcode?: string }> }): string[] {
  return [...new Set([spec.barcode, ...(spec.barcode_list ?? []).map((item) => item.barcode)].filter((item): item is string => Boolean(item)))];
}

function pickMasterBarcode(
  spec: { barcode?: string; barcode_list?: Array<{ barcode?: string; is_master?: number }> },
  barcodes: string[],
): string {
  return spec.barcode ?? spec.barcode_list?.find((item) => item.is_master === 1)?.barcode ?? barcodes[0] ?? "";
}
