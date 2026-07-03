import { readFileSync } from "node:fs";

import { loadOrderLines } from "../core/orders.js";
import { buildReviewLines, type InventorySnapshot } from "../core/review.js";

const orderFile = process.argv[2];
const inventoryFile = process.argv[3];
const sampleSize = Number(process.argv[4] ?? 10);

if (!orderFile || !inventoryFile) {
  throw new Error("Usage: npm run node:review -- <order-file> <inventory-json> [sample-size]");
}

interface InventoryJsonItem {
  barcode: string;
  wdt_spec_no?: string;
  main_available_stock?: number;
  near_expiry_available_stock?: number;
}

const inventoryJson = JSON.parse(readFileSync(inventoryFile, "utf8")) as InventoryJsonItem[];
const inventory = new Map<string, InventorySnapshot>(
  inventoryJson.map((item) => [
    item.barcode,
    {
      matchKey: item.barcode,
      wdtSpecNo: item.wdt_spec_no ?? "",
      mainAvailableStock: Number(item.main_available_stock ?? 0),
      nearExpiryAvailableStock: Number(item.near_expiry_available_stock ?? 0),
    },
  ]),
);

const reviewLines = buildReviewLines(loadOrderLines(orderFile), inventory);
const statusCounts = reviewLines.reduce<Record<string, number>>((counts, line) => {
  counts[line.status] = (counts[line.status] ?? 0) + 1;
  return counts;
}, {});

console.log(
  JSON.stringify(
    {
      lineCount: reviewLines.length,
      statusCounts,
      sample: reviewLines.slice(0, sampleSize),
    },
    null,
    2,
  ),
);
