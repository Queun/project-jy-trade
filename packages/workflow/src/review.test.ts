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
    readingStatus: "",
    deliveryMode: "",
    orderStatus: "",
    deliveryTarget: "",
    category: "",
    orderDate: "2026-06-30",
    deadlineDate: "2026-07-01",
    uploadTime: `2026-06-30 10:00:0${row}`,
    salesperson: "",
    maker: "",
    madeAt: "",
    sourceReviewer: "",
    externalGoodsCode: "",
    externalGoodsName: "测试商品",
    externalBarcode: barcode,
    spec: "",
    transportSpec: "",
    orderBoxQty: "",
    orderQty: qty,
    taxExcludedUnitPrice: "",
    contractPrice: "",
    unitPriceTaxIncluded: "",
    discountRate: "",
    shelfLifeDays: "",
    receivedQty: "",
    giftRate: "",
    td: "",
    da: "",
    pd: "",
    spd: "",
    rebate: "",
    raw: {},
  };
}

describe("buildReviewLines", () => {
  it("allocates repeated barcode stock in order without splitting a line across warehouses", () => {
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

    expect(lines.map((line) => line.status)).toEqual(["库存充足", "部分满足", "部分满足"]);
    expect(lines.map((line) => line.suggestedShipQty)).toEqual([6, 4, 2]);
    expect(lines.map((line) => [line.suggestedMainQty, line.suggestedNearExpiryQty])).toEqual([
      [6, 0],
      [4, 0],
      [0, 2],
    ]);
  });

  it("marks unmatched rows as not matched", () => {
    const [line] = buildReviewLines([orderLine("MISSING", 1, 1)], new Map());
    expect(line?.status).toBe("未匹配");
    expect(line?.suggestedShipQty).toBe(0);
  });
});
