import { describe, expect, it } from "vitest";

import { decideProductMatch, normalizeProductText } from "./productMatcher.js";

describe("product matcher", () => {
  it("matches a unique exact barcode", () => {
    const result = decideProductMatch(
      { barcode: "A11010212", goodsName: "益家小蓝瓶" },
      [
        {
          source: "goods",
          goodsNo: "A11010212",
          goodsName: "万益蓝WonderLab 益家小蓝瓶",
          specNo: "A11010212",
          barcodes: ["A11010212"],
        },
      ],
    );

    expect(result.status).toBe("matched");
    expect(result.candidate?.specNo).toBe("A11010212");
  });

  it("returns an exact barcode match without scoring unrelated product names", () => {
    const unrelated = {
      source: "goods" as const,
      specNo: "OTHER",
      barcodes: ["other"],
      get goodsName(): string {
        throw new Error("unrelated product name should not be scored");
      },
    };
    const result = decideProductMatch(
      { barcode: "EXACT", goodsName: "测试商品" },
      [
        { source: "goods", specNo: "EXACT", goodsName: "测试商品", barcodes: ["EXACT"] },
        unrelated,
      ],
    );

    expect(result.status).toBe("matched");
    expect(result.candidate?.specNo).toBe("EXACT");
  });

  it("keeps duplicate barcode candidates ambiguous", () => {
    const result = decideProductMatch(
      { barcode: "test001", goodsName: "测试物品001" },
      [
        { source: "goods", goodsName: "测试物品001", specNo: "ghs_123", barcodes: ["test001"] },
        { source: "goods", goodsName: "测试物品001", specNo: "TEST001", barcodes: ["TEST001"] },
      ],
    );

    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
  });

  it("returns name fallback as ambiguous for human confirmation", () => {
    const result = decideProductMatch(
      { barcode: "external-only", goodsName: "万益蓝WonderLab 益家小蓝瓶 10瓶装" },
      [
        {
          source: "goods",
          goodsName: "万益蓝WonderLab_益家小蓝瓶™ 10瓶装",
          specNo: "A11010212",
          barcodes: ["A11010212"],
        },
      ],
    );

    expect(result.status).toBe("ambiguous");
    expect(["exact_name", "contains_name", "fuzzy_name"]).toContain(result.candidates[0].basis);
  });

  it("keeps a close name and spec candidate ambiguous when barcode differs", () => {
    const result = decideProductMatch(
      { barcode: "2153722460015", goodsName: "雅漾专研保湿修护面膜", specName: "25ml*5片" },
      [
        {
          source: "goods",
          goodsNo: "3282770392869",
          goodsName: "雅漾专研保湿修护面膜",
          specNo: "3282770392869",
          specName: "25ml*5",
          barcodes: ["3282770392869"],
        },
      ],
    );

    expect(result.status).toBe("ambiguous");
    expect(result.candidates[0]).toMatchObject({
      specNo: "3282770392869",
      basis: "contains_name",
    });
  });

  it("normalizes width, symbols, punctuation, and whitespace", () => {
    expect(normalizeProductText(" 益家小蓝瓶™_10 瓶装 ")).toBe(normalizeProductText("益家小蓝瓶10瓶装"));
  });

  it("finds manual candidates after trimming trailing package specs", () => {
    const result = decideProductMatch(
      { goodsName: "肌肤未来光感透润美白面膜单片25ml" },
      [{ source: "goods", goodsName: "肌肤未来光感透润美白面膜", specNo: "MASK-25ML", barcodes: ["MASK-25ML"] }],
    );

    expect(result.status).toBe("ambiguous");
    expect(result.candidates[0]).toMatchObject({ specNo: "MASK-25ML", basis: "contains_name" });
  });

  it("finds manual candidates after trimming leading English brand text", () => {
    const result = decideProductMatch(
      { goodsName: "CPB金致乳霜5ml" },
      [{ source: "goods", goodsName: "金致乳霜", specNo: "CREAM-5ML", barcodes: ["CREAM-5ML"] }],
    );

    expect(result.status).toBe("ambiguous");
    expect(result.candidates[0]).toMatchObject({ specNo: "CREAM-5ML", basis: "contains_name" });
  });

  it("finds low-weight candidates after conservative leading Chinese trimming", () => {
    const result = decideProductMatch(
      { goodsName: "肌肤之钥金致乳霜5ml" },
      [{ source: "goods", goodsName: "金致乳霜", specNo: "CPB-CREAM-5ML", barcodes: ["CPB-CREAM-5ML"] }],
    );

    expect(result.status).toBe("ambiguous");
    expect(result.candidates[0]).toMatchObject({ specNo: "CPB-CREAM-5ML", basis: "contains_name" });
    expect(result.candidates[0].score).toBeLessThan(82);
  });

  it("does not auto-match weak name candidates", () => {
    const result = decideProductMatch(
      { goodsName: "益生菌小样" },
      [{ source: "goods", goodsName: "完全不同的测试物品", specNo: "X1", barcodes: ["X1"] }],
    );

    expect(result.status).toBe("not_found");
  });

  it("does not match overly short generic names after trimming", () => {
    const result = decideProductMatch(
      { goodsName: "肌肤之钥乳霜5ml" },
      [{ source: "goods", goodsName: "霜", specNo: "GENERIC-CREAM", barcodes: ["GENERIC-CREAM"] }],
    );

    expect(result.status).toBe("not_found");
  });

  it("keeps suite candidates distinguishable", () => {
    const result = decideProductMatch(
      { goodsCode: "SUITE-001", goodsName: "测试套装" },
      [{ source: "suite", goodsNo: "SUITE-001", goodsName: "测试套装", specNo: "SUITE-001", barcodes: [] }],
    );

    expect(result.status).toBe("matched");
    expect(result.candidate?.source).toBe("suite");
  });
});
