import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  decideProductMatch,
  type ProductCandidate,
  type ScoredProductCandidate,
} from "../../../packages/workflow/src/productMatcher.js";
import XLSX from "xlsx";

import { loadOrderLines, type OrderLine } from "../core/orders.js";
import { buildReviewLines, type InventorySnapshot, type ReviewLine } from "../core/review.js";
import {
  WdtClient,
  type WdtGoodsResponse,
  type WdtGoodsSpec,
  type WdtStockResponse,
  type WdtStockRow,
} from "../integrations/wdtClient.js";

export interface MatchResult {
  barcode: string;
  status: "matched" | "not_found" | "ambiguous" | "api_error";
  wdtSpecNo: string;
  goodsName: string;
  specName: string;
  candidateCount: number;
  message: string;
  candidates?: MatchCandidateSummary[];
}

export interface MatchCandidateSummary {
  rank: number;
  score: number;
  basis: string;
  goodsNo: string;
  wdtSpecNo: string;
  goodsName: string;
  specName: string;
  barcodes: string;
}

export interface SimulatedReviewLine extends ReviewLine {
  matchStatus: MatchResult["status"];
  matchMessage: string;
  goodsName: string;
  specName: string;
}

export interface SimulateReviewOptions {
  orderFile: string;
  outputFile: string;
  warehouseNo?: string;
  mockDataFile?: string;
}

export interface SimulateReviewResult {
  outputFile: string;
  orderLineCount: number;
  uniqueBarcodeCount: number;
  matchedBarcodeCount: number;
  statusCounts: Record<string, number>;
  matchCounts: Record<string, number>;
}

interface MockFlowData {
  matches?: MatchResult[];
  inventory?: Array<{
    barcode: string;
    wdtSpecNo: string;
    mainAvailableStock?: number;
    nearExpiryAvailableStock?: number;
  }>;
}

interface WarehouseStockSummary {
  mainAvailableStock: number;
  nearExpiryAvailableStock: number;
  defectAvailableStock: number;
  otherAvailableStock: number;
  warehouseBreakdown: string;
}

const DEFAULT_MAIN_WAREHOUSE_NOS = ["001"];
const DEFAULT_NEAR_EXPIRY_WAREHOUSE_NOS = ["LINQI"];
const DEFAULT_DEFECT_WAREHOUSE_NOS = ["CIPIN"];
const DEFAULT_GOODS_CANDIDATE_MAX_PAGES = 5;

function flattenCandidateSpecs(response: WdtGoodsResponse): ProductCandidate[] {
  const goodsList = response.data?.goods_list ?? [];
  const candidates: ProductCandidate[] = [];

  for (const goods of goodsList) {
    for (const spec of goods.spec_list ?? []) {
      candidates.push({
        source: "goods",
        goodsNo: goods.goods_no,
        goodsName: goods.goods_name ?? "",
        specNo: spec.spec_no,
        specCode: spec.spec_code,
        specName: spec.spec_name ?? "",
        barcodes: collectSpecBarcodes(spec),
      });
    }
  }

  return candidates;
}

function collectSpecBarcodes(spec: WdtGoodsSpec): string[] {
  return [...new Set([spec.barcode, ...(spec.barcode_list ?? []).map((item) => item.barcode)].filter(Boolean) as string[])];
}

async function collectGoodsCandidates(client: WdtClient, line: OrderLine): Promise<{ candidates: ProductCandidate[]; errors: string[] }> {
  const calls: Array<Promise<WdtGoodsResponse>> = [];
  if (line.externalBarcode) calls.push(client.queryGoodsByBarcode(line.externalBarcode));
  if (line.externalGoodsCode) {
    calls.push(client.queryGoodsBySpecNo(line.externalGoodsCode));
    calls.push(client.queryGoodsByGoodsNo(line.externalGoodsCode));
  }

  const errors: string[] = [];
  const candidates: ProductCandidate[] = [];
  const settled = await Promise.allSettled(calls);

  for (const result of settled) {
    if (result.status === "rejected") {
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      continue;
    }
    if (result.value.status !== 0) {
      errors.push(`goods query status=${result.value.status ?? "unknown"} message=${result.value.message ?? ""}`.trim());
      continue;
    }
    candidates.push(...flattenCandidateSpecs(result.value));
  }

  return { candidates: dedupeCandidates(candidates), errors };
}

async function collectStockCandidates(client: WdtClient, warehouseNo?: string): Promise<ProductCandidate[]> {
  const response = await client.queryRecentStockCandidates(warehouseNo);
  if (response.status !== 0) return [];
  return dedupeCandidates((response.data?.detail_list ?? []).map(stockRowToCandidate));
}

