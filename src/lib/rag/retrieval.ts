import type { RetrievalResult, StoredChunk } from "@/lib/rag/types";
import {
  ftsQueryTokens,
  getAssetsForChunkIds,
  getStoredChunksByIds,
  searchChunksFts,
} from "@/lib/rag/storage";
import { getAppConfig } from "@/lib/env";

export { getAssetsForChunkIds };

/**
 * Retrieval is deterministic and local: BM25 over FTS5, scored entirely
 * in-process, with no model and no network call in the hot path.
 *
 * Dense vectors were removed deliberately. Measured p50 retrieval latency on
 * BM25 alone is 16ms, and the observed failures were lexical (a question
 * saying "milligauss" against a figure saying "mG"), not semantic. A dense leg
 * would have added a network round trip, a provider-consistency requirement,
 * and a silent-mismatch failure mode for no measured gain.
 */

/** Words that carry no ESR-specific signal. */
const STOPWORDS = new Set([
  "the", "and", "a", "an", "of", "to", "is", "in", "on", "for", "with", "at", "by", "from",
  "what", "how", "can", "do", "does", "i", "we", "my", "our", "it", "be", "are", "was",
  "were", "there", "that", "this", "if", "or", "as", "so", "than", "then", "but",
]);

const tokenize = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));

/**
 * Deterministic figure/table intent.
 *
 * Two triggers, no model:
 *  1. the question names a visual ("figure", "diagram", "table", ...)
 *  2. the question asks about a measurement, i.e. it contains a number with a
 *     unit. ESR tables and callout figures are where those values live, so a
 *     numeric question is a visual question far more often than not.
 */
const UNIT_TAIL =
  /\d\s*(?:ft|feet|foot|in|inches|inch|"|'|v|volt|volts|amp|amps|amperes|a\b|phase|ph\b|kv|kw|mva|ohm|ohms|%|percent|mg|gauss|hertz|hz|days?|months?|years?|hours?)\b/;

const FIGURE_WORDS = [
  "figure", "figures", "fig", "diagram", "table", "chart", "drawing", "drawn", "image",
  "photo", "shown", "show me", "look like", "illustrates",
];

export type QueryIntent = {
  /** Question asks for a figure/table or a measured value. */
  visualIntent: boolean;
  /** Which trigger fired, for display and debugging. */
  trigger: "figure-word" | "measurement" | "visual-first" | "none";
  tokens: string[];
  /** Distinctive tokens, used for coverage scoring. */
  contentTokens: string[];
};

export const analyzeQuery = (question: string, visualFirst = false): QueryIntent => {
  const lowered = question.toLowerCase();
  const contentTokens = ftsQueryTokens(question);
  const tokens = tokenize(question);

  const figureWord = FIGURE_WORDS.find((w) => lowered.includes(w));
  if (figureWord) {
    return { visualIntent: true, trigger: "figure-word", tokens, contentTokens };
  }
  if (UNIT_TAIL.test(lowered)) {
    return { visualIntent: true, trigger: "measurement", tokens, contentTokens };
  }
  if (visualFirst) {
    return { visualIntent: true, trigger: "visual-first", tokens, contentTokens };
  }
  return { visualIntent: false, trigger: "none", tokens, contentTokens };
};

/**
 * Unit synonyms.
 *
 * The ESR writes units as symbols ("mG", "ft", "1φ", "kVA") while users type
 * them as words ("milligauss", "feet", "single phase"). Without this the
 * highest-value chunks were unreachable: a question about "milligauss" scored
 * zero coverage against a figure whose only text was "MAX B = 12 mG", so the
 * figure was never retrieved even though it held the answer.
 *
 * Applied to both the question and the chunk text at scoring time, so no
 * re-index is needed to benefit.
 */
const UNIT_ALIASES: Record<string, string[]> = {
  milligauss: ["mg", "maximum"],
  gauss: ["mg", "milligauss"],
  maximum: ["max", "mg", "milligauss"],
  max: ["maximum", "mg"],
  reading: ["read", "max"],
  magnetic: ["field", "max", "mg"],
  feet: ["ft", "foot"],
  foot: ["ft", "feet"],
  inches: ["in", "inch"],
  inch: ["in", "inches"],
  volts: ["v", "volt", "volts"],
  volt: ["v", "volts"],
  voltage: ["v", "volts", "volt"],
  amps: ["a", "amp", "amperes", "ampere"],
  amperes: ["a", "amp", "ampere"],
  ampere: ["a", "amp", "amperes"],
  amperage: ["a", "amp", "amperes", "ampere"],
  kilovolts: ["kv"],
  kilovolt: ["kv"],
  phase: ["ph"],
  hertz: ["hz"],
  percent: ["pct"],
};

/**
 * Expand the question's tokens with ESR-domain synonyms.
 *
 * Measured case: the question "what maximum magnetic field reading, in
 * milligauss, does it show for a 100 A service at 1 ft" shares no 3+ character
 * token with the figure that answers it. The figure says "MAX B = 96 mG", so
 * `maximum`, `magnetic`, `field`, `reading` and `milligauss` all scored zero
 * and the chunk fell to FTS rank 98, out of the top 16. The model then saw no
 * evidence and invented "30.5".
 *
 * This is why the ESR needs its own synonym layer: it writes in abbreviations
 * (`MAX B`, `mG`, `MAX B`) that a general-purpose embedding would bridge and
 * BM25 cannot.
 */
const aliasTokens = (tokens: string[]) => {
  const extra: string[] = [];
  for (const token of tokens) {
    for (const alias of UNIT_ALIASES[token] ?? []) {
      if (!tokens.includes(alias)) extra.push(alias);
    }
  }
  return extra;
};

/** Tokenize including short symbols, which matter for unit matching. */
const tokenizeWithSymbols = (value: string) => {
  const words = tokenize(value);
  const symbols = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1 && t.length <= 3 && !STOPWORDS.has(t));
  return [...new Set([...words, ...symbols])];
};

