import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";

import type { DatabaseContext } from "./db/client.js";
import { wdtSuiteComponents, wdtSuites, wdtSuiteSyncRuns } from "./db/schema.js";
import { buildDateWindows, formatWdtDateTime, type GoodsSyncMode } from "./wdtGoodsSync.js";

export interface WdtSuitePayload {
  suiteNo: string;
  suiteName: string;
  barcode: string;
  deleted: number;
  modified: string;
  raw: unknown;
  components: WdtSuiteComponentPayload[];
}

export interface WdtSuiteComponentPayload {
  recId: string;
  specNo: string;
  goodsNo: string;
  goodsName: string;
  specName: string;
  specCode: string;
  barcode: string;
  quantity: number;
  ratio: number;
  deleted: number;
  raw: unknown;
}

export interface WdtSuiteWindowClient {
  querySuitesWindow(input: { startTime: string; endTime: string; pageNo: number; pageSize: number }): Promise<{
    totalCount: number;
    suites: Array<{
      suite_no?: string;
      suite_name?: string;
      barcode?: string;
      deleted?: number;
      suite_modified?: string | number;
      modified?: string | number;
      detail_list?: Array<{
        rec_id?: string | number;
        spec_no?: string;
        goods_no?: string;
        goods_name?: string;
        spec_name?: string;
        spec_code?: string;
        barcode?: string;
        num?: number | string;
        ratio?: number | string;
        deleted?: number;
      }>;
    }>;
  }>;
}

export interface SuiteSyncRepository {
  createSuiteSyncRun(input: SuiteSyncRunInsert): Promise<SuiteSyncRunRecord>;
  finishSuiteSyncRun(runId: string, patch: SuiteSyncRunFinishPatch): Promise<SuiteSyncRunRecord>;
  getLatestSuccessfulSuiteSyncRun(): Promise<SuiteSyncRunRecord | undefined>;
  upsertSuites(suites: WdtSuitePayload[], syncedAt: string): Promise<number>;
}

export interface SuiteSyncRunInsert {
  id: string;
  mode: GoodsSyncMode;
  status: "running";
  startedAt: string;
  rangeStart: string;
  rangeEnd: string;
}

export interface SuiteSyncRunFinishPatch {
  status: "success" | "failed";
  finishedAt: string;
  windowCount: number;
  pageCount: number;
  fetchedCount: number;
  upsertedCount: number;
  errorMessage: string;
}

export interface SuiteSyncRunRecord {
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

export interface RunSuiteSyncOptions {
  mode: GoodsSyncMode;
  startDate?: string;
  endDate?: string;
  pageSize?: number;
  now?: Date;
  defaultStartDate?: string;
  overlapDays?: number;
}

export const DEFAULT_SUITE_SYNC_START_DATE = "2026-06-01";
export const DEFAULT_SUITE_SYNC_PAGE_SIZE = 500;
const DEFAULT_OVERLAP_DAYS = 1;

export async function runWdtSuiteSync(
  repository: SuiteSyncRepository,
  client: WdtSuiteWindowClient,
  options: RunSuiteSyncOptions,
): Promise<SuiteSyncRunRecord> {
  const now = options.now ?? new Date();
  const rangeEnd = parseDateBoundary(options.endDate, false) ?? now;
  const rangeStart = await resolveSuiteRangeStart(repository, options, rangeEnd);
  const pageSize = options.pageSize ?? Number(process.env.WDT_SUITE_SYNC_PAGE_SIZE ?? DEFAULT_SUITE_SYNC_PAGE_SIZE);
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > 1000) {
    throw new Error("WDT suite sync pageSize must be an integer between 1 and 1000");
  }
  if (rangeStart > rangeEnd) {
    throw new Error("WDT suite sync start date must be before end date");
  }

  const startedAt = now.toISOString();
  const run = await repository.createSuiteSyncRun({
    id: `wdt-suite-sync-${randomUUID()}`,
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
        const response = await client.querySuitesWindow({
          startTime: formatWdtDateTime(window.start),
          endTime: formatWdtDateTime(window.end),
          pageNo,
          pageSize,
        });
        pageCount += 1;
        totalCount = response.totalCount;
        const suites = flattenWdtSuites(response.suites);
        fetchedCount += suites.length;
        if (suites.length > 0) {
          upsertedCount += await repository.upsertSuites(suites, new Date().toISOString());
        }
        pageNo += 1;
      } while (totalCount !== undefined && pageNo * pageSize < totalCount);
    }

