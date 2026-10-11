import type { RetrievalResult, StoredChunk } from "@/lib/rag/types";
import {
  expandShorthand,
  ftsQueryTokens,
  getAssetsForChunkIds,
  getLexiconEntries,
  getManualAffinity,
  searchTablesByMeasure,
  getChunksByPairGroup,
  getShortTextChunksByPages,
  getStoredChunksByIds,
  searchChunksFts,
} from "@/lib/rag/storage";
import { getAppConfig } from "@/lib/env";
import { manualsNamedIn, type ManualId } from "@/lib/rag/docs";
import { UNIT_ALIASES } from "@/lib/rag/lexicon-data";
import { extractMeasurements, measureKey } from "./measure";

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
  /\d\s*(?:ft|feet|foot|in|inches|inch|"|'|v|volt|volts|amp|amps|amperes|a\b|phase|ph\b|kv|kw|mva|ohm|ohms|%|percent|mg|gauss|hertz|hz|days?|months?|years?|hours?)(?![a-z0-9])/;

const FIGURE_WORDS = [
  "figure", "figures", "fig", "diagram", "table", "chart", "drawing", "drawn", "image",
  "photo", "shown", "show me", "look like", "illustrates",
];

/**
 * Deterministic typo/shorthand correction in front of retrieval.
 *
 * Only tokens NOT already in the corpus lexicon are ever rewritten — "pool"
 * and "pole" are both real words, so a token that is already known is left
 * alone no matter how close a neighbour sits. An unknown token is replaced by
 * its Damerau-Levenshtein distance-1 neighbour (one insertion, deletion,
 * substitution, or adjacent transposition), weighted by document frequency
 * with ties broken alphabetically, so the choice is fully deterministic.
 * Tokens carrying digits (measurements, sheet ids, pole numbers) are never
 * rewritten: digits match nothing by accident and everything by design.
 *
 * Cost is O(54·L) hash lookups, not O(corpus): instead of scanning every
 * lexicon term near the query token's length, generate every string at
 * distance 1 and look each up in the byTerm map. A bucket scan cost ~11ms
 * per question (21k terms, wide buckets); variant generation is sub-ms.
 */
type LexiconIndex = {
  byTerm: Map<string, number>;
};

let cachedLexiconIndex: LexiconIndex | null = null;

const getLexiconIndex = (): LexiconIndex => {
  if (cachedLexiconIndex) {
    return cachedLexiconIndex;
  }
  const byTerm = new Map<string, number>();
  for (const { term, df } of getLexiconEntries()) {
    byTerm.set(term, df);
  }
  cachedLexiconIndex = { byTerm };
  return cachedLexiconIndex;
};

/** Every lowercase string at Damerau-Levenshtein distance 1 from `token`. */
const oneEditVariants = (token: string): string[] => {
  const out: string[] = [];
  const n = token.length;
  for (let i = 0; i < n; i += 1) out.push(token.slice(0, i) + token.slice(i + 1));
  for (let i = 0; i <= n; i += 1) {
    for (let c = 97; c <= 122; c += 1) {
      const ch = String.fromCharCode(c);
      out.push(token.slice(0, i) + ch + token.slice(i));
    }
  }
  for (let i = 0; i < n; i += 1) {
    for (let c = 97; c <= 122; c += 1) {
      const ch = String.fromCharCode(c);
      if (ch === token[i]) continue;
      out.push(token.slice(0, i) + ch + token.slice(i + 1));
    }
  }
  for (let i = 0; i < n - 1; i += 1) {
    out.push(token.slice(0, i) + token[i + 1] + token[i] + token.slice(i + 2));
  }
  return out;
};

/** Minimum token length the corrector attempts. Shorter tokens are looked up, never rewritten. */
const MIN_CORRECT_LENGTH = 3;

/**
 * Correction memo. Variant generation builds ~54·L strings per token, so an
 * uncorrected token costs a few thousand Map lookups every time it appears;
 * across a 78-row eval the same OOV words recur constantly. Capped so a long
 * run cannot grow it without bound — correctness is unaffected (the mapping
 * is pure), only repeat-lookup speed.
 */
const correctionMemo = new Map<string, string>();
const CORRECTION_MEMO_MAX = 20000;

export const correctToken = (token: string): string => {
  const memoized = correctionMemo.get(token);
  if (memoized !== undefined) return memoized;
  const result = computeCorrectToken(token);
  if (correctionMemo.size < CORRECTION_MEMO_MAX) {
    correctionMemo.set(token, result);
  }
  return result;
};

const computeCorrectToken = (token: string): string => {
  if (token.length < MIN_CORRECT_LENGTH) return token;
  if (/\d/.test(token)) return token;
  const { byTerm } = getLexiconIndex();
  if (byTerm.has(token)) return token;
  let best: string | null = null;
  let bestDf = -1;
  for (const variant of oneEditVariants(token)) {
    const df = byTerm.get(variant);
    if (df === undefined) continue;
    if (df > bestDf || (df === bestDf && variant < (best ?? "￿"))) {
      best = variant;
      bestDf = df;
    }
  }
  return best ?? token;
};

/**
 * The question's FTS tokens with typos corrected. Corrected tokens flow into
 * BOTH the FTS MATCH query and the coverage scorer's contentTokens, so the
 * gate reads the user's corrected words. Re-tokenizing the corrected string
 * re-applies the length/stopword/cap rules identically, so a correction that
 * lands on a stopword ("shal" → "shall") is filtered exactly as if typed.
 */
export const correctedFtsTokens = (raw: string): string[] => {
  const first = ftsQueryTokens(raw);
  if (first.length === 0) return first;
  let changed = false;
  const fixed = first.map((token) => {
    const next = correctToken(token);
    if (next !== token) changed = true;
    return next;
  });
  if (!changed) return first;
  return ftsQueryTokens(fixed.join(" "));
};

/** Original → corrected mapping for a question, for debugging and residuals. */
export const correctionsFor = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const token of ftsQueryTokens(raw)) {
    const fixed = correctToken(token);
    if (fixed !== token) out[token] = fixed;
  }
  return out;
};

