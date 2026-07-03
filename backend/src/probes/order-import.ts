import { loadOrderLines } from "../core/orders.js";

const file = process.argv[2];
const sampleSize = Number(process.argv[3] ?? 5);

if (!file) {
  throw new Error("Usage: npm run node:order -- <order-file> [sample-size]");
}

const lines = loadOrderLines(file);
const barcodeCounts = new Map<string, number>();
for (const line of lines) {
  if (!line.externalBarcode) continue;
  barcodeCounts.set(line.externalBarcode, (barcodeCounts.get(line.externalBarcode) ?? 0) + 1);
}

const duplicatedBarcodes = Object.fromEntries(
  [...barcodeCounts.entries()].filter(([, count]) => count > 1),
);

console.log(
  JSON.stringify(
    {
      file,
      lineCount: lines.length,
      orderCount: new Set(lines.map((line) => line.orderNoticeNo)).size,
      storeCount: new Set(lines.map((line) => line.storeNo)).size,
      skuCount: new Set(lines.map((line) => line.externalBarcode).filter(Boolean)).size,
      duplicatedBarcodeCount: Object.keys(duplicatedBarcodes).length,
      duplicatedBarcodes,
      sample: lines.slice(0, sampleSize),
    },
    null,
    2,
  ),
);
