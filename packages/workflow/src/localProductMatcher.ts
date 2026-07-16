import { confirmedProductMappingMatchMessage } from "@jy-trade/shared";

import { createProductMatcher, type ProductCandidate, type ProductComponentCandidate, type ProductMatchDecision, type ProductMatchInput } from "./productMatcher.js";

export interface ProductMappingCandidate {
  externalBarcode?: string;
  externalGoodsName?: string;
  externalGoodsCode?: string;
  wdtGoodsNo?: string;
  wdtGoodsName?: string;
  wdtSpecNo: string;
  wdtSpecName?: string;
  wdtBarcode?: string;
  wdtMakeOrderCode?: string;
  status: "confirmed" | "disabled" | "needs_review";
}

export interface LocalGoodsSpecCandidate {
  goodsNo?: string;
  goodsName?: string;
  specNo: string;
  specName?: string;
  specCode?: string;
  barcode?: string;
  barcodes?: string[];
  deleted?: number;
}

export interface LocalSuiteCandidate {
  suiteNo: string;
  suiteName?: string;
  barcode?: string;
  components?: ProductComponentCandidate[];
  componentSpecNo?: string;
  componentGoodsNo?: string;
  componentGoodsName?: string;
  componentSpecName?: string;
  componentBarcode?: string;
  deleted?: number;
  modified?: string;
  syncedAt?: string;
}

export interface LocalProductMatchSources {
  mappings: ProductMappingCandidate[];
  goodsSpecs: LocalGoodsSpecCandidate[];
  suites?: LocalSuiteCandidate[];
}

export function decideLocalProductMatch(input: ProductMatchInput, sources: LocalProductMatchSources): ProductMatchDecision {
  return createLocalProductMatcher(sources)(input);
}

export function createLocalProductMatcher(sources: LocalProductMatchSources): (input: ProductMatchInput) => ProductMatchDecision {
  const goodsCandidates = sources.goodsSpecs.filter((spec) => spec.deleted !== 1).map(toProductCandidate);
  const suiteCandidates = (sources.suites ?? []).filter((suite) => suite.deleted !== 1).map(toSuiteProductCandidate);
  const matchGoods = createProductMatcher(goodsCandidates);
  const matchSuites = createProductMatcher(suiteCandidates);
  const mappingIndex = buildMappingIndex(sources.mappings);
  const cache = new Map<string, ProductMatchDecision>();

  return (input) => {
    const cacheKey = JSON.stringify([input.barcode ?? "", input.goodsCode ?? "", input.goodsName ?? "", input.specName ?? ""]);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const decision = decidePreparedLocalProductMatch(input, mappingIndex, matchGoods, matchSuites, sources.suites ?? []);
    cache.set(cacheKey, decision);
    return decision;
  };
}

function decidePreparedLocalProductMatch(
  input: ProductMatchInput,
  mappingIndex: ProductMappingIndex,
  matchGoods: (input: ProductMatchInput) => ProductMatchDecision,
  matchSuites: (input: ProductMatchInput) => ProductMatchDecision,
  suites: LocalSuiteCandidate[] = [],
): ProductMatchDecision {
  const mapping = findConfirmedMapping(input, mappingIndex);
  if (mapping) {
    const mappedSuite = suites.find((suite) => suite.suiteNo === mapping.wdtMakeOrderCode);
    const suiteCandidate = mappedSuite ? toSuiteProductCandidate(mappedSuite) : undefined;
    return {
      status: "matched",
      candidate: {
        ...suiteCandidate,
        source: mapping.wdtMakeOrderCode && mapping.wdtMakeOrderCode !== mapping.wdtSpecNo ? "suite" : "goods",
        goodsNo: mapping.wdtGoodsNo,
        goodsName: mapping.wdtGoodsName,
        specNo: suiteCandidate?.specNo ?? mapping.wdtSpecNo,
        specName: mapping.wdtSpecName,
        makeOrderCode: mapping.wdtMakeOrderCode || mapping.wdtSpecNo,
        barcodes: [...new Set([...(suiteCandidate?.barcodes ?? []), mapping.wdtBarcode].filter((item): item is string => Boolean(item)))],
        score: 110,
        basis: "code",
      },
      candidates: [],
      message: confirmedProductMappingMatchMessage,
    };
  }

  const goodsDecision = matchGoods(input);
  if (isAutomaticCodeDecision(goodsDecision)) return goodsDecision;

  const suiteDecision = matchSuites(input);
  if (isAutomaticCodeDecision(suiteDecision)) return suiteDecision;

  if (goodsDecision.status === "ambiguous") return goodsDecision;
  if (suiteDecision.status === "ambiguous") return suiteDecision;
  return goodsDecision;
}

