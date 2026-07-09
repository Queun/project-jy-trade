import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import XLSX from "xlsx";

import { createDatabaseContext } from "../../../apps/api/src/db/client.js";
import { productMappings, productMatchCandidates, wdtGoodsSpecs, wdtGoodsSyncRuns } from "../../../apps/api/src/db/schema.js";
import {
  diagnoseOrderWithDatabase,
  diagnoseOrderLines,
  summarizeWarehouseStock,
  writeDiagnosisWorkbook,
  type StockLookupClient,
} from "./diagnoseOrder.js";
import type { OrderLine } from "../core/orders.js";

describe("diagnoseOrder", () => {
  it("matches by barcode and queries stock for matched lines", async () => {
    const client = fakeStockClient();
    const [line] = await diagnoseOrderLines(
      client,
      [orderLine({ externalBarcode: "B1", externalGoodsName: "商品1" })],
      [{ specNo: "S1", goodsName: "商品1", barcode: "B1", barcodes: ["B1"] }],
      [],
    );

    expect(line.decision.status).toBe("matched");
    expect(line.decision.candidate?.basis).toBe("barcode");
    expect(line.stock?.mainAvailableStock).toBe(5);
  });

  it("uses local barcode candidates before manual mappings", async () => {
    const [line] = await diagnoseOrderLines(
      fakeStockClient(),
      [orderLine({ externalBarcode: "B1", externalGoodsName: "商品1" })],
      [{ specNo: "AUTO", goodsName: "商品1", barcode: "B1", barcodes: ["B1"] }],
      [{ externalBarcode: "B1", wdtSpecNo: "MANUAL", wdtGoodsName: "人工商品", status: "confirmed" }],
    );

    expect(line.decision.status).toBe("matched");
    expect(line.decision.candidate?.specNo).toBe("AUTO");
    expect(line.decision.message).toBe("Matched by barcode");
  });

  it("uses confirmed database mapping before name candidates", async () => {
    const databaseUrl = await seedGoodsCacheSyncRun("success", {
      goodsNo: "3282770392869",
      goodsName: "雅漾专研保湿修护面膜",
      specNo: "3282770392869",
      specName: "25ml*5",
      barcode: "3282770392869",
    });
    const database = createDatabaseContext(databaseUrl, "apps/api/drizzle");
    try {
      await database.ready;
      const now = new Date().toISOString();
      await database.db.insert(productMappings).values({
        id: `mapping-${randomUUID()}`,
        externalBarcode: "2153722460015",
        externalGoodsName: "雅漾专研保湿修护面膜25ml*5片",
        externalGoodsCode: "5372246",
        wdtGoodsNo: "G1",
        wdtGoodsName: "test goods",
        wdtSpecNo: "S1",
        wdtSpecName: "test spec",
        wdtBarcode: "B1",
        status: "confirmed",
        sourceBatchId: "",
        confirmedByUserId: null,
        confirmedAt: now,
        note: "",
        createdAt: now,
        updatedAt: now,
      });
    } finally {
      await database.close();
    }
    const outputFile = testOutputFile("diagnose-confirmed-mapping.xlsx");

    const result = await diagnoseOrderWithDatabase(fakeStockClient(), {
      orderFile: sampleOrderFile(),
      outputFile,
      databaseUrl,
      migrationsFolder: "apps/api/drizzle",
    });

    expect(result.ambiguousCount).toBe(0);
    expect(result.matchedCount).toBeGreaterThan(0);
    const summary = XLSX.utils.sheet_to_json<Record<string, string | number>>(XLSX.readFile(outputFile).Sheets.summary, { defval: "" });
    const manualMapping = summary.find((row) => row.metric === "manual_mapping");
    expect(Number(manualMapping?.value)).toBeGreaterThan(0);
  });

  it("keeps close name candidates ambiguous", async () => {
    const [line] = await diagnoseOrderLines(
      fakeStockClient(),
      [orderLine({ externalBarcode: "external", externalGoodsName: "雅漾专研保湿修护面膜", spec: "25ml*5片" })],
      [{ specNo: "3282770392869", goodsName: "雅漾专研保湿修护面膜", specName: "25ml*5", barcode: "3282770392869" }],
      [],
    );

    expect(line.decision.status).toBe("ambiguous");
    expect(line.stock).toBeUndefined();
  });

  it("returns not_found when no candidate is usable", async () => {
    const [line] = await diagnoseOrderLines(
      fakeStockClient(),
      [orderLine({ externalBarcode: "missing", externalGoodsName: "不存在商品" })],
      [{ specNo: "S1", goodsName: "完全不同", barcode: "B1" }],
      [],
    );

    expect(line.decision.status).toBe("not_found");
  });

  it("summarizes main, near-expiry, defect, and other warehouses", () => {
    const summary = summarizeWarehouseStock([
      { warehouse_no: "001", warehouse_name: "主仓", available_send_stock: 5 },
      { warehouse_no: "LINQI", warehouse_name: "临期仓", available_send_stock: 2 },
      { warehouse_no: "CIPIN", warehouse_name: "次品仓", available_send_stock: 1 },
      { warehouse_no: "OTHER", warehouse_name: "其他仓", available_send_stock: 3 },
    ]);

    expect(summary).toMatchObject({
      mainAvailableStock: 5,
      nearExpiryAvailableStock: 2,
      defectAvailableStock: 1,
      otherAvailableStock: 3,
    });
  });

  it("writes diagnosis workbook with expected sheets", async () => {
    const lines = await diagnoseOrderLines(
      fakeStockClient(),
      [orderLine({ externalBarcode: "B1", externalGoodsName: "商品1" })],
      [{ specNo: "S1", goodsName: "商品1", barcode: "B1", barcodes: ["B1"] }],
      [],
    );
    const outputFile = resolve(process.cwd(), "../../outputs/diagnose-order-test.xlsx");
    writeDiagnosisWorkbook(outputFile, lines);

    expect(existsSync(outputFile)).toBe(true);
    const workbook = XLSX.readFile(outputFile);
    expect(workbook.SheetNames).toEqual(["summary", "lines", "candidates", "stock"]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.candidates, { defval: "" })).toHaveLength(0);
  });

  it("blocks database diagnosis when the latest goods sync failed", async () => {
    const databaseUrl = await seedGoodsCacheSyncRun("failed");

    await expect(diagnoseOrderWithDatabase(fakeStockClient(), {
      orderFile: sampleOrderFile(),
      outputFile: testOutputFile("diagnose-blocked.xlsx"),
      databaseUrl,
      migrationsFolder: "apps/api/drizzle",
    })).rejects.toThrow(/latest goods sync is not success/);
  });

  it("allows stale cache diagnosis only when explicitly requested and marks the workbook", async () => {
    const databaseUrl = await seedGoodsCacheSyncRun("failed");
    const outputFile = testOutputFile("diagnose-stale-cache.xlsx");

    const result = await diagnoseOrderWithDatabase(fakeStockClient(), {
      orderFile: sampleOrderFile(),
      outputFile,
      databaseUrl,
      migrationsFolder: "apps/api/drizzle",
      allowStaleCache: true,
    });

    expect(result.outputFile).toBe(outputFile);
    const summary = XLSX.utils.sheet_to_json<Record<string, string | number>>(XLSX.readFile(outputFile).Sheets.summary, { defval: "" });
    expect(summary).toContainEqual({ metric: "allow_stale_cache", value: "true" });
    expect(summary).toContainEqual({
      metric: "cache_warning",
      value: "temporary diagnosis only; not valid for formal review because latest goods sync is not success",
    });
  });

  it("allows database diagnosis when the latest goods sync succeeded", async () => {
    const databaseUrl = await seedGoodsCacheSyncRun("success", {
      goodsNo: "3282770392869",
      goodsName: "雅漾专研保湿修护面膜",
      specNo: "3282770392869",
      specName: "25ml*5",
      barcode: "3282770392869",
    });
    const outputFile = testOutputFile("diagnose-success-cache.xlsx");

    const result = await diagnoseOrderWithDatabase(fakeStockClient(), {
      orderFile: sampleOrderFile(),
      outputFile,
      databaseUrl,
      migrationsFolder: "apps/api/drizzle",
    });

    expect(result.totalLines).toBeGreaterThan(0);
    const summary = XLSX.utils.sheet_to_json<Record<string, string | number>>(XLSX.readFile(outputFile).Sheets.summary, { defval: "" });
    expect(summary).toContainEqual({ metric: "cache_latest_run_status", value: "success" });
    expect(summary).toContainEqual({ metric: "allow_stale_cache", value: "false" });
  });

  it("persists ambiguous candidates for mapping confirmation", async () => {
    const databaseUrl = await seedGoodsCacheSyncRun("success", {
      goodsNo: "3282770392869",
      goodsName: "雅漾专研保湿修护面膜",
      specNo: "3282770392869",
      specName: "25ml*5",
      barcode: "3282770392869",
    });
    const outputFile = testOutputFile("diagnose-persist-candidates.xlsx");

    await diagnoseOrderWithDatabase(fakeStockClient(), {
      orderFile: sampleOrderFile(),
      outputFile,
      databaseUrl,
      migrationsFolder: "apps/api/drizzle",
      batchId: "diagnosis-test",
    });

    const database = createDatabaseContext(databaseUrl, "apps/api/drizzle");
    try {
      await database.ready;
      const rows = await database.db.select().from(productMatchCandidates);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toMatchObject({
        batchId: "diagnosis-test",
        externalBarcode: "2153722460015",
        wdtSpecNo: "3282770392869",
      });
    } finally {
      await database.close();
    }
  });
});

