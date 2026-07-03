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

  if (inputName === candidateName) {
    return { ...candidate, score: 92, basis: "exact_name" };
  }

  if (inputName.length >= 4 && (candidateName.includes(inputName) || inputName.includes(candidateName))) {
    return { ...candidate, score: 82, basis: "contains_name" };
  }

  const similarity = diceCoefficient(inputName, candidateName);
  if (similarity >= 0.72) {
    return { ...candidate, score: Math.round(similarity * 100), basis: "fuzzy_name" };
  }

  return undefined;
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

function candidateKey(candidate: ProductCandidate): string {
  return [candidate.source, candidate.goodsNo, candidate.specNo, candidate.goodsName, candidate.specName].filter(Boolean).join("|");
}

function summarizeCandidates(candidates: ScoredProductCandidate[]): string {
  return candidates.slice(0, 3).map(summarizeCandidate).join("; ");
}

function summarizeCandidate(candidate: ScoredProductCandidate): string {
  return `${candidate.specNo || candidate.goodsNo || "unknown"} score=${candidate.score} basis=${candidate.basis}`;
}
