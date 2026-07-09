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
}

export interface LocalProductMatchSources {
  mappings: ProductMappingCandidate[];
  goodsSpecs: LocalGoodsSpecCandidate[];
  suites?: LocalSuiteCandidate[];
}

export function decideLocalProductMatch(input: ProductMatchInput, sources: LocalProductMatchSources): ProductMatchDecision {
  const goodsDecision = decideProductMatch(input, sources.goodsSpecs.filter((spec) => spec.deleted !== 1).map(toProductCandidate));
  if (isAutomaticCodeDecision(goodsDecision)) return goodsDecision;

  const suiteDecision = decideProductMatch(input, (sources.suites ?? []).filter((suite) => suite.deleted !== 1).map(toSuiteProductCandidate));
  if (isAutomaticCodeDecision(suiteDecision)) return suiteDecision;

  const mapping = findConfirmedMapping(input, sources.mappings);
  if (mapping) {
    return {
      status: "matched",
      candidate: {
        source: "goods",
        goodsNo: mapping.wdtGoodsNo,
        goodsName: mapping.wdtGoodsName,
        specNo: mapping.wdtSpecNo,
        specName: mapping.wdtSpecName,
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
