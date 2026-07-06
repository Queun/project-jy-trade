import { readFirstSheetRows, rowsToObjects } from "./excelTable.js";

export const ORDER_REQUIRED_COLUMNS = [
  "订货通知单号",
  "订货审批单号",
  "门店",
  "门店名称",
  "订货日期",
  "截止日期",
  "商品编码",
  "商品名称",
  "商品条码",
  "规格",
  "运输规格",
  "订货箱数",
  "订货数",
] as const;

export interface OrderLine {
  sourceFile: string;
  excelRow: number;
  orderNoticeNo: string;
  orderApprovalNo: string;
  storeNo: string;
  storeName: string;
  readingStatus: string;
  deliveryMode: string;
  orderStatus: string;
  deliveryTarget: string;
  category: string;
  orderDate: string;
  deadlineDate: string;
  uploadTime: string;
  salesperson: string;
  maker: string;
  madeAt: string;
  sourceReviewer: string;
  externalGoodsCode: string;
  externalGoodsName: string;
  externalBarcode: string;
  spec: string;
  transportSpec: string;
  orderBoxQty: string;
  orderQty: number;
  taxExcludedUnitPrice: string;
  contractPrice: string;
  unitPriceTaxIncluded: string;
  discountRate: string;
  shelfLifeDays: string;
  receivedQty: string;
  giftRate: string;
  td: string;
  da: string;
  pd: string;
  spd: string;
  rebate: string;
  raw: Record<string, string>;
}

export function parseQuantity(value: string): number {
  const cleaned = value.replaceAll(",", "").trim();
  return cleaned ? Number(cleaned) : 0;
}

export function validateOrderColumns(headers: string[]): string[] {
  return ORDER_REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
}

export function loadOrderLines(filePath: string): OrderLine[] {
  const rows = readFirstSheetRows(filePath);
  if (rows.length === 0) return [];
  const headers = rows[0] ?? [];
  const missing = validateOrderColumns(headers);
  if (missing.length > 0) throw new Error(`Order file is missing required columns: ${missing.join(", ")}`);
  return rowsToObjects(rows, 1)
    .map((record): OrderLine => ({
      sourceFile: filePath,
      excelRow: Number(record._excel_row),
      orderNoticeNo: record["订货通知单号"] ?? "",
      orderApprovalNo: record["订货审批单号"] ?? "",
      storeNo: record["门店"] ?? "",
      storeName: record["门店名称"] ?? "",
      readingStatus: record["阅读状态"] ?? "",
      deliveryMode: record["送货方式"] ?? "",
      orderStatus: record["状态"] ?? "",
      deliveryTarget: record["送货地"] ?? "",
      category: record["大类"] ?? "",
      orderDate: record["订货日期"] ?? "",
      deadlineDate: record["截止日期"] ?? "",
      uploadTime: record["上传时间"] ?? "",
      salesperson: record["业务员"] ?? "",
      maker: record["制单人"] ?? "",
      madeAt: record["制单时间"] ?? "",
      sourceReviewer: record["审核人"] ?? "",
      externalGoodsCode: record["商品编码"] ?? "",
      externalGoodsName: record["商品名称"] ?? "",
      externalBarcode: record["商品条码"] ?? "",
      spec: record["规格"] ?? "",
      transportSpec: record["运输规格"] ?? "",
      orderBoxQty: record["订货箱数"] ?? "",
      orderQty: parseQuantity(record["订货数"] ?? ""),
      taxExcludedUnitPrice: record["未含税进价"] ?? "",
      contractPrice: record["含税合同进价"] ?? "",
      unitPriceTaxIncluded: record["含税进价"] ?? "",
      discountRate: record["折扣率"] ?? "",
      shelfLifeDays: record["保质期(天)"] ?? "",
      receivedQty: record["实收数量"] ?? "",
      giftRate: record["赠品率"] ?? "",
      td: record["TD"] ?? "",
      da: record["DA"] ?? "",
      pd: record["PD"] ?? "",
      spd: record["SPD"] ?? "",
      rebate: record["REBATE"] ?? "",
      raw: record,
    }))
    .sort((a, b) =>
      [a.uploadTime, a.orderDate, a.orderNoticeNo, String(a.excelRow)]
        .join("\u0000")
        .localeCompare([b.uploadTime, b.orderDate, b.orderNoticeNo, String(b.excelRow)].join("\u0000")),
    );
}
