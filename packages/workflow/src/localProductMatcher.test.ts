import { describe, expect, it } from "vitest";

import { decideLocalProductMatch } from "./localProductMatcher.js";

describe("local product matcher", () => {
  it("uses confirmed mapping before automatic candidates", () => {
    const result = decideLocalProductMatch(
      { barcode: "external-1", goodsName: "外部商品" },
      {
        mappings: [
          {
            externalBarcode: "external-1",
            wdtSpecNo: "manual-spec",
            wdtGoodsName: "人工确认商品",
            status: "confirmed",
          },
        ],
        goodsSpecs: [
          {
            specNo: "auto-spec",
            goodsName: "外部商品",
            barcode: "external-1",
          },
        ],
      },
    );

    expect(result.status).toBe("matched");
    expect(result.candidate?.specNo).toBe("manual-spec");
    expect(result.message).toBe("Matched by confirmed product mapping");
  });

  it("matches a unique local barcode candidate", () => {
    const result = decideLocalProductMatch(
      { barcode: "8809985001673", goodsName: "测试商品" },
      {
        mappings: [],
        goodsSpecs: [{ specNo: "S1", goodsName: "测试商品", barcode: "8809985001673" }],
      },
    );

    expect(result.status).toBe("matched");
    expect(result.candidate?.specNo).toBe("S1");
  });

  it("keeps duplicate local barcode candidates ambiguous", () => {
    const result = decideLocalProductMatch(
      { barcode: "dup", goodsName: "测试商品" },
      {
        mappings: [],
        goodsSpecs: [
          { specNo: "S1", goodsName: "测试商品", barcode: "dup" },
          { specNo: "S2", goodsName: "测试商品", barcode: "dup" },
        ],
      },
    );

    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
  });

  it("keeps close name candidates ambiguous for confirmation", () => {
    const result = decideLocalProductMatch(
      { barcode: "external-only", goodsName: "雅漾专研保湿修护面膜", specName: "25ml*5片" },
      {
        mappings: [],
        goodsSpecs: [
          {
            goodsNo: "3282770392869",
            goodsName: "雅漾专研保湿修护面膜",
            specNo: "3282770392869",
            specName: "25ml*5",
            barcode: "3282770392869",
          },
        ],
      },
    );

    expect(result.status).toBe("ambiguous");
    expect(result.candidates[0].specNo).toBe("3282770392869");
  });

  it("returns not_found without mapping or usable candidates", () => {
    const result = decideLocalProductMatch(
      { barcode: "missing", goodsName: "不存在商品" },
      {
        mappings: [],
        goodsSpecs: [{ specNo: "S1", goodsName: "完全不同", barcode: "other" }],
      },
    );

    expect(result.status).toBe("not_found");
  });
});
