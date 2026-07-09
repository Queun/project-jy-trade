export type ProductMatchStatus = "matched" | "not_found" | "ambiguous" | "api_error";

export interface ProductMatchInput {
  barcode?: string;
  goodsCode?: string;
  goodsName?: string;
  specName?: string;
}

export interface ProductCandidate {
  source: "goods" | "suite";
  goodsNo?: string;
  goodsName?: string;
  specNo?: string;
  specName?: string;
  specCode?: string;
  makeOrderCode?: string;
  barcodes?: string[];
}

export interface ScoredProductCandidate extends ProductCandidate {
  score: number;
  basis: "barcode" | "code" | "exact_name" | "contains_name" | "fuzzy_name";
}

export interface ProductMatchDecision {
  status: ProductMatchStatus;
  candidate?: ScoredProductCandidate;
  candidates: ScoredProductCandidate[];
  message: string;
}

const HUMAN_REVIEW_SCORE = 70;
const AMBIGUOUS_SCORE_GAP = 8;
const MIN_NAME_MATCH_LENGTH = 4;
const MIN_PREFIX_VARIANT_REMAINING_RATIO = 0.5;

export function normalizeProductText(value: string | undefined): string {
  return (value ?? "")
    .replace(/[™®©]/g, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
}

export function scoreProductCandidate(input: ProductMatchInput, candidate: ProductCandidate): ScoredProductCandidate | undefined {
  const barcode = normalizeProductText(input.barcode);
  const goodsCode = normalizeProductText(input.goodsCode);
  const inputName = normalizeProductText([input.goodsName, input.specName].filter(Boolean).join(""));
  const candidateName = normalizeProductText([candidate.goodsName, candidate.specName].filter(Boolean).join(""));
  const candidateCodes = [candidate.goodsNo, candidate.specNo, candidate.specCode].map(normalizeProductText).filter(Boolean);
  const candidateBarcodes = (candidate.barcodes ?? []).map(normalizeProductText).filter(Boolean);

  if (barcode && candidateBarcodes.includes(barcode)) {
    return { ...candidate, score: 100, basis: "barcode" };
  }

  if (goodsCode && candidateCodes.includes(goodsCode)) {
    return { ...candidate, score: 95, basis: "code" };
  }

  if (!inputName || !candidateName) return undefined;

  const nameScores = inputNameVariants(inputName)
    .map((variant) => scoreNameVariant(variant, candidateName))
    .filter((score): score is Pick<ScoredProductCandidate, "score" | "basis"> => Boolean(score))
    .sort((left, right) => right.score - left.score);
  const bestNameScore = nameScores[0];

  return bestNameScore ? { ...candidate, ...bestNameScore } : undefined;
}

export function decideProductMatch(input: ProductMatchInput, candidates: ProductCandidate[]): ProductMatchDecision {
  const scored = candidates
    .map((candidate) => scoreProductCandidate(input, candidate))
    .filter((candidate): candidate is ScoredProductCandidate => Boolean(candidate))
    .sort((a, b) => b.score - a.score || candidateKey(a).localeCompare(candidateKey(b)));

  if (scored.length === 0 || scored[0].score < HUMAN_REVIEW_SCORE) {
    return {
      status: "not_found",
      candidates: scored.slice(0, 5),
      message: "No reliable WDT product candidate found",
    };
  }

  const barcodeMatches = scored.filter((candidate) => candidate.basis === "barcode");
  if (barcodeMatches.length === 1) {
    return {
      status: "matched",
      candidate: barcodeMatches[0],
      candidates: barcodeMatches,
      message: "Matched by barcode",
    };
  }
  if (barcodeMatches.length > 1) {
    return {
      status: "ambiguous",
      candidates: barcodeMatches.slice(0, 8),
      message: `Multiple barcode candidates found: ${summarizeCandidates(barcodeMatches)}`,
    };
  }

  const codeMatches = scored.filter((candidate) => candidate.basis === "code");
  if (codeMatches.length === 1) {
    return {
      status: "matched",
      candidate: codeMatches[0],
      candidates: codeMatches,
      message: "Matched by code",
    };
  }
  if (codeMatches.length > 1) {
    return {
      status: "ambiguous",
      candidates: codeMatches.slice(0, 8),
      message: `Multiple code candidates found: ${summarizeCandidates(codeMatches)}`,
    };
  }

  const best = scored[0];
  const closeCandidates = scored.filter((candidate) => best.score - candidate.score <= AMBIGUOUS_SCORE_GAP);

  if (closeCandidates.length > 1) {
    return {
      status: "ambiguous",
      candidates: closeCandidates.slice(0, 8),
      message: `Multiple close WDT candidates found: ${summarizeCandidates(closeCandidates)}`,
    };
  }

  return {
    status: "ambiguous",
    candidate: best,
    candidates: scored.slice(0, 5),
    message: `Name candidate needs human confirmation: ${summarizeCandidate(best)}`,
  };
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const aPairs = bigramCounts(a);
  const bPairs = bigramCounts(b);
  let intersection = 0;

  for (const [pair, count] of aPairs.entries()) {
    intersection += Math.min(count, bPairs.get(pair) ?? 0);
  }

  return (2 * intersection) / (countPairs(aPairs) + countPairs(bPairs));
}

function bigramCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < value.length - 1; index += 1) {
    const pair = value.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

function countPairs(counts: Map<string, number>): number {
  return [...counts.values()].reduce((total, count) => total + count, 0);
}

interface ProductNameVariant {
  value: string;
  penalty: number;
  original: boolean;
}

function inputNameVariants(inputName: string): ProductNameVariant[] {
  const variants: ProductNameVariant[] = [];
  const seen = new Set<string>();
  const addVariant = (value: string, penalty: number, original = false, minimumLength = MIN_NAME_MATCH_LENGTH) => {
    if (value.length < minimumLength || seen.has(value)) return;
    seen.add(value);
    variants.push({ value, penalty, original });
  };

  addVariant(inputName, 0, true, 2);
  const withoutTrailingSpec = stripTrailingSpec(inputName);
  addVariant(withoutTrailingSpec, 6);

  const base = withoutTrailingSpec.length >= MIN_NAME_MATCH_LENGTH ? withoutTrailingSpec : inputName;
  const leadingEnglishRemoved = stripLeadingEnglish(base);
  addVariant(leadingEnglishRemoved, 8);

  for (const count of [2, 3, 4, 5]) {
    const minimumRemainingLength = Math.max(MIN_NAME_MATCH_LENGTH, Math.ceil(base.length * MIN_PREFIX_VARIANT_REMAINING_RATIO));
    addVariant(stripLeadingCharacters(base, count), 8 + count + (count >= 4 ? 2 : 0), false, minimumRemainingLength);
  }

  return variants;
}

function scoreNameVariant(variant: ProductNameVariant, candidateName: string): Pick<ScoredProductCandidate, "score" | "basis"> | undefined {
  if (variant.value === candidateName) {
    const score = Math.max(0, 92 - variant.penalty);
    return { score, basis: variant.original ? "exact_name" : "contains_name" };
  }

  if (
    variant.value.length >= MIN_NAME_MATCH_LENGTH
    && candidateName.length >= MIN_NAME_MATCH_LENGTH
    && (candidateName.includes(variant.value) || variant.value.includes(candidateName))
  ) {
    return { score: Math.max(0, 82 - variant.penalty - embeddedCandidatePenalty(variant, candidateName)), basis: "contains_name" };
  }

  const similarity = diceCoefficient(variant.value, candidateName);
  if (similarity >= 0.72) {
    return { score: Math.max(0, Math.round(similarity * 100) - variant.penalty), basis: "fuzzy_name" };
  }

  return undefined;
}

function embeddedCandidatePenalty(variant: ProductNameVariant, candidateName: string): number {
  if (!variant.value.includes(candidateName) || candidateName.includes(variant.value)) return 0;
  let penalty = 0;
  if (!variant.value.startsWith(candidateName)) penalty += 8;
  if (candidateName.length / variant.value.length < 0.55) penalty += 4;
  return penalty;
}

function stripTrailingSpec(value: string): string {
  let current = value;
  for (let index = 0; index < 8; index += 1) {
    const next = current
      .replace(/(?:\d+(?:\.\d+)?(?:ml|毫升|l|g|克|kg|千克|片|包|支|瓶|盒|袋|贴|粒|颗|枚|只|套|组|个|抽|卷|罐|板|pcs?|p))$/iu, "")
      .replace(/(?:单片|单支|单包|试用装|旅行装|小样)$/u, "")
      .replace(/(?:[a-z]*\d+[a-z0-9]*)$/iu, "");
    if (next === current) break;
    current = next;
  }
  return current;
}

function stripLeadingEnglish(value: string): string {
  return value.replace(/^[a-z0-9]+/iu, "");
}

function stripLeadingCharacters(value: string, count: number): string {
  return [...value].slice(count).join("");
}

function candidateKey(candidate: ProductCandidate): string {
  return [candidate.source, candidate.goodsNo, candidate.specNo, candidate.goodsName, candidate.specName].filter(Boolean).join("|");
}

function summarizeCandidates(candidates: ScoredProductCandidate[]): string {
  return candidates.slice(0, 3).map(summarizeCandidate).join("; ");
}

function summarizeCandidate(candidate: ScoredProductCandidate): string {
  return `${candidate.specNo || candidate.goodsNo || "unknown"} score=${candidate.score} basis=${candidate.basis}`;
}
