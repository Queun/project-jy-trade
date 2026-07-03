import { mkdirSync } from "node:fs";

import XLSX from "xlsx";

mkdirSync("outputs", { recursive: true });

const rows = [
  {
    订货通知单号: "SIM202606300001",
    订货审批单号: "SIM-APPROVAL-001",
    门店: "cjmy003-test",
    门店名称: "测试门店",
    阅读状态: "已阅读",
    送货方式: "直送",
    状态: "有效订单",
    送货地: "[cjmy003-test] 测试门店",
    大类: "测试",
    订货日期: "2026-06-30",
    截止日期: "2026-07-01",
    上传时间: "2026-06-30 10:00:00",
    业务员: "测试员",
    制单人: "测试员",
    制单时间: "2026-06-30",
    审核人: "SYSTEM",
    商品编码: "TEST001",
    商品名称: "测试物品001",
    商品条码: process.argv[2] ?? "test001",
    规格: "test",
    运输规格: "1箱=1件",
    未含税进价: "1",
    订货箱数: "1箱",
    订货数: "1",
    折扣率: "0",
    "保质期(天)": "360天",
    实收数量: "",
    含税合同进价: "1",
    含税进价: "1",
    赠品率: "",
    TD: "0",
    DA: "0",
    PD: "0",
    SPD: "0",
    REBATE: "0",
  },
];

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "订货通知单");
XLSX.writeFile(workbook, "outputs/test-api-order.xlsx");
console.log("outputs/test-api-order.xlsx");
