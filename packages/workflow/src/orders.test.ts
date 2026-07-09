import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { loadOrderLines } from "./orders.js";

describe("loadOrderLines", () => {
  it("reads the sheet named 原始单 before falling back to sheet position", () => {
    const filePath = resolve(process.cwd(), "../../outputs/fixtures/order-named-sheet.xlsx");
    mkdirSync(dirname(filePath), { recursive: true });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["说明"], ["这个 sheet 不应被导入"]]), "说明");
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          订货通知单号: "NOTICE-NAMED-SHEET",
          订货审批单号: "APPROVAL-NAMED-SHEET",
          门店: "STORE-001",
          门店名称: "命名Sheet门店",
          订货日期: "2026-07-10",
          截止日期: "2026-07-12",
          商品编码: "GOODS-001",
          商品名称: "命名Sheet商品",
          商品条码: "690000000001",
          规格: "5ml",
          运输规格: "1支",
          订货箱数: "1",
          订货数: "2",
        },
      ]),
      "原始单",
    );
    writeFileSync(filePath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer);

    const lines = loadOrderLines(filePath);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      orderNoticeNo: "NOTICE-NAMED-SHEET",
      storeName: "命名Sheet门店",
      externalGoodsName: "命名Sheet商品",
      orderQty: 2,
    });
  });
});