export type QueryIntent = {
  /** Question asks for a figure/table or a measured value. */
  visualIntent: boolean;
  /** Question asks permission (approve/allowed/can I) — answered by rules. */
  approvalIntent: boolean;
  /** Which trigger fired, for display and debugging. */
  trigger: "figure-word" | "measurement" | "visual-first" | "none";
  tokens: string[];
  /** Distinctive tokens, used for coverage scoring. */
  contentTokens: string[];
  /** Normalized measurements in the question ("1in"), for table row-key matching. */
  measures: string[];
};

export const analyzeQuery = (question: string, visualFirst = false): QueryIntent => {
  const lowered = question.toLowerCase();
  // Corrected words: the coverage gate reads what the user meant, not the
  // typo. The denominator stays on corrected own-words — aliases only ever
  // add numerator hits, never denominator terms.
  const contentTokens = correctedFtsTokens(question);
  const tokens = tokenize(question);
  const approvalIntent = APPROVAL_PATTERN.test(question);

  const measures = extractMeasurements(question).map(measureKey);
  const figureWord = FIGURE_WORDS.find((w) => lowered.includes(w));
  if (figureWord) {
    return { visualIntent: true, approvalIntent, trigger: "figure-word", tokens, contentTokens, measures };
  }
  if (UNIT_TAIL.test(lowered)) {
    return { visualIntent: true, approvalIntent, trigger: "measurement", tokens, contentTokens, measures };
  }
  if (visualFirst) {
    return { visualIntent: true, approvalIntent, trigger: "visual-first", tokens, contentTokens, measures };
  }
  return { visualIntent: false, approvalIntent, trigger: "none", tokens, contentTokens, measures };
};

/**
 * ESR-domain synonyms live in lexicon-data.ts (data, not code). Imported
 * here for scoring; a new synonym is a data edit in that file.
 */

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
  // Same shorthand expansion as the question side, so "3'-0"" in a chunk
  // meets "2 feet" in a question on the shared token "feet".
  const haystack = new Set(tokenizeWithSymbols(expandShorthand(chunkText)));
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
/** Boost for a normative rule with a number, on approval questions only. */
const PRIOR_RULE = 0.08;
/**
 * Boost for a table sharing an exact measurement with the question.
 *
 * Lookup questions name the row key ("how many guys on a 1-inch anchor" wants
 * the `1"` row of Table 11), and dense worked-example prose otherwise buries
 * the table: short example chunks outrank a 200-cell table on BM25 density
 * every time. An exact measurement match is stronger than the type priors
 * because it is specific to this question, not this kind of question — and it
 * uses the same no-conversion key discipline as the answer verifier, so "1 in"
 * meets `1"` but never meets a 12 in row.
 */
