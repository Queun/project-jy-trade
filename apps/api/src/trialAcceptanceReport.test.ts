import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { createSqliteStore } from "./store.js";
import { generateTrialAcceptanceReport } from "./trialAcceptanceReport.js";

const projectRoot = resolve(process.cwd(), "../..");
const orderFile = "ole案例文件——发货前\\1订货单\\订货通知单 .xls";

describe("trial acceptance report", () => {
  it("rejects mock batches when production API mode is required", async () => {
    const { batchId, databaseUrl } = await seedReviewedMockBatch();

    await expect(
      generateTrialAcceptanceReport({
        batchId,
        databaseUrl,
        projectRoot,
        outputFile: testOutputFile("trial-reject-mock.xlsx"),
        requireProductionApi: true,
      }),
    ).rejects.toThrow(/requires a production_api batch/);
  });

  it("writes workbook sheets with batch, review, readiness, and export statistics", async () => {
    const { batchId, databaseUrl } = await seedReviewedMockBatch();
    const outputFile = testOutputFile("trial-acceptance.xlsx");

    const result = await generateTrialAcceptanceReport({
      batchId,
      databaseUrl,
      projectRoot,
      outputFile,
    });

    expect(result.batchId).toBe(batchId);
    expect(result.lineCount).toBeGreaterThan(0);
    expect(result.exportCount).toBe(1);
    expect(existsSync(outputFile)).toBe(true);

    const workbook = XLSX.readFile(outputFile);
    expect(workbook.SheetNames).toEqual(["批次信息", "审核统计", "做单预检查", "导出历史", "异常明细"]);

    const reviewRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["审核统计"], { defval: "" });
    expect(reviewRows).toContainEqual({ 指标: "明细行", 值: result.lineCount });
    expect(Number(reviewRows.find((row) => row.指标 === "已匹配")?.值)).toBeGreaterThan(0);

    const exportRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["导出历史"], { defval: "" });
    expect(exportRows[0]).toMatchObject({ 导出类型: "做单 Excel", 状态: "失败" });
    expect(String(exportRows[0].失败原因)).toContain("缺少发货地址");
  });
});

async function seedReviewedMockBatch() {
  const databaseUrl = testDatabaseUrl();
  const store = createSqliteStore({
    databaseUrl,
    projectRoot,
    makeOrderAddressBookPath: resolve(projectRoot, "missing-address-book.xlsx"),
  });
  const batch = await store.createBatch({ filePath: orderFile, mode: "mock" });
  await store.runMockReview(batch.id, "examples/mock_flow_mixed.json");
  await store.submitReview(batch.id);
  await store.createExport(batch.id, { type: "wdt_import" });
  return { batchId: batch.id, databaseUrl };
}

function testDatabaseUrl() {
  return `file:${resolve(projectRoot, "outputs", `trial-acceptance-${randomUUID()}.db`).replaceAll("\\", "/")}`;
}

function testOutputFile(fileName: string) {
  return resolve(projectRoot, "outputs", fileName);
}
