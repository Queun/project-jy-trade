import { describe, expect, it } from "vitest";

import { buildReviewLines } from "./review.js";
import type { OrderLine } from "./orders.js";

function orderLine(barcode: string, qty: number, row: number): OrderLine {
  return {
    sourceFile: "test.xlsx",
    excelRow: row,
    orderNoticeNo: `ORDER-${row}`,
    orderApprovalNo: "",
    storeNo: "STORE",
    storeName: "测试门店",
    deliveryTarget: "",
    orderDate: "2026-06-30",
    deadlineDate: "2026-07-01",
    uploadTime: `2026-06-30 10:00:0${row}`,
    salesperson: "",
    externalGoodsCode: "",
    externalGoodsName: "测试商品",
    externalBarcode: barcode,
    spec: "",
    transportSpec: "",
    orderBoxQty: "",
    orderQty: qty,
    unitPriceTaxIncluded: "",
    raw: {},
  };
}

describe("buildReviewLines", () => {
  it("allocates repeated barcode stock in order", () => {
    const lines = buildReviewLines(
      [orderLine("A", 6, 1), orderLine("A", 6, 2), orderLine("A", 6, 3)],
      new Map([
        [
          "A",
          {
            matchKey: "A",
            wdtSpecNo: "SPEC-A",
            mainAvailableStock: 10,
            nearExpiryAvailableStock: 2,
          },
        ],
      ]),
    );

    expect(lines.map((line) => line.status)).toEqual(["库存充足", "库存充足", "库存不足"]);
    expect(lines.map((line) => line.suggestedShipQty)).toEqual([6, 6, 0]);
  });

  it("marks unmatched rows as not matched", () => {
    const [line] = buildReviewLines([orderLine("MISSING", 1, 1)], new Map());
    expect(line?.status).toBe("未匹配");
    expect(line?.suggestedShipQty).toBe(0);
  });
});