const PRIOR_MEASURE_MATCH = 0.10;

/**
 * No manual affinity known — used where a chunk is placed by its relationship
 * to another (a legend beside its table) rather than chosen on its own merits.
 * Absent a prior, no discount applies.
 */
const NO_MANUAL_PRIOR = new Map<string, number>();

/** Approval-seeking phrasing: the answer is a permission, not a value. */
const APPROVAL_PATTERN =
  /\bapprov|\ballowed\b|\bpermitted\b|\bcan i\b|\bmay i\b|\bacceptable\b|\bapproved\b/i;

/** Normative language plus a measurement — a rule that settles permission. */
const RULE_PATTERN =
  /\b(shall not|must not|shall|must|required|minimum|prohibited)\b/i;
// Digits or spelled-out numbers: spec prose writes "three feet" as often as
// "3 feet", and the rule test must see both.
const RULE_MEASURE_PATTERN =
  /(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s*(inches|inch|feet|foot|volts|volt|amps|ampere|amperes|amp|percent|pct|%|in\b|ft\b|["'′″])/i;

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

/**
 * Multiplier applied to a chunk in a manual the question is not about.
 *
 * Soft, not a filter: a question that genuinely spans manuals still gets its
 * evidence, it just has to earn it. A hard filter would break the questions
 * that legitimately need two.
 */
const MANUAL_DISCOUNT = 0.55;

/** A manual needs at least this share of the best manual's hits to be "in play". */
const MANUAL_IN_PLAY = 0.45;

const scoreChunk = (
  chunk: StoredChunk,
  intent: QueryIntent,
  bm25ById: Map<string, number>,
  manualPrior: Map<string, number>
): Scored => {
  // Coverage reads the section heading together with the text. A chunk's
  // heading is part of its meaning — citations already display it for exactly
  // this reason — and table chunks are systematically stripped of context at
  // ingest (the EUSERC table's text starts at "--- | --- | ---", with neither
  // its title nor the word EUSERC). Scoring the body alone makes a table
  // cover one token in three while sitting at the top of the ranking, which
  // fails the coverage gate on a question the corpus answers.
  const coverage = coverageOf(
    `${chunk.section ?? ""}\n${chunk.text}`,
    intent.contentTokens,
  );
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
  // Permission questions are answered by rules, not by topic matches: an
  // "Options" chunk can outrank the setback rule on BM25 density while saying
  // nothing about permission. A chunk that states a normative rule WITH a
  // measurement ("shall not … less than three feet") is the shape an approval
  // answer takes, so it ranks as one — same weight as the figure prior.
  if (intent.approvalIntent && RULE_PATTERN.test(chunk.text) && RULE_MEASURE_PATTERN.test(chunk.text)) {
    score += PRIOR_RULE;
  }
  if (chunk.evidenceType === "table" && intent.measures.length > 0) {
    const chunkKeys = new Set(extractMeasurements(chunk.text).map(measureKey));
    if (intent.measures.some((m) => chunkKeys.has(m))) {
      score += PRIOR_MEASURE_MATCH;
    }
  }
  score += sectionMatchScore(chunk.section, intent.contentTokens);

  // Manual prior, applied last so it discounts a whole manual rather than one
  // term of it. `confidence` is deliberately untouched: the notCovered gate is
  // about whether the corpus says anything, and a discount is a statement about
  // *which* corpus, not about coverage.
  const prior = manualPrior.get(chunk.docId);
  if (prior !== undefined && prior < MANUAL_IN_PLAY) {
    score *= MANUAL_DISCOUNT;
  }

  return { chunk, score, confidence, bm25: bm25 ?? Number.NaN, coverage };
};

export type RetrieveOptions = {
  visualFirst?: boolean;
  /**
   * Demote one manual out of play for this call only: its prior is set to 0,
   * the same soft discount `manualsNamedIn` gives a manual the question does
   * not name. Never a filter — a chunk that earns its place on score still
   * surfaces. The Phase 4 answer retry drops the manual of the first answer's
   * top-1 chunk, on the hypothesis that the first answer came from the wrong
   * corpus.
   */
  dropManual?: ManualId;
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
  const { visualFirst = false, dropManual } = options;
  const config = getAppConfig();
  const intent = analyzeQuery(question, visualFirst);
  // The corrected lexical view of the question: typo'd tokens match nothing
  // in the index, so retrieval and the manual-affinity pass both read the
  // corrected words. Re-tokenization is the identity on corrected tokens
  // (correctedFtsTokens already filtered them), so this is exactly the FTS
  // query over the corrected token list. Measures, visual triggers, and
  // named-manual detection stay on the raw question: numbers are never
  // corrected, and a named manual is an explicit constraint, not a typo.
  const correctedFtsQuery = intent.contentTokens.join(" ");

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

  const ftsHits = searchChunksFts(correctedFtsQuery, FTS_CANDIDATES);
  // Tables carrying the question's measurements join candidates on their own
  // merit: prose-length competition buries lookup tables past any rank a
  // re-scorer can reach (Table 10-45 sat at 586). Deduped below; the scorer —
  // coverage, measure prior, manual prior — still decides between them.
  const tableHits =
    intent.measures.length > 0
      ? searchTablesByMeasure(intent.measures, 40, intent.contentTokens)
      : [];
  const seenHitIds = new Set(ftsHits.map((h) => h.chunkId));
  for (const hit of tableHits) {
    if (!seenHitIds.has(hit.chunkId)) {
      seenHitIds.add(hit.chunkId);
      ftsHits.push(hit);
    }
  }
  if (ftsHits.length === 0) {
    return empty;
  }

  // Which manual is this question about? Computed from a grouped FTS pass over
  // a wider slice than the candidates use, so a manual that answers well but
  // ranks low on blended score still gets its say.
  const affinityRows = getManualAffinity(correctedFtsQuery);
  const manualPrior = new Map<string, number>();
  if (affinityRows.length > 1) {
    const best = Math.max(...affinityRows.map((r) => r.hits)) || 1;
    for (const row of affinityRows) {
      manualPrior.set(row.docId, row.hits / best);
    }
  }
  // A manual the question names by name or acronym is in play whatever the
  // lexical spread says, and every other manual is discounted from in-play to
  // out. This is the difference between "the ESR specifies" as a stated
  // constraint and as four letters the tokenizer happens to drop.
  const named = manualsNamedIn(question);
  if (named.length > 0) {
    for (const id of manualPrior.keys()) {
      manualPrior.set(id, named.includes(id as never) ? 1 : 0);
    }
  }
  // The retry's suspect manual goes out of play whatever affinity and naming
  // say — applied after the named-manual block so the drop wins over both.
  if (dropManual) {
    manualPrior.set(dropManual, 0);
  }

  const bm25ById = new Map(ftsHits.map((h) => [h.chunkId, h.bm25]));

  const chunks = getStoredChunksByIds(ftsHits.map((h) => h.chunkId));
  if (chunks.length === 0) {
    return empty;
  }

  const scored = chunks
    .map((chunk) => scoreChunk(chunk, intent, bm25ById, manualPrior))
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
    scoreChunk(chunk, intent, bm25ById, manualPrior)
  );

  const mergedBase = [...scored, ...extras]
    .sort((a, b) => b.score - a.score)
    .slice(0, config.RETRIEVAL_CANDIDATES);

  // Maximal-marginal-relevance re-ranking: a later chunk that says the same
  // thing as a higher-ranked chunk adds no new evidence, and in a top-4 slice
  // it actively displaces chunks that do. Three near-identical "panel upgrade
  // options" chunks once buried the working-space figure a setback question
  // needed. Tables are exempt — structure matters, and the table pass below
  // positions them on purpose — except glossary tables, which define terms
  // but answer nothing. Similarity is Jaccard over the chunks' own word sets,
  // NOT over matched question tokens: two chunks sharing the words "property
  // line" can state different facts (a lateral figure vs a setback rule), and
  // penalizing question-vocabulary overlap punished the rule for matching the
  // question well. λ=0.7 keeps relevance dominant.
  const MMR_LAMBDA = 0.7;
  const isGlossary = (s: (typeof mergedBase)[number]): boolean =>
    /glossar/i.test(s.chunk.section ?? "");
  const merged = (() => {
    // Word sets of the chunks themselves (with symbols, so dimensions count),
    // shared with the coverage scorer's normalization.
    const wordsById = new Map<string, Set<string>>();
    for (const s of mergedBase) {
      wordsById.set(s.chunk.id, new Set(tokenizeWithSymbols(expandShorthand(s.chunk.text))));
    }
    const remaining = [...mergedBase];
    const out: typeof mergedBase = [];
    const selected: Array<Set<string>> = [];
    while (remaining.length > 0) {
      let best = 0;
      for (let i = 1; i < remaining.length; i += 1) {
        const cand = remaining[i] as (typeof mergedBase)[number];
        const cur = remaining[best] as (typeof mergedBase)[number];
        // Max similarity to any selected chunk: a duplicate of one selected
        // chunk is redundant even when the rest of the selection differs.
        const simOf = (id: string): number => {
          const cov = wordsById.get(id) ?? new Set<string>();
          if (cov.size === 0) return 0;
          let m = 0;
          for (const s of selected) {
            if (s.size === 0) continue;
            let inter = 0;
            for (const t of cov) {
              if (s.has(t)) inter += 1;
            }
            m = Math.max(m, inter / (cov.size + s.size - inter));
          }
          return m;
        };
        const simCand =
          cand.chunk.chunkType === "table" && !isGlossary(cand) ? 0 : simOf(cand.chunk.id);
        const simCur =
          cur.chunk.chunkType === "table" && !isGlossary(cur) ? 0 : simOf(cur.chunk.id);
        if (
          MMR_LAMBDA * cand.score - (1 - MMR_LAMBDA) * simCand >
          MMR_LAMBDA * cur.score - (1 - MMR_LAMBDA) * simCur
        ) {
          best = i;
        }
      }
      const [pick] = remaining.splice(best, 1);
      const picked = pick as (typeof mergedBase)[number];
      out.push(picked);
      selected.push(wordsById.get(picked.chunk.id) ?? new Set<string>());
    }
    return out;
  })();

  // Tables travel with their key and their legend. Two retrieval gaps conspire
  // against table questions. First, the clean markdown table often loses to
  // its own OCR sibling (same words, denser BM25), and the OCR flow drops the
  // code column into unreadable order — so the model gets a table it cannot
  // read. Second, a table verdict is frequently a code ("U") defined by a
  // short text chunk on the same page ("U = Unacceptable") that the question's
  // terms never match — so the model gets a code it can only guess at.
  //
  // So each table forms one group at the position of its first appearance
  // (the table itself, or the OCR rendering that matched): the markdown
  // table, then the page's short text. A group never reorders anything above
  // its own slot; short text already above a table stays where BM25 put it.
  // Which rendering survives is decided by content, not by type: a markdown
  // table with real data rows subsumes its OCR sibling (same table, cleaner
  // reading), while a title-and-footer stub yields to the OCR flow that
  // actually carries the numbers. Either way the pair costs one context slot,
  // and legends are capped at two per group.
  const tableDataRows = (text: string): string[] =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.includes("|") &&
          !/^[|\s:=-]+$/.test(l) &&
          !/EFFECTIVE DATE/i.test(l),
      );
  const withLegends = (() => {
    const heads = (() => {
      const ids = [
        ...new Set(
          merged
            .filter((s) => s.chunk.chunkType !== "table" && s.chunk.pairGroupId)
            .map((s) => s.chunk.pairGroupId as string),
        ),
      ];
      return new Map(
        (ids.length > 0 ? getStoredChunksByIds(ids) : []).map((h) => [h.id, h]),
      );
    })();
    type Group = {
      table: StoredChunk;
      ocrId: string | null;
      slot: number;
      page: number;
    };
    const groups: Group[] = [];
    const groupedTables = new Set<string>();
    merged.forEach((s, i) => {
      let table: StoredChunk | null = null;
      let ocrId: string | null = null;
      // Glossary tables define terms; they anchor no group and attach no
      // legend. Letting one anchor once floated glossary above the setback
      // rule the question needed, and attached footnotes to a definition.
      const glossaried = (c: StoredChunk): boolean => /glossar/i.test(c.section ?? "");
      if (s.chunk.chunkType === "table" && !glossaried(s.chunk)) {
        table = s.chunk;
      } else if (s.chunk.pairGroupId) {
        const head = heads.get(s.chunk.pairGroupId);
        if (
          head &&
          head.chunkType === "table" &&
          head.id !== s.chunk.id &&
          !glossaried(head)
        ) {
          table = head;
          ocrId = s.chunk.id;
        }
      }
      if (!table || groupedTables.has(table.id)) return;
      groupedTables.add(table.id);
      groups.push({ table, ocrId, slot: i, page: table.page });
    });
    if (groups.length === 0) return merged;
    const inList = new Set(merged.map((s) => s.chunk.id));
    // OCR siblings for stub tables, fetched by pair group (one indexed query
    // per group; groups are few).
    const sibsByTable = new Map<string, StoredChunk[]>();
    for (const group of groups) {
      if (!group.table.pairGroupId) continue;
      const sibs = getChunksByPairGroup(group.table.pairGroupId).filter(
        (c) => c.id !== group.table.id && c.chunkType === "text",
      );
      if (sibs.length > 0) sibsByTable.set(group.table.id, sibs);
    }
    // Fresh short text per grouped page (legends, footnotes, titles).
    const legendLocations = [
      ...new Map(
        groups.map((g) => [`${g.table.docId}:${g.page}`, { docId: g.table.docId, page: g.page }])
      ).values(),
    ];
    const freshByPage = new Map<string, StoredChunk[]>();
    for (const legend of getShortTextChunksByPages(legendLocations)) {
      if (inList.has(legend.id)) continue;
      const key = `${legend.docId}:${legend.page}`;
      const list = freshByPage.get(key) ?? [];
      list.push(legend);
      freshByPage.set(key, list);
    }
    // Short text already in the ranking that belongs to a group moves up to
    // it — but only from below its slot.
    const movingByGroup = new Map<Group, typeof merged>();
    const movingIds = new Set<string>();
    merged.forEach((s, i) => {
      if (s.chunk.chunkType !== "text" || s.chunk.text.length > 400) return;
      const group = groups.find((g) => g.page === s.chunk.page && i > g.slot);
      if (!group || movingIds.has(s.chunk.id)) return;
      movingIds.add(s.chunk.id);
      const list = movingByGroup.get(group) ?? [];
      list.push(s);
      movingByGroup.set(group, list);
    });
    const usedLegends = new Set<string>();
    const emittedTables = new Set<string>();
    const droppedIds = new Set<string>();
    const out: typeof merged = [];
    const emitGroup = (group: Group, anchorScore: number) => {
      if (emittedTables.has(group.table.id)) return;
      emittedTables.add(group.table.id);
      const sibs = sibsByTable.get(group.table.id) ?? [];
      const substantive = tableDataRows(group.table.text).length >= 2;
      // Winner carries the numbers: the markdown when it has real rows, the
      // longest OCR flow when the markdown is a title-and-footer stub. The
      // loser is skipped at its natural position below.
      let winner: { chunk: StoredChunk; fresh: boolean } | null = null;
      if (substantive) {
        winner = { chunk: group.table, fresh: !inList.has(group.table.id) };
        for (const sib of sibs) droppedIds.add(sib.id);
        if (group.ocrId) droppedIds.add(group.ocrId);
      } else if (sibs.length > 0) {
        const best = [...sibs].sort((a, b) => b.text.length - a.text.length)[0] as StoredChunk;
        winner = { chunk: best, fresh: !inList.has(best.id) };
        droppedIds.add(group.table.id);
        for (const sib of sibs) {
          if (sib.id !== best.id) droppedIds.add(sib.id);
        }
        if (group.ocrId && group.ocrId !== best.id) droppedIds.add(group.ocrId);
      } else {
        winner = { chunk: group.table, fresh: !inList.has(group.table.id) };
      }
      // The winner is spoken for: the moving scan may also have claimed it,
      // and its natural row (if any) must not re-emit it below.
      if (winner) droppedIds.add(winner.chunk.id);
      if (winner.fresh) {
        out.push({
          ...scoreChunk(winner.chunk, intent, bm25ById, NO_MANUAL_PRIOR),
          score: anchorScore - 0.0005,
        });
      } else {
        const natural = merged.find((s) => s.chunk.id === winner.chunk.id);
        if (natural) out.push(natural);
      }
      // Definitions first: a "U = Unacceptable" line is the key, an acronym
      // expansion is not. Two legend slots per group; the top-K slice does
      // the rest. Dropped OCR siblings stay dropped even if the moving scan
      // claimed them first.
      const candidates: Array<{
        key: string;
        text: string;
        make: (score: number) => (typeof merged)[number];
      }> = [
        ...(freshByPage.get(`${group.table.docId}:${group.page}`) ?? []).map((legend) => ({
          key: legend.id,
          text: legend.text,
          make: (score: number) => ({
            ...scoreChunk(legend, intent, bm25ById, NO_MANUAL_PRIOR),
            score,
          }),
        })),
        ...(movingByGroup.get(group) ?? []).map((moved) => ({
          key: moved.chunk.id,
          text: moved.chunk.text,
          make: (score: number) => ({ ...moved, score }),
        })),
      ].filter((c) => !usedLegends.has(c.key) && !droppedIds.has(c.key));
      candidates
        .sort((a, b) => {
          const ka = a.text.includes("=") ? 0 : 1;
          const kb = b.text.includes("=") ? 0 : 1;
          return ka - kb;
        })
        .slice(0, 2)
        .forEach((c, k) => {
          usedLegends.add(c.key);
          out.push(c.make(anchorScore - 0.001 * (k + 1)));
        });
    };
    for (const s of merged) {
      if (droppedIds.has(s.chunk.id) || movingIds.has(s.chunk.id)) continue;
      const group = groups.find(
        (g) =>
          !emittedTables.has(g.table.id) &&
          (s.chunk.id === g.table.id || (g.ocrId !== null && s.chunk.id === g.ocrId)),
      );
      if (!group) {
        out.push(s);
        continue;
      }
      emitGroup(group, s.score);
    }
    return out;
  })();

  const top = withLegends[0];
  const confidence = top?.confidence ?? 0;
  const coverage = top?.coverage ?? 0;
  // Coverage of the best chunk is the gate; confidence is reported alongside it
  // but is a weaker out-of-scope signal (see NOT_COVERED_THRESHOLD).
  //
  // Multi-facet questions get a second chance: when no single chunk clears
  // the bar but the top slice jointly covers the question around a
  // substantive anchor, the corpus answers it. "Can I approve a panel upgrade
  // 2' from the property line" splits across upgrade framing (approve/panel)
  // and setback substance (feet/property/line) — no one chunk holds both, so
  // the top-1 gate failed an answerable question. The anchor floor keeps four
  // quarter-matching scraps from passing as a set.
  const gateSlice = withLegends.slice(0, config.RETRIEVAL_TOP_K);
  const jointHit = new Set<string>();
  let jointMax = 0;
  if (intent.contentTokens.length > 0) {
    const needles = [...intent.contentTokens, ...aliasTokens(intent.contentTokens)];
    for (const s of gateSlice) {
      jointMax = Math.max(jointMax, s.coverage);
      const hay = new Set(tokenizeWithSymbols(expandShorthand(s.chunk.text)));
      for (const t of needles) {
        if (hay.has(t)) jointHit.add(t);
      }
    }
  }
  const jointCoverage =
    intent.contentTokens.length > 0 ? jointHit.size / intent.contentTokens.length : 0;
  const notCovered =
    merged.length === 0 ||
    (coverage < NOT_COVERED_THRESHOLD &&
      !(jointCoverage >= 0.7 && jointMax >= 0.35));

  return {
    candidates: notCovered ? [] : withLegends.slice(0, config.RETRIEVAL_TOP_K),
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