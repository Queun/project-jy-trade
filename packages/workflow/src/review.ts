import type { OrderLine } from "./orders.js";

export interface InventorySnapshot {
  matchKey: string;
  wdtSpecNo: string;
  mainAvailableStock: number;
  nearExpiryAvailableStock: number;
  defectAvailableStock?: number;
  otherAvailableStock?: number;
  warehouseBreakdown?: string;
}

export type ReviewStatus = "库存充足" | "部分满足" | "库存不足" | "未匹配";

export interface ReviewLine {
  orderNoticeNo: string;
  excelRow: number;
  storeNo: string;
  storeName: string;
  uploadTime: string;
  orderApprovalNo: string;
  readingStatus: string;
  deliveryMode: string;
  orderStatus: string;
  deliveryTarget: string;
  category: string;
  orderDate: string;
  deadlineDate: string;
  salesperson: string;
  maker: string;
  madeAt: string;
  sourceReviewer: string;
  externalGoodsCode: string;
  externalBarcode: string;
  externalGoodsName: string;
  originalSpec: string;
  transportSpec: string;
  orderBoxQty: string;
  orderQty: number;
  taxExcludedUnitPrice: string;
  contractPrice: string;
  taxIncludedUnitPrice: string;
  discountRate: string;
  shelfLifeDays: string;
  receivedQty: string;
  giftRate: string;
  td: string;
  da: string;
  pd: string;
  spd: string;
  rebate: string;
  orderRawJson: string;
  wdtSpecNo: string;
  mainAvailableBefore: number;
  nearExpiryAvailableBefore: number;
  defectAvailableBefore: number;
  otherAvailableBefore: number;
  warehouseBreakdown: string;
  suggestedMainQty: number;
  suggestedNearExpiryQty: number;
  suggestedShipQty: number;
  remainingAfter: number;
  status: ReviewStatus;
}

export function buildReviewLines(orderLines: OrderLine[], inventoryByBarcode: Map<string, InventorySnapshot>): ReviewLine[] {
  const remainingMain = new Map<string, number>();
  const remainingNearExpiry = new Map<string, number>();
  for (const [key, snapshot] of inventoryByBarcode) {
    remainingMain.set(key, snapshot.mainAvailableStock);
    remainingNearExpiry.set(key, snapshot.nearExpiryAvailableStock);
  }

  return orderLines.map((line): ReviewLine => {
    const key = line.externalBarcode;
    const snapshot = inventoryByBarcode.get(key);
    if (!snapshot) {
      return {
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
        originalSpec: line.spec,
        transportSpec: line.transportSpec,
        orderBoxQty: line.orderBoxQty,
        orderQty: line.orderQty,
        taxExcludedUnitPrice: line.taxExcludedUnitPrice,
        contractPrice: line.contractPrice,
        taxIncludedUnitPrice: line.unitPriceTaxIncluded,
        discountRate: line.discountRate,
        shelfLifeDays: line.shelfLifeDays,
        receivedQty: line.receivedQty,
        giftRate: line.giftRate,
        td: line.td,
        da: line.da,
        pd: line.pd,
        spd: line.spd,
        rebate: line.rebate,
        orderRawJson: JSON.stringify(line.raw),
        wdtSpecNo: "",
        mainAvailableBefore: 0,
        nearExpiryAvailableBefore: 0,
        defectAvailableBefore: 0,
        otherAvailableBefore: 0,
        warehouseBreakdown: "",
        suggestedMainQty: 0,
        suggestedNearExpiryQty: 0,
        suggestedShipQty: 0,
        remainingAfter: 0,
        status: "未匹配",
      };
    }

    const mainBefore = remainingMain.get(key) ?? 0;
    const nearBefore = remainingNearExpiry.get(key) ?? 0;
    const defectBefore = snapshot.defectAvailableStock ?? 0;
    const otherBefore = snapshot.otherAvailableStock ?? 0;
    const suggestedMainQty = Math.min(line.orderQty, mainBefore);
    const suggestedNearExpiryQty = Math.min(line.orderQty - suggestedMainQty, nearBefore);
    const suggestedShipQty = suggestedMainQty + suggestedNearExpiryQty;
    const mainAfter = mainBefore - suggestedMainQty;
    const nearAfter = nearBefore - suggestedNearExpiryQty;
    remainingMain.set(key, mainAfter);
    remainingNearExpiry.set(key, nearAfter);

    let status: ReviewStatus = "库存不足";
    if (suggestedShipQty >= line.orderQty) status = "库存充足";
    else if (suggestedShipQty > 0) status = "部分满足";

    return {
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
      originalSpec: line.spec,
      transportSpec: line.transportSpec,
      orderBoxQty: line.orderBoxQty,
      orderQty: line.orderQty,
      taxExcludedUnitPrice: line.taxExcludedUnitPrice,
      contractPrice: line.contractPrice,
      taxIncludedUnitPrice: line.unitPriceTaxIncluded,
      discountRate: line.discountRate,
      shelfLifeDays: line.shelfLifeDays,
      receivedQty: line.receivedQty,
      giftRate: line.giftRate,
      td: line.td,
      da: line.da,
      pd: line.pd,
      spd: line.spd,
      rebate: line.rebate,
      orderRawJson: JSON.stringify(line.raw),
      wdtSpecNo: snapshot.wdtSpecNo,
      mainAvailableBefore: mainBefore,
      nearExpiryAvailableBefore: nearBefore,
      defectAvailableBefore: defectBefore,
      otherAvailableBefore: otherBefore,
      warehouseBreakdown: snapshot.warehouseBreakdown ?? "",
      suggestedMainQty,
      suggestedNearExpiryQty,
      suggestedShipQty,
      remainingAfter: mainAfter + nearAfter,
      status,
    };
  });
}