function fakeStockClient(): StockLookupClient {
  return {
    async queryStock(specNo) {
      return {
        status: 0,
        data: {
          total_count: 1,
          detail_list: [{ spec_no: specNo, warehouse_no: "001", warehouse_name: "主仓", available_send_stock: 5 }],
        },
      };
    },
  };
}

function orderLine(patch: Partial<OrderLine>): OrderLine {
  return {
    sourceFile: "test.xls",
    excelRow: 2,
    orderNoticeNo: "N1",
    orderApprovalNo: "A1",
    storeNo: "S001",
    storeName: "测试门店",
    deliveryTarget: "",
    orderDate: "2026-07-01",
    deadlineDate: "",
    uploadTime: "2026-07-01 10:00:00",
    salesperson: "",
    externalGoodsCode: "",
    externalGoodsName: "",
    externalBarcode: "",
    spec: "",
    transportSpec: "",
    orderBoxQty: "",
    orderQty: 1,
    unitPriceTaxIncluded: "",
    raw: {},
    ...patch,
  };
}

async function seedGoodsCacheSyncRun(
  status: "success" | "failed",
  specPatch: Partial<{ goodsNo: string; goodsName: string; specNo: string; specName: string; barcode: string }> = {},
): Promise<string> {
  const databaseUrl = `file:${resolve(process.cwd(), "outputs", `diagnose-cache-${randomUUID()}.db`).replaceAll("\\", "/")}`;
  const database = createDatabaseContext(databaseUrl, "apps/api/drizzle");
  try {
    await database.ready;
    await database.db.insert(wdtGoodsSpecs).values({
      id: `spec-${randomUUID()}`,
      goodsNo: specPatch.goodsNo ?? "G1",
      goodsName: specPatch.goodsName ?? "test goods",
      specNo: specPatch.specNo ?? "S1",
      specName: specPatch.specName ?? "test spec",
      specCode: "",
      barcode: specPatch.barcode ?? "B1",
      barcodesJson: JSON.stringify([specPatch.barcode ?? "B1"]),
      deleted: 0,
      modified: "2026-07-01 00:00:00",
      rawJson: "{}",
      syncedAt: "2026-07-01T00:00:00.000Z",
    });
    await database.db.insert(wdtGoodsSyncRuns).values({
      id: `run-${randomUUID()}`,
      mode: "full",
      status,
      startedAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T00:01:00.000Z",
      rangeStart: "2026-06-01T00:00:00.000Z",
      rangeEnd: "2026-07-01T00:00:00.000Z",
      windowCount: 1,
      pageCount: 1,
      fetchedCount: status === "success" ? 1 : 0,
      upsertedCount: status === "success" ? 1 : 0,
      errorMessage: status === "failed" ? "fetch failed" : "",
    });
    return databaseUrl;
  } finally {
    await database.close();
  }
}