    return repository.finishSuiteSyncRun(run.id, {
      status: "success",
      finishedAt: new Date().toISOString(),
      windowCount,
      pageCount,
      fetchedCount,
      upsertedCount,
      errorMessage: "",
    });
  } catch (error) {
    return repository.finishSuiteSyncRun(run.id, {
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

export function flattenWdtSuites(suites: Awaited<ReturnType<WdtSuiteWindowClient["querySuitesWindow"]>>["suites"]): WdtSuitePayload[] {
  return suites
    .filter((suite) => suite.suite_no)
    .map((suite) => ({
      suiteNo: suite.suite_no ?? "",
      suiteName: suite.suite_name ?? "",
      barcode: suite.barcode ?? "",
      deleted: Number(suite.deleted ?? 0),
      modified: String(suite.suite_modified ?? suite.modified ?? ""),
      raw: suite,
      components: (suite.detail_list ?? []).map((component, index) => ({
        recId: String(component.rec_id ?? index + 1),
        specNo: component.spec_no ?? "",
        goodsNo: component.goods_no ?? "",
        goodsName: component.goods_name ?? "",
        specName: component.spec_name ?? "",
        specCode: component.spec_code ?? "",
        barcode: component.barcode ?? "",
        quantity: numberFromWdtCell(component.num, 1),
        ratio: numberFromWdtCell(component.ratio, 1),
        deleted: Number(component.deleted ?? 0),
        raw: component,
      })),
    }));
}

export function createSuiteSyncRepository(database: DatabaseContext): SuiteSyncRepository {
  return {
    async createSuiteSyncRun(input) {
      const row: typeof wdtSuiteSyncRuns.$inferInsert = {
        ...input,
        finishedAt: "",
        windowCount: 0,
        pageCount: 0,
        fetchedCount: 0,
        upsertedCount: 0,
        errorMessage: "",
      };
      await database.db.insert(wdtSuiteSyncRuns).values(row);
      return toSuiteSyncRunRecord(row);
    },

    async finishSuiteSyncRun(runId, patch) {
      await database.db.update(wdtSuiteSyncRuns).set(patch).where(eq(wdtSuiteSyncRuns.id, runId));
      const [row] = await database.db.select().from(wdtSuiteSyncRuns).where(eq(wdtSuiteSyncRuns.id, runId)).limit(1);
      if (!row) throw new Error(`WDT suite sync run not found after finish: ${runId}`);
      return toSuiteSyncRunRecord(row);
    },

    async getLatestSuccessfulSuiteSyncRun() {
      const [row] = await database.db
        .select()
        .from(wdtSuiteSyncRuns)
        .where(eq(wdtSuiteSyncRuns.status, "success"))
        .orderBy(desc(wdtSuiteSyncRuns.rangeEnd))
        .limit(1);
      return row ? toSuiteSyncRunRecord(row) : undefined;
    },

    async upsertSuites(suites, syncedAt) {
      let upserted = 0;
      for (const suite of suites) {
        const row = toWdtSuiteInsert(suite, syncedAt);
        await database.db
          .insert(wdtSuites)
          .values(row)
          .onConflictDoUpdate({
            target: wdtSuites.suiteNo,
            set: {
              suiteName: row.suiteName,
              barcode: row.barcode,
              deleted: row.deleted,
              modified: row.modified,
              rawJson: row.rawJson,
              syncedAt: row.syncedAt,
            },
          });
        await database.db.delete(wdtSuiteComponents).where(eq(wdtSuiteComponents.suiteNo, suite.suiteNo));
        if (suite.components.length > 0) {
          await database.db.insert(wdtSuiteComponents).values(
            suite.components.map((component, index) => toWdtSuiteComponentInsert(suite.suiteNo, component, index + 1, syncedAt)),
          );
        }
        upserted += 1;
      }
      return upserted;
    },
  };
}

function toWdtSuiteInsert(suite: WdtSuitePayload, syncedAt: string): typeof wdtSuites.$inferInsert {
  return {
    id: `wdt-suite-${suite.suiteNo}`,
    suiteNo: suite.suiteNo,
    suiteName: suite.suiteName,
    barcode: suite.barcode,
    deleted: suite.deleted,
    modified: suite.modified,
    rawJson: JSON.stringify(suite.raw),
    syncedAt,
  };
}

function toWdtSuiteComponentInsert(
  suiteNo: string,
  component: WdtSuiteComponentPayload,
  sortOrder: number,
  syncedAt: string,
): typeof wdtSuiteComponents.$inferInsert {
  return {
    id: `wdt-suite-component-${suiteNo}-${component.recId}`,
    suiteNo,
    sortOrder,
    specNo: component.specNo,
    goodsNo: component.goodsNo,
    goodsName: component.goodsName,
    specName: component.specName,
    specCode: component.specCode,
    barcode: component.barcode,
    quantity: component.quantity,
    ratio: component.ratio,
    deleted: component.deleted,
    rawJson: JSON.stringify(component.raw),
    syncedAt,
  };
}

function toSuiteSyncRunRecord(row: typeof wdtSuiteSyncRuns.$inferSelect | typeof wdtSuiteSyncRuns.$inferInsert): SuiteSyncRunRecord {
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

async function resolveSuiteRangeStart(repository: SuiteSyncRepository, options: RunSuiteSyncOptions, rangeEnd: Date): Promise<Date> {
  const explicitStart = parseDateBoundary(options.startDate, true);
  if (explicitStart) return explicitStart;

  if (options.mode === "incremental") {
    const latest = await repository.getLatestSuccessfulSuiteSyncRun();
    if (latest?.rangeEnd) {
      const overlapDays = options.overlapDays ?? Number(process.env.WDT_SUITE_SYNC_OVERLAP_DAYS ?? DEFAULT_OVERLAP_DAYS);
      const start = new Date(latest.rangeEnd);
      start.setUTCDate(start.getUTCDate() - overlapDays);
      return start;
    }
  }

  const defaultStart = options.defaultStartDate ?? process.env.WDT_SUITE_SYNC_START_DATE ?? DEFAULT_SUITE_SYNC_START_DATE;
  return parseDateBoundary(defaultStart, true) ?? new Date(rangeEnd);
}

function parseDateBoundary(value: string | undefined, startOfDay: boolean): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(startOfDay ? 0 : 23, startOfDay ? 0 : 59, startOfDay ? 0 : 59, startOfDay ? 0 : 999);
  }
  return date;
}

function numberFromWdtCell(value: unknown, fallback: number): number {
  const numeric = typeof value === "string" ? Number(value.trim()) : Number(value ?? fallback);
  return Number.isFinite(numeric) ? numeric : fallback;
}
