import { readFileSync } from "node:fs";

import type { MatchStatus, ReviewDecision, ReviewLineDto } from "@jy-trade/shared";

import { loadOrderLines } from "./orders.js";
import { buildReviewLines, type InventorySnapshot } from "./review.js";

export interface MockMatch {
  barcode: string;
  status: MatchStatus;
  wdtSpecNo: string;
  goodsName: string;
  specName: string;
  candidateCount: number;
  message: string;
}

export interface MockFlowData {
  matches: MockMatch[];
  inventory: Array<{
    barcode: string;
    wdtSpecNo: string;
    mainAvailableStock?: number;
    nearExpiryAvailableStock?: number;
  }>;
}

export interface MockReviewResult {
  orderLineCount: number;
  uniqueBarcodeCount: number;
  matchedBarcodeCount: number;
  statusCounts: Record<string, number>;
  matchCounts: Record<string, number>;
  reviewLines: ReviewLineDto[];
}

export function loadMockFlowData(filePath: string): MockFlowData {
  return JSON.parse(readFileSync(filePath, "utf8")) as MockFlowData;
}

export function buildMockReview(orderFile: string, mockDataFile: string, batchId = "batch-preview"): MockReviewResult {
  const orderLines = loadOrderLines(orderFile);
  const mockData = loadMockFlowData(mockDataFile);
  const matches = new Map(mockData.matches.map((match) => [match.barcode, match]));
  const inventory = new Map<string, InventorySnapshot>(
    mockData.inventory.map((item) => [
      item.barcode,
      {
        matchKey: item.barcode,
        wdtSpecNo: item.wdtSpecNo,
        mainAvailableStock: Number(item.mainAvailableStock ?? 0),
        nearExpiryAvailableStock: Number(item.nearExpiryAvailableStock ?? 0),
      },
    ]),
  );
  const reviewLines = buildReviewLines(orderLines, inventory);
  const dtos: ReviewLineDto[] = reviewLines.map((line, index) => {
    const match = matches.get(line.externalBarcode);
    const decision: ReviewDecision = line.status === "库存充足" ? "ship" : "pending";
    return {
      id: `${batchId}-line-${index + 1}`,
      batchId,
      orderNoticeNo: line.orderNoticeNo,
      excelRow: line.excelRow,
      storeNo: line.storeNo,
      storeName: line.storeName,
      uploadTime: line.uploadTime,
      orderApprovalNo: line.orderApprovalNo,
      readingStatus: line.readingStatus,
      deliveryMode: line.deliveryMode,
      orderStatus: line.orderStatus,
      deliveryTarget: line.deliveryTarget,
      category: line.category,
      orderDate: line.orderDate,
      deadlineDate: line.deadlineDate,
      salesperson: line.salesperson,
      maker: line.maker,
      madeAt: line.madeAt,
      sourceReviewer: line.sourceReviewer,
      externalGoodsCode: line.externalGoodsCode,
      externalBarcode: line.externalBarcode,
      externalGoodsName: line.externalGoodsName,
      originalSpec: line.originalSpec,
      transportSpec: line.transportSpec,
      orderBoxQty: line.orderBoxQty,
      taxExcludedUnitPrice: line.taxExcludedUnitPrice,
      contractPrice: line.contractPrice,
      taxIncludedUnitPrice: line.taxIncludedUnitPrice,
      discountRate: line.discountRate,
      shelfLifeDays: line.shelfLifeDays,
      receivedQty: line.receivedQty,
      giftRate: line.giftRate,
      td: line.td,
      da: line.da,
      pd: line.pd,
      spd: line.spd,
      rebate: line.rebate,
      orderRawJson: line.orderRawJson,
      goodsName: match?.goodsName ?? "",
      specName: match?.specName ?? "",
      wdtSpecNo: line.wdtSpecNo || match?.wdtSpecNo || "",
      wdtMakeOrderCode: line.wdtSpecNo || match?.wdtSpecNo || "",
      matchStatus: match?.status ?? "not_found",
      matchMessage: match?.message ?? "未匹配",
      orderQty: line.orderQty,
      mainAvailableBefore: line.mainAvailableBefore,
      nearExpiryAvailableBefore: line.nearExpiryAvailableBefore,
      suggestedShipQty: line.suggestedShipQty,
      status: line.status,
      decision,
      approvedShipQty: decision === "ship" ? line.suggestedShipQty : 0,
      reason: "",
      priority: false,
      priorityReason: "",
    };
  });

  return {
    orderLineCount: orderLines.length,
    uniqueBarcodeCount: new Set(orderLines.map((line) => line.externalBarcode).filter(Boolean)).size,
    matchedBarcodeCount: [...matches.values()].filter((match) => match.status === "matched").length,
    statusCounts: countBy(dtos.map((line) => line.status)),
    matchCounts: countBy([...matches.values()].map((match) => match.status)),
    reviewLines: dtos,
  };
}

function countBy(items: string[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item] = (counts[item] ?? 0) + 1;
    return counts;
  }, {});
}