function sampleOrderFile(): string {
  const filePath = resolve(process.cwd(), "outputs", "fixtures", "diagnose-order-sample.xlsx");
  if (existsSync(filePath)) return filePath;
  mkdirSync(dirname(filePath), { recursive: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        订货通知单号: "TEST-NOTICE-001",
        订货审批单号: "TEST-APPROVAL-001",
        阅读状态: "已读",
        送货方式: "配送",
        状态: "待处理",
        送货地: "测试仓",
        大类: "测试品类",
        门店: "STORE-001",
        门店名称: "测试门店1",
        订货日期: "2026-07-01",
        截止日期: "2026-07-10",
        上传时间: "2026-07-01 10:00:00",
        业务员: "测试业务员",
        制单人: "测试制单人",
        制单时间: "2026-07-01 09:00:00",
        审核人: "测试审核人",
        商品编码: "5372246",
        商品名称: "雅漾专研保湿修护面膜25ml*5片",
        商品条码: "2153722460015",
        规格: "",
        运输规格: "测试运输规格",
        订货箱数: "1",
        订货数: "1",
        未含税进价: "10.00",
        含税合同进价: "11.30",
        含税进价: "11.30",
        折扣率: "1",
        "保质期(天)": "365",
        实收数量: "",
        赠品率: "0",
        TD: "",
        DA: "",
        PD: "",
        SPD: "",
        REBATE: "",
      },
    ]),
    "订货通知单",
  );
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function testOutputFile(fileName: string): string {
  return resolve(process.cwd(), "outputs", fileName);
}
