import { confirmedProductMappingMatchMessage } from "@jy-trade/shared";

import { decideProductMatch, type ProductCandidate, type ProductMatchDecision, type ProductMatchInput } from "./productMatcher.js";

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
  componentSpecNo: string;
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
  const cache = new Map<string, ProductMatchDecision>();

  return (input) => {
    const cacheKey = JSON.stringify([input.barcode ?? "", input.goodsCode ?? "", input.goodsName ?? "", input.specName ?? ""]);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const decision = decidePreparedLocalProductMatch(input, sources.mappings, goodsCandidates, suiteCandidates);
    cache.set(cacheKey, decision);
    return decision;
  };
}

function decidePreparedLocalProductMatch(
  input: ProductMatchInput,
  mappings: ProductMappingCandidate[],
  goodsCandidates: ProductCandidate[],
  suiteCandidates: ProductCandidate[],
): ProductMatchDecision {
  const goodsDecision = decideProductMatch(input, goodsCandidates);
  if (isAutomaticCodeDecision(goodsDecision)) return goodsDecision;

  const suiteDecision = decideProductMatch(input, suiteCandidates);
  if (isAutomaticCodeDecision(suiteDecision)) return suiteDecision;

  const mapping = findConfirmedMapping(input, mappings);
  if (mapping) {
    return {
      status: "matched",
      candidate: {
        source: mapping.wdtMakeOrderCode && mapping.wdtMakeOrderCode !== mapping.wdtSpecNo ? "suite" : "goods",
        goodsNo: mapping.wdtGoodsNo,
        goodsName: mapping.wdtGoodsName,
        specNo: mapping.wdtSpecNo,
        specName: mapping.wdtSpecName,
        makeOrderCode: mapping.wdtMakeOrderCode || mapping.wdtSpecNo,
        barcodes: [mapping.wdtBarcode].filter((item): item is string => Boolean(item)),
        score: 110,
        basis: "code",
      },
      candidates: [],
      message: confirmedProductMappingMatchMessage,
    };
  }

  if (goodsDecision.status === "ambiguous") return goodsDecision;
  if (suiteDecision.status === "ambiguous") return suiteDecision;
  return goodsDecision;
}

function findConfirmedMapping(input: ProductMatchInput, mappings: ProductMappingCandidate[]): ProductMappingCandidate | undefined {
  return mappings.find((mapping) => {
    if (mapping.status !== "confirmed") return false;
    if (input.barcode && mapping.externalBarcode && input.barcode === mapping.externalBarcode) return true;
    if (input.goodsCode && mapping.externalGoodsCode && input.goodsCode === mapping.externalGoodsCode) return true;
    return false;
  });
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
  return {
    source: "suite",
    goodsNo: suite.suiteNo,
    goodsName: suite.suiteName,
    specNo: suite.componentSpecNo,
    specName: suite.componentSpecName,
    specCode: suite.suiteNo,
    makeOrderCode: suite.suiteNo,
    barcodes: [...new Set([suite.barcode, suite.suiteNo, suite.componentBarcode].filter((item): item is string => Boolean(item)))],
  };
}

function isAutomaticCodeDecision(decision: ProductMatchDecision): boolean {
  if (decision.status === "matched") return true;
  return decision.status === "ambiguous" && decision.candidates.some((candidate) => candidate.basis === "barcode" || candidate.basis === "code");
}
