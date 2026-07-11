import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  decideLocalProductMatch,
  type LocalGoodsSpecCandidate,
  type ProductMappingCandidate,
  type ProductMatchDecision,
} from "../../../packages/workflow/src/index.js";
import XLSX from "xlsx";

import { createDatabaseContext, type DatabaseContext } from "../../../apps/api/src/db/client.js";
import { productMappings, productMatchCandidates, wdtGoodsSpecs, wdtGoodsSyncRuns } from "../../../apps/api/src/db/schema.js";
import { loadOrderLines, type OrderLine } from "../core/orders.js";
import { effectiveWdtAvailableSendStock, getWdtAvailableSendStock, type WdtStockResponse, type WdtStockRow } from "../integrations/wdtClient.js";

export interface StockLookupClient {
  queryStock(specNo: string): Promise<WdtStockResponse>;
}

export interface DiagnoseOrderOptions {
  orderFile: string;
  outputFile: string;
  databaseUrl?: string;
  migrationsFolder?: string;
  allowStaleCache?: boolean;
  persistCandidates?: boolean;
  batchId?: string;
}

export interface DiagnoseOrderResult {
  outputFile: string;
  totalLines: number;
  matchedCount: number;
  ambiguousCount: number;
  notFoundCount: number;
  apiErrorCount: number;
  stockQueriedCount: number;
}

export interface WarehouseStockSummary {
  mainAvailableStock: number;
  nearExpiryAvailableStock: number;
  defectAvailableStock: number;
  otherAvailableStock: number;
  warehouseBreakdown: string;
  rows: WdtStockRow[];
}

export const MAIN_WAREHOUSE_NOS = ["001"];
export const NEAR_EXPIRY_WAREHOUSE_NOS = ["LINQI"];
export const DEFECT_WAREHOUSE_NOS = ["CIPIN"];

type GoodsSpecRow = typeof wdtGoodsSpecs.$inferSelect;
type ProductMappingRow = typeof productMappings.$inferSelect;

interface DiagnosisLine {
  sortOrder: number;
  orderLine: OrderLine;
  decision: ProductMatchDecision;
  stock?: WarehouseStockSummary;
}

interface GoodsCacheStatus {
  specCount: number;
  latestRunStatus: string;
  latestRunRangeStart: string;
  latestRunRangeEnd: string;
  latestRunErrorMessage: string;
  allowStaleCache: boolean;
  cacheWarning: string;
}

export async function diagnoseOrderWithDatabase(client: StockLookupClient, options: DiagnoseOrderOptions): Promise<DiagnoseOrderResult> {
  const database = createDatabaseContext(options.databaseUrl, options.migrationsFolder);
  try {
    await database.ready;
    const cacheStatus = await loadGoodsCacheStatus(database, Boolean(options.allowStaleCache));
    assertUsableGoodsCache(cacheStatus);
    const orderLines = loadOrderLines(options.orderFile);
    const goodsSpecs = await loadGoodsSpecs(database);
    const mappings = await loadProductMappings(database);
    const diagnosisLines = await diagnoseOrderLines(client, orderLines, goodsSpecs, mappings);
    if (options.persistCandidates ?? true) {
      await persistDiagnosisCandidates(database, diagnosisLines, options.batchId ?? buildDiagnosisBatchId(options.orderFile));
    }
    writeDiagnosisWorkbook(options.outputFile, diagnosisLines, cacheStatus);
    return buildDiagnosisResult(options.outputFile, diagnosisLines);
  } finally {
    await database.close();
  }
}

export async function diagnoseOrderLines(
  client: StockLookupClient,
  orderLines: OrderLine[],
  goodsSpecs: LocalGoodsSpecCandidate[],
  mappings: ProductMappingCandidate[],
): Promise<DiagnosisLine[]> {
  const results: DiagnosisLine[] = [];
  const stockBySpecNo = new Map<string, WarehouseStockSummary>();

  for (const [index, line] of orderLines.entries()) {
    const decision = decideLocalProductMatch(
      {
        barcode: line.externalBarcode,
        goodsCode: line.externalGoodsCode,
        goodsName: line.externalGoodsName,
        specName: line.spec,
      },
      { goodsSpecs, mappings },
    );

    let stock: WarehouseStockSummary | undefined;
    if (decision.status === "matched" && decision.candidate?.specNo) {
      const specNo = decision.candidate.specNo;
      stock = stockBySpecNo.get(specNo);
      if (!stock) {
        const response = await client.queryStock(specNo);
        if (response.status !== 0) {
          decision.status = "api_error";
          decision.message = `stock query status=${response.status ?? "unknown"}`;
        } else {
          stock = summarizeWarehouseStock(response.data?.detail_list ?? []);
          stockBySpecNo.set(specNo, stock);
        }
      }
    }

    results.push({ sortOrder: index + 1, orderLine: line, decision, stock });
  }

  return results;
}

