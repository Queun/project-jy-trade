import type { BatchSummary, ExportDto, MakeOrderReadinessDto, ReviewLineDto } from "@jy-trade/shared";
import * as XLSX from "xlsx";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createSqliteStore } from "./store.js";

export interface TrialAcceptanceReportOptions {
  batchId: string;
  outputFile: string;
  databaseUrl?: string;
  projectRoot?: string;
  requireProductionApi?: boolean;
}

export interface TrialAcceptanceReportResult {
  batchId: string;
  outputFile: string;
  lineCount: number;
  exportCount: number;
}

interface ReviewStats {
  total: number;
  matched: number;
  ambiguous: number;
  notFound: number;
  apiError: number;
  ready: number;
  partial: number;
  outOfStock: number;
  pending: number;
  ship: number;
  doNotShip: number;
  overSuggested: number;
  priority: number;
}

export async function generateTrialAcceptanceReport(options: TrialAcceptanceReportOptions): Promise<TrialAcceptanceReportResult> {
  const store = createSqliteStore({ databaseUrl: options.databaseUrl, projectRoot: options.projectRoot });
  await store.ready;

  const batch = await store.getBatch(options.batchId);
  if (!batch) throw new Error(`Batch not found: ${options.batchId}`);
  if (options.requireProductionApi && batch.mode !== "production_api") {
    throw new Error(`Trial acceptance report requires a production_api batch: ${options.batchId}`);
  }

  const lines = (await store.getReviewLines(options.batchId)) ?? [];
  const readiness = await store.getMakeOrderReadiness(options.batchId);
  const exports = await store.listExports(options.batchId);
  const stats = buildReviewStats(lines);
  const outputFile = resolve(process.cwd(), options.outputFile);
  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(workbook, rowsToSheet(batchRows(batch)), "批次信息");
  XLSX.utils.book_append_sheet(workbook, rowsToSheet(reviewStatsRows(stats)), "审核统计");
  XLSX.utils.book_append_sheet(workbook, rowsToSheet(readinessRows(readiness)), "做单预检查");
  XLSX.utils.book_append_sheet(workbook, rowsToSheet(exportRows(exports)), "导出历史");
  XLSX.utils.book_append_sheet(workbook, rowsToSheet(exceptionRows(lines)), "异常明细");

  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer);

  return { batchId: batch.id, outputFile, lineCount: lines.length, exportCount: exports.length };
}

function batchRows(batch: BatchSummary) {
  return [
    { 指标: "批次ID", 值: batch.id },
    { 指标: "文件名", 值: batch.fileName },
    { 指标: "模式", 值: batch.mode },
    { 指标: "状态", 值: batch.status },
    { 指标: "订单行数", 值: batch.orderLineCount },
    { 指标: "唯一条码数", 值: batch.uniqueBarcodeCount },
    { 指标: "已匹配条码数", 值: batch.matchedBarcodeCount },
    { 指标: "创建时间", 值: batch.createdAt },
    { 指标: "更新时间", 值: batch.updatedAt },
  ];
}

function reviewStatsRows(stats: ReviewStats) {
  return [
    { 指标: "明细行", 值: stats.total },
    { 指标: "已匹配", 值: stats.matched },
    { 指标: "需确认", 值: stats.ambiguous },
    { 指标: "未找到", 值: stats.notFound },
    { 指标: "匹配异常", 值: stats.apiError },
    { 指标: "库存充足", 值: stats.ready },
    { 指标: "部分满足", 值: stats.partial },
    { 指标: "缺货", 值: stats.outOfStock },
    { 指标: "待审核", 值: stats.pending },
    { 指标: "发货", 值: stats.ship },
    { 指标: "不发货", 值: stats.doNotShip },
    { 指标: "超建议数", 值: stats.overSuggested },
    { 指标: "优先处理", 值: stats.priority },
  ];
}

function readinessRows(readiness: MakeOrderReadinessDto | undefined) {
  if (!readiness) return [{ 指标: "状态", 值: "未找到做单预检查" }];
  return [
    { 指标: "可生成做单 Excel", 值: readiness.canExport ? "是" : "否" },
    { 指标: "可做单行数", 值: readiness.shippableLineCount },
    { 指标: "缺地址门店数", 值: readiness.missingAddressCount },
    {
      指标: "缺地址门店",
      值: readiness.missingStores.map((store) => `${store.storeName || store.storeNo}(${store.shippableLineCount})`).join("；"),
    },
  ];
}

function exportRows(exports: ExportDto[]) {
  if (exports.length === 0) return [{ 导出类型: "", 状态: "暂无导出记录", 文件名: "", 创建人: "", 创建时间: "", 失败原因: "" }];
  return exports.map((item) => ({
    导出类型: exportTypeText(item.type),
    状态: exportStatusText(item.status),
    文件名: item.fileName,
    创建人: item.createdByUsername ?? "",
    创建时间: item.createdAt,
    失败原因: item.errorMessage ?? "",
  }));
}

function exceptionRows(lines: ReviewLineDto[]) {
  const rows = lines.filter(
    (line) =>
      line.matchStatus !== "matched"
      || line.status === "库存不足"
      || (line.decision === "ship" && line.approvedShipQty > line.suggestedShipQty),
  );
  if (rows.length === 0) {
    return [{ 行号: "", 门店: "", 商品: "", 条码: "", 异常类型: "暂无异常明细", 备注: "" }];
  }
  return rows.map((line) => ({
    行号: line.excelRow,
    门店: line.storeName,
    商品: line.externalGoodsName,
    条码: line.externalBarcode,
    异常类型: exceptionType(line),
    备注: line.matchMessage || line.reason,
  }));
}

function buildReviewStats(lines: ReviewLineDto[]): ReviewStats {
  return {
    total: lines.length,
    matched: lines.filter((line) => line.matchStatus === "matched").length,
    ambiguous: lines.filter((line) => line.matchStatus === "ambiguous").length,
    notFound: lines.filter((line) => line.matchStatus === "not_found").length,
    apiError: lines.filter((line) => line.matchStatus === "api_error").length,
    ready: lines.filter((line) => line.status === "库存充足").length,
    partial: lines.filter((line) => line.status === "部分满足").length,
    outOfStock: lines.filter((line) => line.status === "库存不足").length,
    pending: lines.filter((line) => line.decision === "pending").length,
    ship: lines.filter((line) => line.decision === "ship").length,
    doNotShip: lines.filter((line) => line.decision === "do_not_ship").length,
    overSuggested: lines.filter((line) => line.decision === "ship" && line.approvedShipQty > line.suggestedShipQty).length,
    priority: lines.filter((line) => line.priority).length,
  };
}

function exceptionType(line: ReviewLineDto) {
  if (line.matchStatus === "ambiguous") return "商品需确认";
  if (line.matchStatus === "not_found") return "商品未找到";
  if (line.matchStatus === "api_error") return "匹配异常";
  if (line.status === "库存不足") return "缺货";
  if (line.decision === "ship" && line.approvedShipQty > line.suggestedShipQty) return "超建议数";
  return "";
}

function rowsToSheet(rows: Array<Record<string, string | number | boolean>>) {
  return XLSX.utils.json_to_sheet(rows, { skipHeader: false });
}

function exportTypeText(type: ExportDto["type"]) {
  if (type === "confirmed") return "确定发货单";
  if (type === "wdt_import") return "做单 Excel";
  return "初审单";
}

function exportStatusText(status: ExportDto["status"]) {
  if (status === "ready") return "已生成";
  if (status === "failed") return "失败";
  return "生成中";
}
