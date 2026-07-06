import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { buildMockReview } from "./mockReview.js";
import { createSampleOrderFile } from "./testFixtures.js";

const root = resolve(process.cwd(), "../..");
const orderFile = createSampleOrderFile(resolve(root, "outputs/fixtures/sample-order.xlsx"));
const fullMock = resolve(root, "examples/mock_flow_data.json");
const mixedMock = resolve(root, "examples/mock_flow_mixed.json");

describe("buildMockReview", () => {
  it("builds a full mock review summary", () => {
    const result = buildMockReview(orderFile, fullMock, "batch-test");
    expect(result.orderLineCount).toBe(40);
    expect(result.uniqueBarcodeCount).toBe(4);
    expect(result.matchCounts.matched).toBe(4);
    expect(result.statusCounts["库存充足"]).toBeGreaterThan(0);
  });

  it("keeps ambiguous and not_found match states", () => {
    const result = buildMockReview(orderFile, mixedMock, "batch-test");
    expect(result.matchCounts.ambiguous).toBe(1);
    expect(result.matchCounts.not_found).toBe(1);
  });
});