export function summarizeWarehouseStock(rows: WdtStockRow[]): WarehouseStockSummary {
  let mainAvailableStock = 0;
  let nearExpiryAvailableStock = 0;
  let defectAvailableStock = 0;
  let otherAvailableStock = 0;
  const warehouses = new Map<string, { warehouseNo: string; warehouseName: string; defect: boolean; rawAvailableStock: number }>();

  for (const row of rows) {
    const warehouseNo = row.warehouse_no ?? "";
    const warehouseName = row.warehouse_name ?? "";
    const key = `${warehouseNo}|${warehouseName}`;
    const current = warehouses.get(key);
    warehouses.set(key, {
      warehouseNo,
      warehouseName,
      defect: Boolean(current?.defect || row.defect),
      rawAvailableStock: (current?.rawAvailableStock ?? 0) + getWdtAvailableSendStock(row),
    });
  }

  for (const warehouse of warehouses.values()) {
    const available = effectiveWdtAvailableSendStock(warehouse.rawAvailableStock);
    if (MAIN_WAREHOUSE_NOS.includes(warehouse.warehouseNo)) mainAvailableStock += available;
    else if (NEAR_EXPIRY_WAREHOUSE_NOS.includes(warehouse.warehouseNo)) nearExpiryAvailableStock += available;
    else if (DEFECT_WAREHOUSE_NOS.includes(warehouse.warehouseNo) || warehouse.defect) defectAvailableStock += available;
    else otherAvailableStock += available;
  }

  return {
    mainAvailableStock,
    nearExpiryAvailableStock,
    defectAvailableStock,
    otherAvailableStock,
    warehouseBreakdown: [...warehouses.values()]
      .map((warehouse) => `${warehouse.warehouseNo}/${warehouse.warehouseName}:可发库存${warehouse.rawAvailableStock}`)
      .join("; "),
    rows,
  };
}

export function writeDiagnosisWorkbook(outputFile: string, lines: DiagnosisLine[], cacheStatus = emptyGoodsCacheStatus()): void {
  mkdirSync(dirname(outputFile), { recursive: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows(lines, cacheStatus)), "summary");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(lineRows(lines)), "lines");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(candidateRows(lines)), "candidates");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(stockRows(lines)), "stock");
  XLSX.writeFile(workbook, outputFile);
}

async function loadGoodsSpecs(database: DatabaseContext): Promise<LocalGoodsSpecCandidate[]> {
  const rows = await database.db.select().from(wdtGoodsSpecs);
  return rows.map(toLocalGoodsSpecCandidate);
}

async function loadGoodsCacheStatus(database: DatabaseContext, allowStaleCache: boolean): Promise<GoodsCacheStatus> {
  const rows = await database.client.execute("select count(*) as count from wdt_goods_specs");
  const specCount = Number(rows.rows[0]?.count ?? 0);
  const [latestRun] = await database.db.select().from(wdtGoodsSyncRuns).orderBy(desc(wdtGoodsSyncRuns.startedAt)).limit(1);
  const cacheWarning =
    allowStaleCache && latestRun?.status !== "success"
      ? "临时诊断，不可作为正式审核依据：最近一次商品档案同步不是 success"
      : "";
  return {
    specCount,
    latestRunStatus: latestRun?.status ?? "none",
    latestRunRangeStart: latestRun?.rangeStart ?? "",
    latestRunRangeEnd: latestRun?.rangeEnd ?? "",
    latestRunErrorMessage: latestRun?.errorMessage ?? "",
    allowStaleCache,
    cacheWarning,
  };
}