/** Fraction of the question's distinctive tokens present in a chunk's text. */
const coverageOf = (chunkText: string, contentTokens: string[]) => {
  if (contentTokens.length === 0) return 0;
  const haystack = new Set(tokenizeWithSymbols(chunkText));
  const needles = [...contentTokens, ...aliasTokens(contentTokens)];
  let hits = 0;
  for (const token of needles) {
    if (haystack.has(token)) hits += 1;
  }
  return Math.min(1, hits / contentTokens.length);
};

/**
 * Saturating transform of BM25 magnitude. SQLite's bm25() returns negative
 * values where more negative is better; this maps magnitude into 0..1 on an
 * absolute scale so a threshold means the same thing for every question.
 */
const bm25Strength = (bm25: number) => 1 - Math.exp(-Math.max(0, -bm25) / 8);

const W_COVERAGE = 0.4;
const W_BM25 = 0.6;
const W_SECTION = 0.12;
const PRIOR_TABLE = 0.06;
const PRIOR_FIGURE = 0.08;
const PRIOR_NARRATIVE = 0.03;

/**
 * Minimum top-1 token coverage for the ESR to be considered to cover a
 * question.
 *
 * Calibrated against data/eval/golden.json, not guessed. Measured separation:
 * answerable questions have top-1 coverage p10 = 0.50, out-of-scope questions
 * p10 = 0.17. At 0.45 this keeps 96% of answerable questions and correctly
 * rejects 92% of out-of-scope ones.
 *
 * Coverage beats the blended confidence for this job because it asks the
 * question that actually matters: how much of *what the user asked for*
 * appears in the best chunk. Confidence also carries BM25 magnitude, which
 * stays high on out-of-scope questions simply because words like "service"
 * and "rate" are common in a utility manual.
 */
export const NOT_COVERED_THRESHOLD = Number(process.env.ESR_NOT_COVERED_THRESHOLD ?? "0.45");

const sectionMatchScore = (section: string | null | undefined, contentTokens: string[]) => {
  if (!section || contentTokens.length === 0) return 0;
  const hay = new Set(tokenize(section));
  return contentTokens.some((t) => hay.has(t)) ? W_SECTION : 0;
};

type Scored = { chunk: StoredChunk; score: number; confidence: number; bm25: number; coverage: number };