async function collectRecentGoodsCandidates(client: WdtClient): Promise<ProductCandidate[]> {
  const candidates: ProductCandidate[] = [];
  const maxPages = Number(process.env.WDT_GOODS_CANDIDATE_MAX_PAGES ?? DEFAULT_GOODS_CANDIDATE_MAX_PAGES);

  for (let pageNo = 0; pageNo < maxPages; pageNo += 1) {
    const response = await client.queryRecentGoodsCandidates(pageNo, 100);
    if (response.status !== 0) break;
    const goodsList = response.data?.goods_list ?? [];
    candidates.push(...flattenCandidateSpecs(response));
    if (goodsList.length < 100) break;
  }

  return dedupeCandidates(candidates);
}

function stockRowToCandidate(row: WdtStockRow): ProductCandidate {
  return {
    source: "goods",
    goodsNo: row.goods_no,
    goodsName: row.goods_name ?? "",
    specNo: row.spec_no,
    specName: row.spec_name ?? "",
    barcodes: row.barcode ? [row.barcode] : [],
  };
}

function dedupeCandidates(candidates: ProductCandidate[]): ProductCandidate[] {
  const byKey = new Map<string, ProductCandidate>();
  for (const candidate of candidates) {
    const key = [candidate.source, candidate.goodsNo, candidate.specNo, candidate.specName, candidate.barcodes?.join(",")].join("|");
    if (!byKey.has(key)) byKey.set(key, candidate);
  }
  return [...byKey.values()];
}

async function matchOrderLine(client: WdtClient, line: OrderLine, fallbackCandidates: ProductCandidate[]): Promise<MatchResult> {
  try {
    const { candidates, errors } = await collectGoodsCandidates(client, line);
    if (candidates.length === 0 && fallbackCandidates.length === 0 && errors.length > 0) {
      return buildMatchResult(line.externalBarcode, "api_error", undefined, 0, errors.join("; "));
    }
    const fallbackPool = line.externalGoodsName || line.spec ? fallbackCandidates : [];
    const candidatePool = dedupeCandidates([...candidates, ...fallbackPool]);

    const decision = decideProductMatch(
      {
        barcode: line.externalBarcode,
        goodsCode: line.externalGoodsCode,
        goodsName: line.externalGoodsName,
        specName: line.spec,
      },
      candidatePool,
    );
    const primary = decision.candidate ?? decision.candidates[0];

    return buildMatchResult(
      line.externalBarcode,
      decision.status,
      primary,
      decision.candidates.length || candidatePool.length,
      decision.message,
      decision.candidates,
    );
  } catch (error) {
    return buildMatchResult(line.externalBarcode, "api_error", undefined, 0, error instanceof Error ? error.message : String(error));
  }
}

function buildMatchResult(
  barcode: string,
  status: MatchResult["status"],
  candidate: ProductCandidate | undefined,
  candidateCount: number,
  message: string,
  candidates: ScoredProductCandidate[] = [],
): MatchResult {
  return {
    barcode,
    status,
    wdtSpecNo: status === "matched" ? candidate?.specNo ?? "" : "",
    goodsName: candidate?.goodsName ?? "",
    specName: candidate?.specName ?? "",
    candidateCount,
    message,
    candidates: summarizeMatchCandidates(candidates),
  };
}

function summarizeMatchCandidates(candidates: ScoredProductCandidate[]): MatchCandidateSummary[] {
  return candidates.slice(0, 8).map((candidate, index) => ({
    rank: index + 1,
    score: candidate.score,
    basis: candidate.basis,
    goodsNo: candidate.goodsNo ?? "",
    wdtSpecNo: candidate.specNo ?? "",
    goodsName: candidate.goodsName ?? "",
    specName: candidate.specName ?? "",
    barcodes: (candidate.barcodes ?? []).join(","),
  }));
}

function stockFromResponse(match: MatchResult, response: WdtStockResponse, requestedMainWarehouseNo?: string): InventorySnapshot {
  const summary = summarizeWarehouseStock(response, requestedMainWarehouseNo);
  return {
    matchKey: match.barcode,
    wdtSpecNo: match.wdtSpecNo,
    mainAvailableStock: summary.mainAvailableStock,
    nearExpiryAvailableStock: summary.nearExpiryAvailableStock,
    defectAvailableStock: summary.defectAvailableStock,
    otherAvailableStock: summary.otherAvailableStock,
    warehouseBreakdown: summary.warehouseBreakdown,
  };
}