interface IndexedMapping {
  mapping: ProductMappingCandidate;
  index: number;
}

interface ProductMappingIndex {
  byBarcode: Map<string, IndexedMapping>;
  byGoodsCode: Map<string, IndexedMapping>;
}

function buildMappingIndex(mappings: ProductMappingCandidate[]): ProductMappingIndex {
  const byBarcode = new Map<string, IndexedMapping>();
  const byGoodsCode = new Map<string, IndexedMapping>();
  mappings.forEach((mapping, index) => {
    if (mapping.status !== "confirmed") return;
    if (mapping.externalBarcode && !byBarcode.has(mapping.externalBarcode)) byBarcode.set(mapping.externalBarcode, { mapping, index });
    if (mapping.externalGoodsCode && !byGoodsCode.has(mapping.externalGoodsCode)) byGoodsCode.set(mapping.externalGoodsCode, { mapping, index });
  });
  return { byBarcode, byGoodsCode };
}

function findConfirmedMapping(input: ProductMatchInput, index: ProductMappingIndex): ProductMappingCandidate | undefined {
  const barcode = input.barcode ? index.byBarcode.get(input.barcode) : undefined;
  const goodsCode = input.goodsCode ? index.byGoodsCode.get(input.goodsCode) : undefined;
  if (!barcode) return goodsCode?.mapping;
  if (!goodsCode) return barcode.mapping;
  return barcode.index <= goodsCode.index ? barcode.mapping : goodsCode.mapping;
}

function toProductCandidate(spec: LocalGoodsSpecCandidate): ProductCandidate {
  return {
    source: "goods",
    goodsNo: spec.goodsNo,
    goodsName: spec.goodsName,
    specNo: spec.specNo,
    specName: spec.specName,
    specCode: spec.specCode,
    barcodes: [...new Set([spec.barcode, ...(spec.barcodes ?? [])].filter((item): item is string => Boolean(item)))],
  };
}

function toSuiteProductCandidate(suite: LocalSuiteCandidate): ProductCandidate {
  const components = suiteComponents(suite);
  const primary = components[0];
  return {
    source: "suite",
    goodsNo: suite.suiteNo,
    goodsName: suite.suiteName,
    specNo: primary?.specNo ?? "",
    specName: primary?.specName,
    specCode: suite.suiteNo,
    makeOrderCode: suite.suiteNo,
    barcodes: [...new Set([suite.barcode, suite.suiteNo, ...components.map((component) => component.barcode)].filter((item): item is string => Boolean(item)))],
    components,
  };
}

function suiteComponents(suite: LocalSuiteCandidate): ProductComponentCandidate[] {
  if (suite.components?.length) return suite.components;
  if (!suite.componentSpecNo) return [];
  return [{
    specNo: suite.componentSpecNo,
    goodsNo: suite.componentGoodsNo,
    goodsName: suite.componentGoodsName,
    specName: suite.componentSpecName,
    barcode: suite.componentBarcode,
    quantityPerItem: 1,
  }];
}

function isAutomaticCodeDecision(decision: ProductMatchDecision): boolean {
  if (decision.status === "matched") return true;
  return decision.status === "ambiguous" && decision.candidates.some((candidate) => candidate.basis === "barcode" || candidate.basis === "code");
}