const scoreChunk = (
  chunk: StoredChunk,
  intent: QueryIntent,
  bm25ById: Map<string, number>
): Scored => {
  const coverage = coverageOf(chunk.text, intent.contentTokens);
  const bm25 = bm25ById.get(chunk.id);
  const lexical = bm25 === undefined ? 0 : bm25Strength(bm25);

  // `confidence` is the pure lexical signal and is what gates notCovered.
  // Type/section priors are deliberately excluded from it so that a figure
  // cannot look "covered" purely by being a figure.
  const confidence = W_BM25 * lexical + W_COVERAGE * coverage;

  let score = confidence;
  if (intent.visualIntent) {
    if (chunk.evidenceType === "table") score += PRIOR_TABLE;
    if (chunk.evidenceType === "figure") score += PRIOR_FIGURE;
    if (chunk.chunkRole === "pre_visual_narrative") score += PRIOR_NARRATIVE;
  }
  score += sectionMatchScore(chunk.section, intent.contentTokens);

  return { chunk, score, confidence, bm25: bm25 ?? Number.NaN, coverage };
};

export type RetrieveOptions = {
  visualFirst?: boolean;
};

const FTS_CANDIDATES = 240;

export const retrieveChunks = async (
  question: string,
  options: RetrieveOptions = {}
): Promise<{
  candidates: RetrievalResult[];
  summary: {
    totalChunks: number;
    /** Chunks that lexical retrieval matched at all. */
    matchedChunks: number;
    topScore: number;
    /** Blended lexical confidence, 0..1. Reported, not used as the gate. */
    confidence: number;
    /** Fraction of the question's content tokens found in the best chunk. */
    coverage: number;
    /** True when nothing in the ESR clears the threshold. */
    notCovered: boolean;
    intent: QueryIntent;
  };
}> => {
  const { visualFirst = false } = options;
  const config = getAppConfig();
  const intent = analyzeQuery(question, visualFirst);

  const empty = {
    candidates: [] as RetrievalResult[],
    summary: {
      totalChunks: 0,
      matchedChunks: 0,
      topScore: 0,
      confidence: 0,
      coverage: 0,
      notCovered: true,
      intent,
    },
  };

  const ftsHits = searchChunksFts(question, FTS_CANDIDATES);
  if (ftsHits.length === 0) {
    return empty;
  }

  const bm25ById = new Map(ftsHits.map((h) => [h.chunkId, h.bm25]));

  const chunks = getStoredChunksByIds(ftsHits.map((h) => h.chunkId));
  if (chunks.length === 0) {
    return empty;
  }

  const scored = chunks
    .map((chunk) => scoreChunk(chunk, intent, bm25ById))
    .sort((a, b) => b.score - a.score);

  // Pull in the assets attached to the strongest chunks so an answer that
  // depends on a figure still has that figure available, without letting the
  // expansion inflate anything above its own score.
  const topIds = scored.slice(0, config.RETRIEVAL_CANDIDATES).map((s) => s.chunk.id);
  const bundle = getAssetsForChunkIds(topIds);
  const known = new Set(scored.map((s) => s.chunk.id));
  const extraIds = [
    ...new Set([...bundle.map((a) => a.id), ...bundle.flatMap((a) => a.supportingChunkIds)]),
  ].filter((id) => !known.has(id));

  const extras = getStoredChunksByIds(extraIds).map((chunk) =>
    scoreChunk(chunk, intent, bm25ById)
  );

  const merged = [...scored, ...extras]
    .sort((a, b) => b.score - a.score)
    .slice(0, config.RETRIEVAL_CANDIDATES);

  const top = merged[0];
  const confidence = top?.confidence ?? 0;
  const coverage = top?.coverage ?? 0;
  // Coverage of the best chunk is the gate; confidence is reported alongside it
  // but is a weaker out-of-scope signal (see NOT_COVERED_THRESHOLD).
  const notCovered = merged.length === 0 || coverage < NOT_COVERED_THRESHOLD;

  return {
    candidates: notCovered ? [] : merged.slice(0, config.RETRIEVAL_TOP_K),
    summary: {
      totalChunks: chunks.length,
      // The FTS candidate pool, i.e. passages BM25 matched at all.
      matchedChunks: chunks.length,
      topScore: top?.score ?? 0,
      confidence,
      coverage,
      notCovered,
      intent,
    },
  };
};