function summarizeWarehouseStock(response: WdtStockResponse, requestedMainWarehouseNo?: string): WarehouseStockSummary {
  const rows = response.data?.detail_list ?? [];
  const mainWarehouseNos = new Set([
    ...DEFAULT_MAIN_WAREHOUSE_NOS,
    ...(requestedMainWarehouseNo ? [requestedMainWarehouseNo] : []),
  ]);
  const nearExpiryWarehouseNos = new Set(DEFAULT_NEAR_EXPIRY_WAREHOUSE_NOS);
  const defectWarehouseNos = new Set(DEFAULT_DEFECT_WAREHOUSE_NOS);
  const summary: WarehouseStockSummary = {
    mainAvailableStock: 0,
    nearExpiryAvailableStock: 0,
    defectAvailableStock: 0,
    otherAvailableStock: 0,
    warehouseBreakdown: "",
  };

  const breakdown = new Map<string, { warehouseNo: string; warehouseName: string; available: number; stock: number }>();
  for (const row of rows) {
    const warehouseNo = row.warehouse_no ?? "";
    const available = Number(row.available_send_stock ?? 0);
    const stock = Number(row.stock_num ?? 0);
    const key = warehouseNo || row.warehouse_name || "unknown";
    const current = breakdown.get(key) ?? {
      warehouseNo,
      warehouseName: row.warehouse_name ?? "",
      available: 0,
      stock: 0,
    };
    current.available += available;
    current.stock += stock;
    breakdown.set(key, current);

    if (mainWarehouseNos.has(warehouseNo)) {
      summary.mainAvailableStock += available;
    } else if (nearExpiryWarehouseNos.has(warehouseNo)) {
      summary.nearExpiryAvailableStock += available;
    } else if (defectWarehouseNos.has(warehouseNo) || row.defect === true) {
      summary.defectAvailableStock += available;
    } else {
      summary.otherAvailableStock += available;
    }
  }

  summary.warehouseBreakdown = [...breakdown.values()]
    .sort((a, b) => b.available - a.available || a.warehouseNo.localeCompare(b.warehouseNo))
    .map((item) => `${item.warehouseNo || "unknown"} ${item.warehouseName || ""}:可发${item.available}/库存${item.stock}`.trim())
    .join("; ");

  return summary;
}

async function buildInventory(
  client: WdtClient,
  matches: Map<string, MatchResult>,
  warehouseNo?: string,
): Promise<Map<string, InventorySnapshot>> {
  const inventory = new Map<string, InventorySnapshot>();
  for (const match of matches.values()) {
    if (match.status !== "matched" || !match.wdtSpecNo) continue;
    const stock = await client.queryStock(match.wdtSpecNo);
    inventory.set(match.barcode, stockFromResponse(match, stock, warehouseNo));
  }
  return inventory;
}

function loadMockData(path?: string): { matches: Map<string, MatchResult>; inventory: Map<string, InventorySnapshot> } | undefined {
  if (!path) return undefined;
  const data = JSON.parse(readFileSync(path, "utf8")) as MockFlowData;
  const matches = new Map<string, MatchResult>();
  const inventory = new Map<string, InventorySnapshot>();

  for (const match of data.matches ?? []) {
    matches.set(match.barcode, match);
  }
  for (const item of data.inventory ?? []) {
    inventory.set(item.barcode, {
      matchKey: item.barcode,
      wdtSpecNo: item.wdtSpecNo,
      mainAvailableStock: Number(item.mainAvailableStock ?? 0),
      nearExpiryAvailableStock: Number(item.nearExpiryAvailableStock ?? 0),
      defectAvailableStock: 0,
      otherAvailableStock: 0,
      warehouseBreakdown: "",
    });
  }

  return { matches, inventory };
}

function composeSimulationRows(
  orderLines: OrderLine[],
  reviewLines: ReviewLine[],
  matches: Map<string, MatchResult>,
): SimulatedReviewLine[] {
  return reviewLines.map((line) => {
    const match = matches.get(line.externalBarcode) ?? buildMatchResult(line.externalBarcode, "not_found", undefined, 0, "Not queried");
    const source = orderLines.find((item) => item.excelRow === line.excelRow && item.orderNoticeNo === line.orderNoticeNo);
    return {
      ...line,
      wdtSpecNo: line.wdtSpecNo || match.wdtSpecNo,
      matchStatus: match.status,
      matchMessage: match.message,
      goodsName: match.goodsName,
      specName: match.specName || source?.spec || "",
    };
  });
}

