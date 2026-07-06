import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as XLSX from "xlsx";

const sampleBarcodes = ["8809985001673", "8800295960896", "6941594515256", "2153722460015"] as const;

export function createSampleOrderFile(filePath: string, rowCount = 40): string {
  mkdirSync(dirname(filePath), { recursive: true });
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const barcode = sampleBarcodes[index % sampleBarcodes.length];
    const orderIndex = index + 1;
    return {
      订货通知单号: `TEST-NOTICE-${String(Math.floor(index / 4) + 1).padStart(3, "0")}`,
      订货审批单号: `TEST-APPROVAL-${String(Math.floor(index / 4) + 1).padStart(3, "0")}`,
      阅读状态: "已读",
      送货方式: "配送",
      状态: "待处理",
      送货地: "测试仓",
      大类: "测试品类",
      门店: `STORE-${String((index % 5) + 1).padStart(3, "0")}`,
      门店名称: `测试门店${(index % 5) + 1}`,
      订货日期: "2026-07-01",
      截止日期: "2026-07-10",
      上传时间: `2026-07-01 10:${String(index % 60).padStart(2, "0")}:00`,
      业务员: "测试业务员",
      制单人: "测试制单人",
      制单时间: "2026-07-01 09:00:00",
      审核人: "测试审核人",
      商品编码: `GOODS-${barcode}`,
      商品名称: `测试商品${(index % sampleBarcodes.length) + 1}`,
      商品条码: barcode,
      规格: "测试规格",
      运输规格: "测试运输规格",
      订货箱数: String((index % 3) + 1),
      订货数: String(orderIndex % 6 === 0 ? 8 : (index % 4) + 1),
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
    };
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "订货通知单");
  writeFileSync(filePath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer);
  return filePath;
}

export function createSampleAddressBookFile(filePath: string, storeCount = 5): string {
  mkdirSync(dirname(filePath), { recursive: true });
  const rows = Array.from({ length: storeCount }, (_, index) => {
    const storeIndex = index + 1;
    return {
      "门店编码/群组": `STORE-${String(storeIndex).padStart(3, "0")}`,
      门店名称: `测试门店${storeIndex}`,
      门店地址: `测试城市测试区第${storeIndex}号`,
      经理: `测试收货人${storeIndex}`,
      联系方式: `1880000000${storeIndex}`,
      片区: "测试片区",
    };
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "地址表");
  writeFileSync(filePath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer);
  return filePath;
}