function assertUsableGoodsCache(status: GoodsCacheStatus): void {
  if (status.latestRunStatus === "success") return;
  if (status.allowStaleCache) return;
  throw new Error("WDT goods cache is not usable for formal diagnosis because latest goods sync is not success. latestStatus="
    + status.latestRunStatus
    + " specCount="
    + status.specCount
    + (status.latestRunErrorMessage ? " error=" + status.latestRunErrorMessage : "")
    + " Run goods sync first, or pass --allow-stale-cache only for temporary troubleshooting.");
  throw new Error(
    [
      "商品档案缓存不可用于正式诊断：最近一次商品同步未成功。",
      `latestStatus=${status.latestRunStatus}`,
      `specCount=${status.specCount}`,
      status.latestRunErrorMessage ? `error=${status.latestRunErrorMessage}` : "",
      "请先完成商品同步，或仅在临时排查时显式传入 --allow-stale-cache。",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

async function loadProductMappings(database: DatabaseContext): Promise<ProductMappingCandidate[]> {
  const rows = await database.db.select().from(productMappings).where(eq(productMappings.status, "confirmed"));
  return rows.map(toProductMappingCandidate);
}

async function persistDiagnosisCandidates(database: DatabaseContext, lines: DiagnosisLine[], batchId: string): Promise<void> {
  const now = new Date().toISOString();
  await database.db.delete(productMatchCandidates).where(eq(productMatchCandidates.batchId, batchId));
  const rows = lines.flatMap(({ sortOrder, orderLine, decision }) =>
    decision.status === "ambiguous"
      ? decision.candidates.map((candidate) => ({
          id: `candidate-${randomUUID()}`,
          batchId,
          reviewLineId: `${batchId}-diagnosis-line-${sortOrder}`,
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
          createdAt: now,
        }))
      : [],
  );
  if (rows.length > 0) await database.db.insert(productMatchCandidates).values(rows);
}

function buildDiagnosisBatchId(orderFile: string): string {
  return `diagnosis-${basename(orderFile).replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
}

function toLocalGoodsSpecCandidate(row: GoodsSpecRow): LocalGoodsSpecCandidate {
  return {
    goodsNo: row.goodsNo,
    goodsName: row.goodsName,
    specNo: row.specNo,
    specName: row.specName,
    specCode: row.specCode,
    barcode: row.barcode,
    barcodes: parseStringArray(row.barcodesJson),
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

function summaryRows(lines: DiagnosisLine[], cacheStatus: GoodsCacheStatus): Array<Record<string, string | number>> {
  const basisCount = (basis: string) => lines.filter((line) => line.decision.candidate?.basis === basis).length;
  return [
    { metric: "cache_spec_count", value: cacheStatus.specCount },
    { metric: "cache_latest_run_status", value: cacheStatus.latestRunStatus },
    { metric: "cache_latest_run_range_start", value: cacheStatus.latestRunRangeStart },
    { metric: "cache_latest_run_range_end", value: cacheStatus.latestRunRangeEnd },
    { metric: "allow_stale_cache", value: cacheStatus.allowStaleCache ? "true" : "false" },
    { metric: "cache_warning", value: goodsCacheWarning(cacheStatus) },
    { metric: "total_lines", value: lines.length },
    { metric: "matched", value: countStatus(lines, "matched") },
    { metric: "ambiguous", value: countStatus(lines, "ambiguous") },
    { metric: "not_found", value: countStatus(lines, "not_found") },
    { metric: "api_error", value: countStatus(lines, "api_error") },
    { metric: "barcode_match", value: basisCount("barcode") },
    { metric: "code_match", value: basisCount("code") },
    { metric: "manual_mapping", value: lines.filter((line) => line.decision.message === "Matched by confirmed product mapping").length },
    { metric: "name_candidate", value: basisCount("exact_name") + basisCount("contains_name") + basisCount("fuzzy_name") },
    { metric: "stock_queried", value: lines.filter((line) => Boolean(line.stock)).length },
  ];
}

function emptyGoodsCacheStatus(): GoodsCacheStatus {
  return {
    specCount: 0,
    latestRunStatus: "unknown",
    latestRunRangeStart: "",
    latestRunRangeEnd: "",
    latestRunErrorMessage: "",
    allowStaleCache: false,
    cacheWarning: "",
  };
}

function goodsCacheWarning(cacheStatus: GoodsCacheStatus): string {
  if (cacheStatus.allowStaleCache && cacheStatus.latestRunStatus !== "success") {
    return "temporary diagnosis only; not valid for formal review because latest goods sync is not success";
  }
  return cacheStatus.cacheWarning;
}

function lineRows(lines: DiagnosisLine[]): Array<Record<string, string | number>> {
  return lines.map(({ sortOrder, orderLine, decision, stock }) => ({
    sortOrder,
    excelRow: orderLine.excelRow,
    orderNoticeNo: orderLine.orderNoticeNo,
    storeNo: orderLine.storeNo,
    storeName: orderLine.storeName,
    externalBarcode: orderLine.externalBarcode,
    externalGoodsCode: orderLine.externalGoodsCode,
    externalGoodsName: orderLine.externalGoodsName,
    spec: orderLine.spec,
    orderQty: orderLine.orderQty,
    matchStatus: decision.status,
    matchBasis: decision.candidate?.basis ?? "",
    wdtSpecNo: decision.candidate?.specNo ?? "",
    wdtGoodsNo: decision.candidate?.goodsNo ?? "",
    wdtGoodsName: decision.candidate?.goodsName ?? "",
    wdtSpecName: decision.candidate?.specName ?? "",
    candidateCount: decision.candidates.length,
    message: decision.message,
    mainAvailableStock: stock?.mainAvailableStock ?? 0,
    nearExpiryAvailableStock: stock?.nearExpiryAvailableStock ?? 0,
    defectAvailableStock: stock?.defectAvailableStock ?? 0,
    otherAvailableStock: stock?.otherAvailableStock ?? 0,
    warehouseBreakdown: stock?.warehouseBreakdown ?? "",
  }));
}

function candidateRows(lines: DiagnosisLine[]): Array<Record<string, string | number>> {
  return lines.flatMap(({ sortOrder, orderLine, decision }) =>
    decision.status === "ambiguous" ? decision.candidates.map((candidate, index) => ({
      sortOrder,
      excelRow: orderLine.excelRow,
      externalBarcode: orderLine.externalBarcode,
      externalGoodsName: orderLine.externalGoodsName,
      rank: index + 1,
      score: candidate.score,
      basis: candidate.basis,
      wdtSpecNo: candidate.specNo ?? "",
      wdtGoodsNo: candidate.goodsNo ?? "",
      wdtGoodsName: candidate.goodsName ?? "",
      wdtSpecName: candidate.specName ?? "",
      barcodes: candidate.barcodes?.join(",") ?? "",
    })) : [],
  );
}

function stockRows(lines: DiagnosisLine[]): Array<Record<string, string | number | boolean>> {
  return lines.flatMap(({ sortOrder, orderLine, decision, stock }) =>
    (stock?.rows ?? []).map((row) => ({
      sortOrder,
      excelRow: orderLine.excelRow,
      externalBarcode: orderLine.externalBarcode,
      wdtSpecNo: decision.candidate?.specNo ?? row.spec_no ?? "",
      warehouseNo: row.warehouse_no ?? "",
      warehouseName: row.warehouse_name ?? "",
      defect: row.defect ?? false,
      stockNum: row.stock_num ?? row.库存 ?? 0,
      availableSendStock: getWdtAvailableSendStock(row),
      goodsName: row.goods_name ?? "",
      specName: row.spec_name ?? "",
    })),
  );
}

function buildDiagnosisResult(outputFile: string, lines: DiagnosisLine[]): DiagnoseOrderResult {
  return {
    outputFile,
    totalLines: lines.length,
    matchedCount: countStatus(lines, "matched"),
    ambiguousCount: countStatus(lines, "ambiguous"),
    notFoundCount: countStatus(lines, "not_found"),
    apiErrorCount: countStatus(lines, "api_error"),
    stockQueriedCount: lines.filter((line) => Boolean(line.stock)).length,
  };
}

function countStatus(lines: DiagnosisLine[], status: ProductMatchDecision["status"]): number {
  return lines.filter((line) => line.decision.status === status).length;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