function toExcelRows(lines: SimulatedReviewLine[]): Array<Record<string, string | number>> {
  return lines.map((line) => ({
    orderNoticeNo: line.orderNoticeNo,
    excelRow: line.excelRow,
    storeNo: line.storeNo,
    storeName: line.storeName,
    uploadTime: line.uploadTime,
    externalBarcode: line.externalBarcode,
    externalGoodsName: line.externalGoodsName,
    wdtGoodsName: line.goodsName,
    wdtSpecName: line.specName,
    wdtSpecNo: line.wdtSpecNo,
    matchStatus: line.matchStatus,
    matchMessage: line.matchMessage,
    orderQty: line.orderQty,
    mainAvailableBefore: line.mainAvailableBefore,
    nearExpiryAvailableBefore: line.nearExpiryAvailableBefore,
    defectAvailableBefore: line.defectAvailableBefore,
    otherAvailableBefore: line.otherAvailableBefore,
    warehouseBreakdown: line.warehouseBreakdown,
    suggestedMainQty: line.suggestedMainQty,
    suggestedNearExpiryQty: line.suggestedNearExpiryQty,
    suggestedShipQty: line.suggestedShipQty,
    remainingAfter: line.remainingAfter,
    reviewStatus: line.status,
  }));
}

function writeSimulationWorkbook(outputFile: string, rows: SimulatedReviewLine[], matches: Map<string, MatchResult>): void {
  mkdirSync(dirname(outputFile), { recursive: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(toExcelRows(rows)), "review_simulation");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([...matches.values()].map((match) => ({
      externalBarcode: match.barcode,
      matchStatus: match.status,
      wdtSpecNo: match.wdtSpecNo,
      wdtGoodsName: match.goodsName,
      wdtSpecName: match.specName,
      candidateCount: match.candidateCount,
      message: match.message,
    }))),
    "product_matches",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([...matches.values()].flatMap((match) => (match.candidates ?? []).map((candidate) => ({
      externalBarcode: match.barcode,
      matchStatus: match.status,
      rank: candidate.rank,
      score: candidate.score,
      basis: candidate.basis,
      goodsNo: candidate.goodsNo,
      wdtSpecNo: candidate.wdtSpecNo,
      wdtGoodsName: candidate.goodsName,
      wdtSpecName: candidate.specName,
      candidateBarcodes: candidate.barcodes,
    })))),
    "match_candidates",
  );
  XLSX.writeFile(workbook, outputFile);
}

function countBy<T extends string>(items: T[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item] = (counts[item] ?? 0) + 1;
    return counts;
  }, {});
}

export async function simulateReviewFlow(client: WdtClient, options: SimulateReviewOptions): Promise<SimulateReviewResult> {
  const orderLines = loadOrderLines(options.orderFile);
  const uniqueLines = uniqueProductLines(orderLines);
  const mockData = loadMockData(options.mockDataFile);
  const matches = new Map<string, MatchResult>();
  const fallbackCandidates = mockData
    ? []
    : dedupeCandidates([...(await collectStockCandidates(client, options.warehouseNo)), ...(await collectRecentGoodsCandidates(client))]);

  for (const line of uniqueLines) {
    const key = line.externalBarcode;
    const mockMatch = mockData?.matches.get(key);
    matches.set(key, mockMatch ?? (await matchOrderLine(client, line, fallbackCandidates)));
  }

  const inventory = mockData?.inventory ?? (await buildInventory(client, matches, options.warehouseNo));
  const reviewLines = buildReviewLines(orderLines, inventory);
  const simulationRows = composeSimulationRows(orderLines, reviewLines, matches);
  writeSimulationWorkbook(options.outputFile, simulationRows, matches);

  return {
    outputFile: options.outputFile,
    orderLineCount: orderLines.length,
    uniqueBarcodeCount: uniqueLines.length,
    matchedBarcodeCount: [...matches.values()].filter((match) => match.status === "matched").length,
    statusCounts: countBy(simulationRows.map((line) => line.status)),
    matchCounts: countBy([...matches.values()].map((match) => match.status)),
  };
}

function uniqueProductLines(orderLines: OrderLine[]): OrderLine[] {
  const byBarcode = new Map<string, OrderLine>();
  for (const line of orderLines) {
    if (!line.externalBarcode) continue;
    if (!byBarcode.has(line.externalBarcode)) byBarcode.set(line.externalBarcode, line);
  }
  return [...byBarcode.values()];
}
