import { resolve } from "node:path";

import { simulateReviewFlow } from "../flows/simulateReview.js";
import { loadDotEnv } from "../integrations/env.js";
import { WdtClient } from "../integrations/wdtClient.js";

loadDotEnv();

const orderFile = process.argv[2] ?? "ole案例文件——发货前\\1订货单\\订货通知单 .xls";
const warehouseNo = process.argv[3] ?? process.env.WDT_TEST_WAREHOUSE_NO;
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outputFile = process.argv[4] ?? resolve("outputs", `review-simulation-${timestamp}.xlsx`);
const mockDataFile = process.argv[5];

const result = await simulateReviewFlow(WdtClient.fromEnv(), {
  orderFile,
  warehouseNo,
  outputFile,
  mockDataFile,
});

console.log(JSON.stringify(result, null, 2));
