import { getAppConfig } from "@/lib/env";
import {
  getCacheEntry,
  getAllPageFigures,
  getAssetsForChunkIds,
  getFigureEvidenceForPages,
  getVisualAssets,
  saveCacheEntry,
  searchChunksFts,
  getStoredChunksByIds,
} from "@/lib/rag/storage";
import type {
  ChatAnswer,
  FigureEvidence,
  SourceCitation,
  StoredChunk,
  StoredException,
} from "@/lib/rag/types";
import { retrieveChunks } from "@/lib/rag/retrieval";
import {
  extractMeasurements,
  measureKey,
  type VerifiedMeasurement,
} from "./measure";
import { MANUALS, evidencePageLink } from "@/lib/rag/docs";
import type { ManualId } from "@/lib/rag/docs";
import {
  askOllama,
  streamOllama,
  type ModelResult,
  type OllamaUsage,
} from "@/lib/rag/ollama";

/**
 * Shown when nothing in the ESR clears the retrieval threshold.
 *
 * It is deliberately informative rather than empty: the planner gets told what
 * was searched and what the nearest material was, and keeps the judgement. A
 * tool that answers "not covered" and hands back three candidate sections is
 * more useful than one that either guesses or says nothing.
 */
/**
 * Returned when nothing cleared the retrieval threshold.
 *
 * The UI already carries a "Not in the ESR" badge and the nearest sections in
 * the evidence rail. The answer text therefore says only the part the prose has
 * to carry: do not quote a number from this. Repeating the verdict across all
 * three surfaces turns one finding into three warnings.
 */
const NOT_COVERED_ANSWER = "Check with your supervisor before answering this one.";

/** Closest chunks for a question that returned nothing above threshold. */
const getNearestChunks = (question: string, limit: number): StoredChunk[] =>
  searchChunksFts(question, limit * 3)
    .map((hit) => hit.chunkId)
    .map((id) => getStoredChunksByIds([id])[0])
    .filter((chunk): chunk is StoredChunk => Boolean(chunk))
    .slice(0, limit);

type RetrievalChunk = {
  docId: ManualId;
  page: number;
  text: string;
  section: string | null;
  chapter?: string | null;
  pageLabel?: string | null;
  standard?: string | null;
  sheetOf?: number | null;
  sheetCount?: number | null;
  score: number;
  id: string;
};

/**
 * A page, addressed inside a manual.
 *
 * Page numbers are only unique within a manual: 20 exists in all five. Any
 * lookup that takes a bare page number and reads evidence is a latent
 * cross-manual mix-up, so the address is a pair and stays a pair.
 */
type PageLocation = { docId: ManualId; page: number };

const locationKey = (docId: string, page: number) => `${docId}:${page}`;

const locationsOf = (chunks: Array<{ docId: ManualId; page: number }>): PageLocation[] => {
  const seen = new Map<string, PageLocation>();
  for (const chunk of chunks) {
    if (Number.isFinite(chunk.page)) {
      seen.set(locationKey(chunk.docId, chunk.page), {
        docId: chunk.docId,
        page: chunk.page,
      });
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.docId.localeCompare(b.docId) || a.page - b.page
  );
};

type ParsedModelResponse = {
  answer?: string;
  directAnswer?: string;
  citations?: Array<{ chunkIndex?: number; quote?: string; reason?: string; type?: string }>;
  figures?: Array<{ chunkIndex?: number }>;
};

const MAX_PROMPT_CHUNKS = 4;
const PROMPT_SNIPPET_LEN = 650;
const MAX_ANSWER_PARAGRAPHS = 1;
const MAX_ANSWER_WORDS = 88;
const MAX_DIRECT_ANSWER_WORDS = 32;

const sanitize = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * Personal pronouns are never self-contained: "it" in "what kind of panels
 * need it then?" means whatever the previous turn established, and searching
 * it literally retrieves whatever matches the dangling words (here, handles
 * on hinged panels instead of test bypass blocks). Demonstratives
 * (this/that/those) are left out deliberately — relative-pronoun "that" in
 * "the rule that governs panels" would false-trigger on self-contained
 * questions, and genuinely demonstrative questions are short enough for the
 * word rule below.
 */
const ANAPHORA = /\b(it|they|them|he|she|him|her|its|their|theirs)\b/i;

const buildRetrievalQuery = (question: string, conversationPrefix: string): string => {
  const words = question.trim().split(/\s+/).filter(Boolean);
  const prefix = conversationPrefix.trim();
  if (!prefix || (words.length >= 6 && !ANAPHORA.test(question))) {
    return question;
  }
  // Resolve against the tail: the last user turn plus the last assistant
  // answer, which is where the referent ("test bypass blocks") lives. User
  // lines alone are not enough — the answer often holds the entity.
  const lines = [...prefix.matchAll(/^(?:User|Assistant):\s*(.+)$/gim)].map((m) =>
    m[1].trim()
  );
  const tail = lines.slice(-3).join(" ");
  const merged = `${tail} ${question}`.trim();
  return merged.slice(0, 1200);
};

const compactWords = (value: string, maxWords: number) => {
  const normalized = sanitize(value);
  if (!normalized) {
    return "";
  }

  const words = normalized.split(" ");
  if (words.length <= maxWords) {
    return normalized;
  }

  return `${words.slice(0, maxWords).join(" ")}...`;
};

const hasQuestionDistanceIntent = (question: string) => {
  const value = question.toLowerCase();
  return /clearance|distance|inches|inch|feet|foot|\bft\b|'|′|how far|line side|load side|pad\s*-?mount|working space|in front|behind|rear|radial|sides?/.test(
    value
  );
};

const sentenceCandidates = (value: string) => {
  const matches = value.match(/[^.!?]+[.!?]*/g) ?? [];
  const sentences = matches.map((sentence) => sentence.trim()).filter(Boolean);
  if (sentences.length === 0) {
    return [sanitize(value)];
  }
  return sentences;
};

const quoteMeasurementMatch = (value: string) =>
  value.match(/\d+(?:\.\d+)?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?)?\s*(?:inches|inch|in\.)/i) ??
  value.match(/\d+(?:\.\d+)?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?)?\s*"/) ??
  value.match(/\b\d+(?:\.\d+)?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?)?\s*(?:ft|feet|foot)\b/i) ??
  value.match(/\b\d+(?:\.\d+)?'/) ??
  value.match(/\b\d+(?:\.\d+)?′/);

const quoteHasMeasurement = (value: string) => Boolean(quoteMeasurementMatch(value));

const detectClearanceFacetHints = (combined: string): Set<string> => {
  const t = combined.toLowerCase();
  const out = new Set<string>();
  if (/pad\s*-?mount|pad mount|pad-mounted|transformer|equipment\s+pad/.test(t)) {
    out.add("pad");
  }
  if (/in front of|front of|^\s*front |face of|working space|clear working space/.test(t)) {
    out.add("front");
  }
  if (/\brear\b|behind|back of|\bradial\b/.test(t)) {
    out.add("rear");
  }
  if (/each side|both sides|side clearance|laterally|sides?\s+of/.test(t)) {
    out.add("side");
  }
  if (/line side/.test(t)) {
    out.add("lineSide");
  }
  if (/load side/.test(t)) {
    out.add("loadSide");
  }
  return out;
};

const facetAlignmentScore = (sentence: string, facets: Set<string>): number => {
  if (facets.size === 0) {
    return 0;
  }
  const s = sentence.toLowerCase();
  let score = 0;
  if (facets.has("front") && /front|working space|face of|in front/.test(s)) {
    score += 4;
  }
  if (facets.has("rear") && /rear|behind|back of|radial/.test(s)) {
    score += 4;
  }
  if (facets.has("side") && /side|lateral|each side|both sides/.test(s)) {
    score += 3;
  }
  if (facets.has("lineSide") && /line side/.test(s)) {
    score += 4;
  }
  if (facets.has("loadSide") && /load side/.test(s)) {
    score += 4;
  }
  if (facets.has("pad") && /pad|transformer|padmount|pad-mounted/.test(s)) {
    score += 2;
  }
  return score;
};

const bestCitationSentenceForFacets = (
  citations: SourceCitation[],
  question: string,
  conversationPrefix: string
): string | null => {
  const combined = `${conversationPrefix}\n${question}`;
  const facets = detectClearanceFacetHints(combined);
  let best: { sentence: string; score: number; hasMeasure: boolean } | null = null;
  for (const citation of citations) {
    for (const sentence of sentenceCandidates(citation.quote)) {
      const fScore = facetAlignmentScore(sentence, facets);
      const hasMeasure = quoteHasMeasurement(sentence);
      const rank = fScore * 20 + (hasMeasure ? 10 : 0);
      if (
        !best ||
        rank > best.score ||
        (rank === best.score && hasMeasure && !best.hasMeasure)
      ) {
        best = { sentence, score: rank, hasMeasure };
      }
    }
  }
  if (!best?.hasMeasure) {
    return null;
  }
  if (facets.size > 0 && facetAlignmentScore(best.sentence, facets) === 0) {
    return null;
  }
  return best.sentence;
};

const extractQuestionedDirectSentence = (value: string, question: string) => {
  const normalized = sanitize(value);
  const lowerQuestion = question.toLowerCase();
  const questionTokens = [
    "line side",
    "load side",
    "clearance",
    "panel",
    "meter",
    "distance",
    "inch",
    "foot",
    "feet",
    "ft",
    "padmount",
    "pad mount",
    "working space",
    "front",
    "rear",
  ];
  const hasToken = (sentence: string) =>
    questionTokens.some((token) => sentence.toLowerCase().includes(token));

  const sentences = sentenceCandidates(normalized);
  const prioritized = sentences.find((sentence) => hasToken(sentence) && quoteHasMeasurement(sentence));
  if (prioritized) {
    return prioritized;
  }

  if (lowerQuestion.includes("line side")) {
    const lineSide = sentences.find(
      (sentence) => sentence.toLowerCase().includes("line side") && quoteHasMeasurement(sentence),
    );
    if (lineSide) {
      return lineSide;
    }
  }

  return sentences.find((sentence) => quoteHasMeasurement(sentence));
};

const extractMeasurementAroundKeyword = (value: string, keyword: string) => {
  const match = value.match(new RegExp(`.{0,120}${keyword}.{0,120}`, "i"));
  if (!match) {
    return null;
  }
  const hit = quoteMeasurementMatch(match[0]);
  return hit?.[0] ?? null;
};

const isModelDirectAnswerUseful = (value: string) => {
  const normalized = sanitize(value).toLowerCase();
  if (!normalized || normalized === "no direct answer.") {
    return false;
  }
  if (normalized.startsWith("figure")) {
    return false;
  }
  return true;
};

const deriveDirectAnswer = (
  question: string,
  modelDirectAnswer: string,
  citations: SourceCitation[],
  conversationPrefix = ""
) => {
  const compactModel = compactToSentences(modelDirectAnswer, 1, MAX_DIRECT_ANSWER_WORDS);
  const combinedQ = `${conversationPrefix}\n${question}`;
  if (!hasQuestionDistanceIntent(question) && !hasQuestionDistanceIntent(conversationPrefix)) {
    return compactModel;
  }

  if (isModelDirectAnswerUseful(modelDirectAnswer) && quoteHasMeasurement(modelDirectAnswer)) {
    const qFacets = detectClearanceFacetHints(combinedQ);
    const modelSan = sanitize(modelDirectAnswer);
    if (qFacets.size === 0 || facetAlignmentScore(modelSan, qFacets) > 0) {
      return compactModel;
    }
  }

  const oriented = bestCitationSentenceForFacets(citations, question, conversationPrefix);
  if (oriented) {
    return compactToSentences(oriented, 1, MAX_DIRECT_ANSWER_WORDS);
  }

  const lowerQuestion = question.toLowerCase();
  if (lowerQuestion.includes("line side")) {
    for (const citation of citations) {
      const lineSideChunk = extractQuestionedDirectSentence(citation.quote, question);
      const measurement = extractMeasurementAroundKeyword(citation.quote, "line side");
      if (measurement) {
        return compactToSentences(
          `Line-side clearance reference: ${measurement} ${lineSideChunk ? "mentioned in ESR guidance." : ""}`,
          1,
          MAX_DIRECT_ANSWER_WORDS,
        );
      }
    }

    const fallbackLineSideMeasurement = citations.find((citation) =>
      citation.quote.toLowerCase().includes("line side")
    );
    if (fallbackLineSideMeasurement) {
      const measurement = extractMeasurementAroundKeyword(fallbackLineSideMeasurement.quote, "line side");
      if (measurement) {
        return compactToSentences(
          `Line-side clearance appears to be at least ${measurement}.`,
          1,
          MAX_DIRECT_ANSWER_WORDS,
        );
      }
    }

    return compactToSentences(
      "No clear line-side clearance figure was returned in top retrieval snippets.",
      1,
      MAX_DIRECT_ANSWER_WORDS,
    );
  }

  for (const citation of citations) {
    const sentence = extractQuestionedDirectSentence(citation.quote, question);
    if (sentence && quoteHasMeasurement(sentence)) {
      return compactToSentences(sentence, 1, MAX_DIRECT_ANSWER_WORDS);
    }
  }

  return compactModel;
};

const compactToSentences = (value: string, maxSentences: number, maxWords: number) => {
  const normalized = sanitize(value);
  if (!normalized) {
    return "";
  }

  // Split only on terminal punctuation followed by whitespace, so a decimal
  // value ("12.5 mG", "0.600 V") is not truncated at the point.
  const sentences =
    normalized
      .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
      .map((sentence) => sentence.trim())
      .filter(Boolean) ?? [];
  const compact = sentences.length > 0 ? sentences.slice(0, maxSentences).join(" ") : normalized;
  return compactWords(compact, maxWords);
};

/**
 * Resolve a candidate quote to a real span of the source chunk.
 *
 * Matching is whitespace-insensitive: `sanitize` collapses the quote's
 * newlines but the source keeps them, so a raw `indexOf` fails for every
 * multi-line chunk (most of them) and produced zero citations for correct
 * answers. We walk both strings, skipping whitespace runs in the source, and
 * record where the needle actually landed so the UI can highlight the true
 * span.
 *
 * Returns null when the quote is not substantially present. An unverifiable
 * citation is worse than none: it looks like evidence.
 */
const resolveQuote = (
  source: string,
  quote: string
): { text: string; start: number; end: number } | null => {
  const needle = sanitize(quote).toLowerCase();
  if (needle.length < 8) {
    return null;
  }

  const hay = source.toLowerCase();
  let si = 0;
  let first = -1;
  let last = -1;
  let matched = 0;
  for (let i = 0; i < needle.length; i += 1) {
    const target = needle[i];
    while (si < hay.length && hay[si] !== target && /\s/.test(hay[si]!)) si += 1;
    if (si >= hay.length) break;
    if (hay[si] === target) {
      if (first < 0) first = si;
      last = si;
      matched += 1;
      si += 1;
    } else if (!/\s/.test(target)) {
      break;
    }
  }
  if (matched < Math.min(needle.length, Math.max(6, Math.floor(needle.length * 0.7))) || first < 0) {
    return null;
  }
  return { text: source.slice(first, last + 1).trim(), start: first, end: last + 1 };
};

/**
 * Choose the span of a chunk to cite.
 *
 * The model's own quote is unreliable for this corpus: measured on the ESR it
 * paraphrased or invented the span it claimed to be quoting (answering "30.5"
 * and citing that invented sentence), so validation rejected it and the answer
 * shipped with zero citations. The citation must therefore be derived from the
 * chunk, not trusted from the model.
 *
 * Order:
 *  1. a line containing a measurement, when the question asks about a value
 *  2. the model's quote, if it resolves
 *  3. the chunk's first substantial sentence
 */
const MEASUREMENT_LINE =
  /\d+(?:\.\d+)?\s*(?:percent|%|ft|feet|foot|in\b|inches|inch|v\b|volt|volts|a\b|amp|amps|amperes|mg\b|kv\b|kva\b|ohm|ohms|hz|days?|months?|years?|hours?)/i;

/** A line that pairs a number with a unit, i.e. one that could answer "how much". */
const hasValue = (line: string) => MEASUREMENT_LINE.test(line);

/**
 * Choose the span of a chunk to cite.
 *
 * The model's own quote is unreliable for this corpus: measured on the ESR it
 * paraphrased or invented the span it claimed to be quoting (answering "30.5"
 * and citing that invented sentence), so validation rejected it and the answer
 * shipped with zero citations. The citation must therefore be derived from the
 * chunk, not trusted from the model.
 *
 * Order:
 *  1. a line that actually carries a value (number + unit). OCR of a diagram
 *     puts the label on one line and the value on the next ("Moving meter panel
 *     3 feet will reduce EMF" / "approximately 87 percent"), so a line whose
 *     only number is part of the label prose is skipped in favour of one whose
 *     number is the answer.
 *  2. the line that best overlaps the question's distinctive words
 *  3. the chunk's first substantial line
 */
const pickCitationSpan = (chunkText: string, question: string): string => {
  const lines = chunkText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12);

  if (lines.length === 0) {
    return chunkText;
  }

  // Prefer a line that reads like an answer: number immediately followed by a
  // unit, optionally preceded by a comparative phrase.
  const valueLines = lines.filter(hasValue);
  const questionWords = new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4)
  );
  const overlapOf = (line: string) => {
    const words = line.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    return words.filter((w) => questionWords.has(w)).length;
  };

  const wantsMeasurement = /\d/.test(question) || /how (?:much|many|long|far|tall|wide)/i.test(question);
  const pool = wantsMeasurement && valueLines.length > 0 ? valueLines : lines;

  // Unit-aware tie-break. The ESR writes "MAX B = 96 mG" while the question
  // says "maximum magnetic field reading in milligauss", so a plain word
  // overlap scores that line at zero and picks the caption instead. If the
  // question names a unit, prefer the line that actually carries it.
  const unitNeedles = (
    question.match(
      /\b(?:milligauss?|gauss|percent|feet|ft|inches|inch|volts?|amps?|amperes|kva|kw|ohms?|hz|days?|months?|years?|hours?)\b/gi
    ) ?? []
  ).map((u) => u.toLowerCase());

  const symbolEquivalent = (line: string): boolean => {
    const low = line.toLowerCase();
    return (
      (/\bmg\b|gauss/.test(low) && unitNeedles.some((u) => /mg|gauss/.test(u))) ||
      (/\b(?:ft|feet|foot)\b/.test(low) && unitNeedles.some((u) => /ft|feet|foot/.test(u))) ||
      (/\b(?:in|inch|inches)\b/.test(low) && unitNeedles.some((u) => /^in/.test(u))) ||
      (/\b(?:percent|%)\b/.test(low) && unitNeedles.some((u) => /percent/.test(u)))
    );
  };

  const best = [...pool]
    .map((line) => ({ line, unit: symbolEquivalent(line) ? 1 : 0, overlap: overlapOf(line) }))
    .sort((a, b) => b.unit - a.unit || b.overlap - a.overlap)[0];

  const chosen = best && (best.unit > 0 || best.overlap > 0) ? best.line : pool[0];
  if (!chosen) {
    return chunkText;
  }

  // Prefix the section heading so the citation carries its context, which is
  // what a planner needs to judge whether it applies to their case.
  const heading = lines[0];
  if (heading && heading !== chosen && !chosen.includes(heading) && chosen.length >= 12) {
    return `${heading} — ${chosen}`;
  }
  return chosen;
};

/**
 * Build a citation that a reader can check.
 *
 * The quoted span is extracted from the chunk and then verified to occur in it,
 * so every served citation resolves to a real character span. Model-supplied
 * quotes are used only when they verify; an unverifiable one is dropped.
 */
const buildCitation = (
  quote: string | undefined | null,
  chunk: {
    docId: ManualId;
    page: number;
    text: string;
    section?: string | null;
    chapter?: string | null;
    pageLabel?: string | null;
    standard?: string | null;
    sheetOf?: number | null;
    sheetCount?: number | null;
  },
  question?: string
): SourceCitation | null => {
  const source = chunk.text ?? "";
  if (!source) {
    return null;
  }

  const fromQuestion = question ? pickCitationSpan(source, question) : null;
  const resolved =
    (fromQuestion ? resolveQuote(source, fromQuestion) : null) ??
    resolveQuote(source, quote ?? "") ??
    resolveQuote(source, source);
  if (!resolved) {
    return null;
  }
  return {
    docId: chunk.docId,
    page: chunk.page,
    quote: sanitize(resolved.text),
    section: chunk.section ?? null,
    chapter: chunk.chapter ?? null,
    pageLabel: chunk.pageLabel ?? null,
    standard: chunk.standard ?? null,
    sheetOf: chunk.sheetOf ?? null,
    sheetCount: chunk.sheetCount ?? null,
    sourceLink: evidencePageLink(chunk.docId, chunk.page),
    quoteStart: resolved.start,
    quoteEnd: resolved.end,
  };
};

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("LLM request timeout")), timeoutMs);
  });
  return Promise.race([promise, timeout]) as Promise<T>;
};

const retryAsync = async <T>(fn: () => Promise<T>, attempts = 2): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (attempts <= 0) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return retryAsync(fn, attempts - 1);
  }
};

const mergeFigureLists = (primary: FigureEvidence[], extra: FigureEvidence[]) => {
  const seen = new Set(primary.map((f) => f.id));
  const out = [...primary];
  for (const fig of extra) {
    if (!seen.has(fig.id)) {
      out.push(fig);
      seen.add(fig.id);
    }
  }
  return out;
};

/**
 * Guarantee a viewer for every cited page, even when nothing was catalogued on
 * it. The page render is the evidence; a crop is a convenience on top of it.
 */
const ensurePagePreviewFigures = (
  figures: FigureEvidence[],
  locations: PageLocation[]
): FigureEvidence[] => {
  const covered = new Set(figures.map((f) => locationKey(f.docId, f.page)));
  const seenIds = new Set(figures.map((f) => f.id));
  const out = [...figures];
  for (const location of locations) {
    const key = locationKey(location.docId, location.page);
    if (!Number.isFinite(location.page) || covered.has(key)) {
      continue;
    }
    const id = `page-preview-${key}`;
    if (seenIds.has(id)) {
      continue;
    }
    covered.add(key);
    seenIds.add(id);
    out.push({
      id,
      docId: location.docId,
      page: location.page,
      caption: `${MANUALS[location.docId].code} page ${location.page}`,
      sourceLink: evidencePageLink(location.docId, location.page),
      chapter: null,
      // Must match what evidence.py ships. It used to say .png here; the
      // optimizer converts every shipped image to lossless .webp and deletes
      // the PNG, so this pointed at a file that does not exist.
      figureUrl: `/evidence/${location.docId}/page-${location.page}.webp`,
      ocrText: null,
    });
  }
  return out;
};

const finalizeFigures = (
  figures: FigureEvidence[],
  quoteSet: RetrievalChunk[]
): FigureEvidence[] => ensurePagePreviewFigures(figures, locationsOf(quoteSet));

const fallbackFigureEvidence = (quoteSet: RetrievalChunk[], pageFigures: FigureEvidence[]) => {
  const byPage = new Map<string, FigureEvidence>();
  for (const figure of pageFigures) {
    const key = locationKey(figure.docId, figure.page);
    if (!byPage.has(key)) {
      byPage.set(key, figure);
    }
  }

  const selected: FigureEvidence[] = [];
  for (const chunk of quoteSet) {
    const match = byPage.get(locationKey(chunk.docId, chunk.page));
    if (match) {
      selected.push(match);
      break;
    }
  }
  return selected;
};

const EXCEPTION_CUE =
  /\b(except(?:ion)?s?|shall not|must not|prohibited|provided that|unless|note[:\s])/i;

const dedupeExceptions = (items: StoredException[]): StoredException[] => {
  const seen = new Set<string>();
  const out: StoredException[] = [];
  for (const item of items) {
    const text = sanitize(item.text);
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      text,
      ...(typeof item.page === "number" ? { page: item.page } : {}),
      ...(item.sourceLink ? { sourceLink: item.sourceLink } : {}),
    });
  }
  return out;
};

/** Temporary bridge when visual_assets has no exceptions yet — citation quote heuristics only. */
const heuristicExceptionsFromCitations = (citations: SourceCitation[]): StoredException[] => {
  const out: StoredException[] = [];
  for (const citation of citations) {
    for (const sentence of sentenceCandidates(citation.quote)) {
      if (EXCEPTION_CUE.test(sentence)) {
        out.push({
          text: sentence,
          page: citation.page,
          sourceLink: citation.sourceLink,
        });
      }
    }
  }
  return dedupeExceptions(out).slice(0, 6);
};

const collectStoredExceptions = (
  chunkIds: string[],
  citations: SourceCitation[]
): StoredException[] => {
  let assets: ReturnType<typeof getAssetsForChunkIds> = [];
  try {
    assets = getAssetsForChunkIds(chunkIds);
    if (assets.length === 0) {
      // Broader fallback: any assets on citation pages (pre-re-ingest empty registry).
      const pages = new Set(citations.map((c) => c.page));
      assets = getVisualAssets().filter((a) => pages.has(a.page));
    }
  } catch {
    assets = [];
  }

  const fromAssets = dedupeExceptions(
    assets.flatMap((asset) =>
      (asset.exceptions ?? []).map((ex) => ({
        text: ex.text,
        page: ex.page ?? asset.page,
        sourceLink: ex.sourceLink ?? asset.sourceLink,
      }))
    )
  );

  if (fromAssets.length > 0 || assets.length > 0) {
    // Prefer store path even when empty — do not invent via heuristic when registry exists.
    return fromAssets;
  }

  return heuristicExceptionsFromCitations(citations);
};

const fallbackAnswer = (
  question: string,
  citations: SourceCitation[],
  text: string[],
  allFigures: FigureEvidence[],
  quoteSet: RetrievalChunk[],
  exceptions: StoredException[] = []
): ChatAnswer => {
  const base = text.find(Boolean) ?? "";
  const lower = question.toLowerCase();
  let directMatch: string | null = null;
  if (/inch|in\./.test(lower)) {
    directMatch = base.match(/\b\d+(?:\.\d+)?\s*(?:inches|inch|in\.)\b/i)?.[0] ?? null;
  }
  if (!directMatch && /foot|feet|\bft\b|'|′/.test(lower)) {
    directMatch =
      base.match(/\b\d+(?:\.\d+)?(?:\s*(?:ft|feet|foot)|')\b/i)?.[0] ??
      base.match(/\b\d+(?:\.\d+)?′/)?.[0] ??
      null;
  }
  if (!directMatch) {
    directMatch = quoteMeasurementMatch(base)?.[0] ?? null;
  }

  const answer = citations.length > 0 ? base : "I did not find a confident answer in the indexed ESR data.";

  return {
    answer: compactToSentences(answer, MAX_ANSWER_PARAGRAPHS, MAX_ANSWER_WORDS),
    // No summary when nothing was found: the notice below the card already says
    // it, and repeating it as a headline makes one finding look like two.
    directAnswer: citations.length === 0 ? "" : compactWords(directMatch ?? (citations[0]?.quote ?? "No exact value extracted."), MAX_DIRECT_ANSWER_WORDS),
    citations,
    figures: fallbackFigureEvidence(quoteSet, allFigures),
    exceptions,
    grounding: citations.length > 0 ? "esr" : "none",
    notCovered: citations.length === 0,
    retrievalSummary: {
      totalCandidates: text.length,
      matchedChunks: text.length,
      confidence: 0.65,
      coverage: 0.65,
      notCovered: citations.length === 0,
      intent: "none",
      chapters: [...new Set(quoteSet.map((c) => c.chapter).filter(Boolean))] as string[],
      docs: [...new Set(quoteSet.map((c) => c.docId))],
      latencyMs: 0,
    },
  };
};

type TableVerdict = {
  token: string;
  code: string;
  meaning: string;
  rowText: string;
  legendLine: string;
  table: RetrievalChunk;
  legend: RetrievalChunk;
};

/** Units the answer verifier understands, normalized so "2.5 feet" meets
 *  "2.5 ft" but never meets "30 in" — cross-unit conversion would bless a
 *  riser dimension as a panel setback. Shared with retrieval scoring via
 *  ./measure (pipeline already imports retrieval — the reverse would cycle). */

/**
 * A requirement stated under a condition must be answered under that
 * condition. "All joint pole attachments shall be designed to Grade A" became
 * "Must analyze with Grade A construction" for an Edison-only pole — "joint →
 * A" promoted to "all → A" — because nothing checked the promotion. Prompts
 * alone do not hold this; the model had the conditional rule in context and
 * flattened it anyway.
 *
 * Trigger, all three required (every guard errs toward not triggering):
 *  1. a cited quote states a requirement under a stated condition,
 *  2. the answer states that requirement with none of the condition words,
 *  3. the answer claims the requirement (must/required/shall), not merely
 *     mentions the topic.
 * Repair follows the numbers verifier's shape: the lying headline goes, and
 * the conditional sentence from the quotes becomes the headline, because a
 * true quoted headline beats a dropped one. ok:false caps grounding at
 * partial either way.
 */
const CONDITION_MARKERS = [
  // "joint" only as shared-use language ("joint use", "joint pole"), never
  // bare: a "Joint Sidewalk Anchor" is a shared anchor, not a condition, and
  // the bare word fired a bogus caveat on exactly that.
  "joint use",
  "joint pole",
  "jointly",
  "joint attachment",
  "unless",
  "except",
  "heavy loading",
  "highway",
  "limited access",
];

const REQUIREMENT_CLAIM = /\b(must|required|require|requires|shall be|needs to|has to)\b/i;

const conditionalSentence = (
  citations: SourceCitation[],
  conditionWords: string[],
): string | null => {
  for (const citation of citations) {
    const quote = citation.quote ?? "";
    const sentences = quote.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      const hasCondition = conditionWords.some((w) => lower.includes(w));
      const hasRequirement =
        REQUIREMENT_CLAIM.test(sentence) || /grade [ab]\b/i.test(sentence);
      if (hasCondition && hasRequirement && sentence.length > 20) {
        return sentence.trim();
      }
    }
  }
  return null;
};

const verifyConditionalFidelity = (
  answer: string,
  directAnswer: string,
  citations: SourceCitation[],
): { answer: string; directAnswer: string; ok: boolean } => {
  const quotes = citations.map((c) => c.quote ?? "").join("\n");
  if (!quotes.trim()) return { answer, directAnswer, ok: true };
  const quoteLower = quotes.toLowerCase();

  const conditionWords = CONDITION_MARKERS.filter((w) => quoteLower.includes(w));
  if (conditionWords.length === 0) return { answer, directAnswer, ok: true };

  const answerText = `${answer} ${directAnswer}`.toLowerCase();
  if (conditionWords.some((w) => answerText.includes(w))) {
    return { answer, directAnswer, ok: true };
  }
  if (!REQUIREMENT_CLAIM.test(answerText)) {
    return { answer, directAnswer, ok: true };
  }

  // Flattening detected: the quotes condition the requirement and the answer
  // claims it without the condition.
  const trueHeadline = conditionalSentence(citations, conditionWords);
  const caveat =
    `Per the cited passage this requirement applies under a stated condition ` +
    `(${conditionWords.join(", ")}), which the answer above drops — check the page.`;
  return {
    answer: `${answer} ${caveat}`,
    directAnswer: trueHeadline ?? "",
    ok: false,
  };
};


/**
 * Every measurement in the answer must appear in a cited quote — same number,
 * same unit, no cross-unit conversion. A "2.5 feet" backed only by a "30 in"
 * riser dimension is exactly the fabrication this guards: numerically related
 * is not cited. Numbers already present in the question are exempt (restating
 * the ask is not a claim), and unparseable values never flag.
 */
const verifyAnswerNumbers = (
  question: string,
  answer: string,
  directAnswer: string,
  citations: SourceCitation[],
): { answer: string; directAnswer: string; ok: boolean } => {
  const asked = new Set(extractMeasurements(question).map(measureKey));
  const quoted = new Set(
    citations.flatMap((c) => extractMeasurements(c.quote ?? "").map(measureKey)),
  );
  const supported = (text: string): boolean =>
    extractMeasurements(text).every((m) => {
      const key = measureKey(m);
      return asked.has(key) || quoted.has(key);
    });
  const headlineOk = supported(directAnswer);
  const proseOk = supported(answer);
  if (headlineOk && proseOk) return { answer, directAnswer, ok: true };
  const caveat =
    "Not every number above is stated in the cited passages — verify against the page.";
  return {
    answer: proseOk ? answer : `${answer} ${caveat}`,
    // A headline number with no quote behind it is the lie by position: it is
    // what the planner reads first. Drop it rather than soften it.
    directAnswer: headlineOk ? directAnswer : "",
    ok: false,
  };
};

/**
 * Deterministic reading of a coded table cell, for questions that name the
 * row key outright ("is 301A approved?"). A small model misreads long
 * markdown tables — it attached row 1's `A` to `301A` while quoting the row
 * that says `U` — so when the row and its legend are both in context, the
 * lookup does not go through the model at all. Every guard errs toward not
 * triggering: exactly one matching row, exactly one single-letter code cell
 * in it, and a `CODE = meaning` legend line in context. Anything ambiguous
 * falls through to the model.
 */
const resolveTableCode = (question: string, chunks: RetrievalChunk[]): TableVerdict | null => {
  // Row keys look like 301A or 304: uppercase alphanumeric runs with at least
  // one digit. Plain words (GAS, PANEL) are never row keys.
  const tokens = [
    ...new Set(question.toUpperCase().match(/\b[A-Z0-9]{3,}\b/g) ?? []),
  ].filter((t) => /[0-9]/.test(t));
  if (tokens.length === 0) return null;
  type RowHit = { chunk: RetrievalChunk; rowText: string; code: string };
  const hits: RowHit[] = [];
  for (const token of tokens) {
    const word = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const chunk of chunks) {
      if (!chunk.text.includes("|")) continue;
      for (const line of chunk.text.split("\n")) {
        if (!line.includes("|") || !word.test(line)) continue;
        const codes = line
          .split("|")
          .map((c) => c.trim())
          .filter((c) => /^[A-Z]$/.test(c));
        if (codes.length !== 1) continue;
        hits.push({ chunk, rowText: line.trim(), code: codes[0] as string });
      }
    }
    if (hits.length === 1) break;
    if (hits.length > 1) return null;
  }
  if (hits.length !== 1) return null;
  const hit = hits[0] as RowHit;
  const legendPattern = new RegExp(`(^|[\\s(])${hit.code}\\s*=\\s*([^;.\\n]+)`);
  for (const chunk of chunks) {
    const match = legendPattern.exec(chunk.text);
    if (!match) continue;
    const line = chunk.text
      .split("\n")
      .find((l) => l.includes(match[0].trim()));
    if (!line) continue;
    return {
      token: tokens.find((t) => new RegExp(`\\b${t}\\b`).test(hit.rowText)) ?? tokens[0] as string,
      code: hit.code,
      meaning: match[2].trim(),
      rowText: hit.rowText,
      legendLine: line.trim(),
      table: hit.chunk,
      legend: chunk,
    };
  }
  return null;
};

/**
 * Table window for the model prompt: never truncate a table mid-row.
 *
 * `PROMPT_SNIPPET_LEN` slices every chunk at 650 chars; measured 523 of 3,161
 * table chunks exceed that, and a cut can land mid-row — asking the model to
 * read a row it cannot see. A table chunk is therefore sent as a window
 * instead of a slice:
 *
 *   title line(s) + header row(s) + matched data row(s) + same-page legend lines
 *
 * Row matching reuses the question's extracted measures (measure.ts, the same
 * no-conversion key discipline as retrieval scoring and the numbers verifier,
 * so "1 in" meets a `1"` row but never a 12 in row): a data row is kept when
 * one of its measurements keys onto a question measurement. Table units
 * usually live in the header ("Height Above Ground Line (ft)") rather than
 * the row ("27.5 or Below"), so when nothing matches the whole table goes —
 * tables top out around 5k chars, the model can take it, and a complete table
 * always beats a sliced one.
 *
 * Legend lines come from the prompt set itself: retrieval already groups each
 * table with its same-page short-text definitions (`withLegends`), so any
 * sibling chunk on the same page carrying a `CODE = meaning` line contributes
 * that line next to the table instead of chapters away from it. Non-table
 * chunks keep the 650-char cut.
 *
 * Framing (`[index] page= section= evidence=`) and chunk order are untouched,
 * so citation indices still address the same chunks, and the verifiers
 * (`resolveQuote`, `verifyAnswerNumbers`, `verifyConditionalFidelity`) — which
 * read the full chunk text, not the snippet — keep working unchanged.
 */
const isTableSeparatorRow = (line: string) =>
  line.includes("---") && /^[\s|:\-]+$/.test(line);

const isTableMetaRow = (line: string) => /EFFECTIVE DATE/i.test(line);

/** First pipe-delimited cell, ignoring a leading `|`. */
const firstTableCell = (line: string): string => {
  const cells = line.split("|").map((cell) => cell.trim());
  while (cells.length > 0 && cells[0] === "") {
    cells.shift();
  }
  return cells[0] ?? "";
};

export const buildTableWindow = (
  chunk: RetrievalChunk,
  siblings: RetrievalChunk[],
  questionKeys: Set<string>
): string | null => {
  const lines = chunk.text.split("\n");
  const firstPipe = lines.findIndex((line) => line.includes("|"));
  if (firstPipe < 0) {
    return null;
  }
  const titleLines = lines
    .slice(0, firstPipe)
    .map((line) => line.trim())
    .filter(Boolean);
  const pipeRows = lines
    .slice(firstPipe)
    .filter(
      (line) =>
        line.includes("|") && !isTableSeparatorRow(line) && !isTableMetaRow(line)
    );
  if (pipeRows.length === 0) {
    return null;
  }
  // Header rows: the leading run of rows whose first cell is a label, not a
  // value ("Equipment Mounting Height ..." / "Usable ft-lb Grade A" / "SF"),
  // capped at three. A table that opens on a value still keeps its first row
  // as the header so the window is never headerless.
  const headers: string[] = [];
  const rest = [...pipeRows];
  while (
    rest.length > 0 &&
    headers.length < 3 &&
    !/^\d/.test(firstTableCell(rest[0] ?? ""))
  ) {
    headers.push((rest.shift() ?? "").trim());
  }
  if (headers.length === 0 && rest.length > 0) {
    headers.push((rest.shift() ?? "").trim());
  }
  const matched =
    questionKeys.size === 0
      ? []
      : rest.filter((line) =>
          extractMeasurements(line).some((m) => questionKeys.has(measureKey(m)))
        );
  // Trailing footnotes ride with a matched window: they are short and often
  // carry the unit or condition the rows assume.
  let lastPipe = -1;
  lines.forEach((line, index) => {
    if (line.includes("|")) {
      lastPipe = index;
    }
  });
  const footnotes =
    lastPipe < 0
      ? []
      : lines
          .slice(lastPipe + 1)
          .map((line) => line.trim())
          .filter(Boolean);
  // Legend lines from same-page short-text siblings in the prompt set (the
  // definitions retrieval attached, e.g. "U = Unacceptable"). Whole sibling
  // chunks stay as their own prompt entries; only the `CODE = meaning` lines
  // are repeated next to the table, capped so the window stays bounded.
  const legendLines: string[] = [];
  for (const sibling of siblings) {
    if (sibling.id === chunk.id) {
      continue;
    }
    if (sibling.docId !== chunk.docId || sibling.page !== chunk.page) {
      continue;
    }
    if (sibling.text.length > 400) {
      continue;
    }
    for (const line of sibling.text.split("\n")) {
      const trimmed = line.trim();
      if (
        trimmed.includes("=") &&
        /[A-Za-z)]\s*=\s*\S/.test(trimmed) &&
        !legendLines.includes(trimmed)
      ) {
        legendLines.push(trimmed);
      }
    }
    if (legendLines.length >= 6) {
      break;
    }
  }
  const parts =
    matched.length > 0
      ? [...titleLines, ...headers, ...matched.map((line) => line.trim()), ...footnotes]
      : [chunk.text.trim()];
  if (legendLines.length > 0) {
    parts.push(`Legend: ${legendLines.join(" ")}`);
  }
  return parts.filter(Boolean).join("\n");
};

const answerPrompt = (
  question: string,
  chunks: RetrievalChunk[],
  conversationPrefix = "",
  storedExceptions: StoredException[] = []
) => {
  const questionKeys = new Set(extractMeasurements(question).map(measureKey));
  const context = chunks
    .map((chunk, index) => {
      const tableWindow = chunk.text.includes("|")
        ? buildTableWindow(chunk, chunks, questionKeys)
        : null;
      const snippet =
        tableWindow !== null
          ? sanitize(tableWindow)
          : sanitize(chunk.text).slice(0, PROMPT_SNIPPET_LEN);
      return `[${index}] page=${chunk.page} section=${chunk.section ?? ""} evidence=${snippet}`;
    })
    .join("\n");

  const prior = conversationPrefix.trim()
    ? `Prior conversation (for follow-up context only; facts must still come from ESR chunks below):\n${conversationPrefix.trim()}\n\n`
    : "";

  const exceptionBlock =
    storedExceptions.length > 0
      ? `Stored exceptions (from the ESR index — do not contradict; do not invent additional exceptions):\n${storedExceptions
          .map((ex, i) => `- [${i}] ${sanitize(ex.text).slice(0, 240)}`)
          .join("\n")}\n\n`
      : "";

  return `
You are a strict retrieval-grounded assistant. Use only the provided ESR chunks.
Write in short, direct language for construction professionals (STE-inspired: active voice, short sentences, one idea per sentence; keep ESR technical nouns consistent).
${prior}${exceptionBlock}Question: ${question}

Context chunks:
${context}

Return valid JSON exactly in this structure:
{
  "answer": "concise answer for user",
  "directAnswer": "single-sentence key answer (often one value/unit when applicable)",
  "citations": [
    {"chunkIndex": number, "quote": "exact words copied from that chunk", "reason": "why this chunk supports answer", "type": "text|figure|table|caption"}
  ],
  "figures": [
    {"chunkIndex": number}
  ]
}

Rules:
- Cite at least one chunk.
- Every citation MUST include "quote": copy the exact words from that chunk that support the answer. Character-for-character, including units. A quote is checked against the chunk and dropped if it does not appear, so a paraphrase loses you the citation.
- Limit each citation list to the most relevant chunks only.
- Use only language supported by the ESR chunks.
- Do not add unknown values.
- Do not invent or list exceptions in the JSON. Exceptions are attached separately from storage.
- When the question mentions orientation or location (front, rear, side, line side, load side, working space, radial, "in front of"), the answer and directAnswer MUST reflect that same orientation. Do not substitute a clearance that applies to a different face (e.g. rear/radial vs front/working space) unless the chunks only address one.
- Approval questions ("can I approve", "is X allowed", "is X permitted") require a chunk that explicitly permits or prohibits X. A chunk about a nearby topic (upgrade options answering a setback question) is not permission. If the chunks state a requirement the question would violate (a 3-foot minimum where 2 feet is asked), the answer is no — never infer approval from the absence of a prohibition.
- When a chunk states a requirement that applies under a stated condition (joint pole attachments get Grade A; heavy loading areas get Grade A), the answer and directAnswer MUST carry the condition with the requirement: "it depends — Grade A for joint use, Grade B otherwise." Never promote a conditional requirement to an unconditional one ("joint → A" must not become "all → A"). If the chunks state the general rule but not the exception the question needs, say what the chunks do and do not cover rather than dropping the condition.
- When a table cell is a code or single letter (e.g. A, U, C, B), interpret it ONLY through a legend or definition chunk in the context ("U = Unacceptable"). Never expand a code from prior knowledge or from the column heading alone. If no legend is present in the chunks, say the code's meaning is not stated in the retrieved passages instead of guessing.
- Keep answer concise: exactly one short paragraph in answer; one-sentence directAnswer (roughly <= 36 words when needed for units like feet and inches).
- If confidence is weak return a brief caveat inside answer.
`;
};

const buildFigureEvidence = (
  quoteSet: RetrievalChunk[],
  figureResponses: Array<{ chunkIndex?: number }> | undefined,
  pageFigures: FigureEvidence[]
) => {
  const byPage = new Map<string, FigureEvidence>();
  for (const figure of pageFigures) {
    const key = locationKey(figure.docId, figure.page);
    if (!byPage.has(key)) {
      byPage.set(key, figure);
    }
  }

  const seen = new Set<string>();
  const selected = [] as FigureEvidence[];

  const requested = figureResponses ?? [];
  for (const figure of requested) {
    const chunkIndex = figure.chunkIndex;
    if (typeof chunkIndex !== "number" || chunkIndex < 0) {
      continue;
    }
    const chunk = quoteSet[chunkIndex];
    if (!chunk) {
      continue;
    }
    const match = byPage.get(locationKey(chunk.docId, chunk.page));
    if (!match) {
      continue;
    }
    if (!seen.has(match.id)) {
      selected.push(match);
      seen.add(match.id);
    }
  }

  if (selected.length > 0) {
    return selected;
  }

  for (const chunk of quoteSet) {
    const match = byPage.get(locationKey(chunk.docId, chunk.page));
    if (match && !seen.has(match.id)) {
      selected.push(match);
      seen.add(match.id);
      if (selected.length >= 2) {
        break;
      }
    }
  }

  return selected;
};

const answerByModel = async (prompt: string): Promise<ModelResult> => {
  return retryAsync(() => withTimeout(askOllama(prompt), getAppConfig().REQUEST_TIMEOUT_MS));
};

/**
 * The model call that a stream rides on.
 *
 * No total-duration budget, only the per-chunk idle budget inside `streamOllama`:
 * a whole-answer deadline would cut off the very stream being asked for. The
 * retry is deliberately narrower than `retryAsync`'s — one attempt only while
 * nothing has been emitted, because a retry after prose has been handed to the
 * client would repeat it in the transcript.
 */
const streamAnswerByModel = async (
  prompt: string,
  signal: AbortSignal | undefined,
  onAnswerText: (delta: string) => Promise<void>
): Promise<ModelResult> => {
  let emitted = false;
  const run = () =>
    streamOllama(prompt, {
      signal,
      onAnswerText: async (delta) => {
        emitted = true;
        await onAnswerText(delta);
      },
    });

  try {
    return await run();
  } catch (error) {
    if (emitted || signal?.aborted) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return run();
  }
};

/** What retrieval found, as the answer was assembled from it. */
export type RetrievedProgress = {
  /** Sections retrieval returned; these are the ones the answer reads. */
  totalCandidates: number;
  /** Passages lexical retrieval matched, the pool `totalCandidates` came from. */
  matchedChunks: number;
  confidence: number;
  chapters: string[];
  /** Pages read, ascending and de-duplicated. */
  pages: number[];
  /** Diagrams the finished answer will carry. Counted, not predicted. */
  figureCount: number;
};

export type AnswerProgressEvent =
  /** The answer came out of the query cache; no retrieval, no model. */
  | { kind: "cached"; retrieved: RetrievedProgress }
  | { kind: "retrieved"; retrieved: RetrievedProgress }
  /** Text is about to start. `model` is the only source still being generated. */
  | { kind: "write"; source: "model" | "cache" | "extractive" | "fallback" | "near-miss" }
  /** Prose decoded from the model's `answer` value, as it was produced. */
  | { kind: "text"; delta: string };

export type AnswerSink = {
  onEvent: (event: AnswerProgressEvent) => void | Promise<void>;
};

export type AnswerOutcome = {
  answer: ChatAnswer;
  /** Counts the model server reported, or null when it reported none. */
  usage: OllamaUsage | null;
};

export type AnswerQuestionOptions = {
  visualFirst?: boolean;
  conversationPrefix?: string;
  /** Aborts a stream in flight when the caller goes away. */
  signal?: AbortSignal;
};

type AnswerCoreOptions = AnswerQuestionOptions & {
  /** Present to stream; absent for the one-shot path. */
  sink?: AnswerSink;
};

/**
 * Diagrams the finished answer will carry, counted from storage before any
 * generation runs.
 *
 * `finalizeFigures` guarantees one figure per cited page, so with the default
 * visual handling the count is exactly the number of pages read. Visual-first
 * additionally merges every figure and table row on those pages, which is why
 * that case counts rows.
 */
const countDiagrams = (
  locations: PageLocation[],
  allFigures: FigureEvidence[],
  visualFirst: boolean
): number => {
  if (!visualFirst) {
    return locations.length;
  }
  const wanted = new Set(locations.map((l) => locationKey(l.docId, l.page)));
  const rowsByLocation = new Map<string, number>();
  for (const figure of allFigures) {
    const key = locationKey(figure.docId, figure.page);
    if (!wanted.has(key)) {
      continue;
    }
    rowsByLocation.set(key, (rowsByLocation.get(key) ?? 0) + 1);
  }
  return locations.reduce(
    (total, l) => total + Math.max(rowsByLocation.get(locationKey(l.docId, l.page)) ?? 0, 1),
    0
  );
};

const retrievedProgress = (
  totalCandidates: number,
  facts: { matchedChunks: number; confidence: number },
  chapters: string[],
  locations: PageLocation[],
  allFigures: FigureEvidence[],
  visualFirst: boolean
): RetrievedProgress => ({
  totalCandidates,
  matchedChunks: facts.matchedChunks,
  confidence: facts.confidence,
  chapters,
  pages: locations.map((l) => l.page),
  figureCount: countDiagrams(locations, allFigures, visualFirst),
});

/** The one summary shape every answer reports, whatever produced the prose. */
const retrievalSummaryFor = (
  candidates: number,
  summary: Awaited<ReturnType<typeof retrieveChunks>>["summary"],
  chapters: string[],
  retrievalLatencyMs: number,
  docs: ManualId[] = []
): ChatAnswer["retrievalSummary"] => ({
  totalCandidates: candidates,
  matchedChunks: summary.matchedChunks,
  confidence: summary.confidence,
  coverage: summary.coverage,
  notCovered: summary.notCovered,
  intent: summary.intent.trigger,
  chapters,
  docs,
  latencyMs: retrievalLatencyMs,
});

const answerCore = async (
  question: string,
  options: AnswerCoreOptions = {}
): Promise<AnswerOutcome> => {
  const { visualFirst = false, conversationPrefix = "" } = options;
  const { sink } = options;
  const config = getAppConfig();
  const requestStart = Date.now();
  const extractive = config.EXTRACTIVE_ANSWER;
  const emit = async (event: AnswerProgressEvent) => {
    await sink?.onEvent(event);
  };
  const cached = getCacheEntry(
    question,
    visualFirst,
    conversationPrefix,
    extractive
  ) as ChatAnswer | null;
  if (cached) {
    // Retrieval did not run, so its latency did not either.
    cached.retrievalSummary.latencyMs = 0;
    await emit({
      kind: "cached",
      retrieved: {
        totalCandidates: cached.retrievalSummary.totalCandidates,
        matchedChunks: cached.retrievalSummary.matchedChunks,
        confidence: cached.retrievalSummary.confidence,
        chapters: cached.retrievalSummary.chapters,
        pages: [...new Set(cached.citations.map((citation) => citation.page))].sort(
          (a, b) => a - b
        ),
        figureCount: cached.figures.length,
      },
    });
    // One event, not a token stream: the prose already exists whole.
    await emit({ kind: "text", delta: cached.answer });
    return { answer: cached, usage: null };
  }

  const retrievalQuery = buildRetrievalQuery(question, conversationPrefix);
  const { candidates, summary } = await retrieveChunks(retrievalQuery, {
    visualFirst,
  });
  // Retrieval is over. Everything after this is generation, and must not be
  // billed to `retrievalSummary.latencyMs`.
  const retrievalLatencyMs = Date.now() - requestStart;
  const emitRetrieved = async (retrieved: RetrievedProgress) => {
    await emit({ kind: "retrieved", retrieved });
  };

  if (candidates.length === 0) {
    // Nothing cleared the threshold. The verdict is stated exactly once, by the
    // not-covered notice under the card; the badge says it in one word and the
    // answer prose says what to do about it. Repeating it here as well made one
    // finding look like three separate problems.
    const nearMisses = getNearestChunks(retrievalQuery, 3);
    const chapters = [...new Set(nearMisses.map((c) => c.chapter).filter(Boolean))] as string[];
    const empty: ChatAnswer = {
      answer: NOT_COVERED_ANSWER,
      directAnswer: "",
      citations: nearMisses
        .map((chunk) => buildCitation(null, chunk, question))
        .filter((c): c is SourceCitation => c !== null),
      figures: [],
      exceptions: [],
      grounding: "none",
      notCovered: true,
      retrievalSummary: {
        totalCandidates: 0,
        matchedChunks: summary.matchedChunks,
        confidence: summary.confidence,
        coverage: summary.coverage,
        notCovered: true,
        intent: summary.intent.trigger,
        chapters,
        docs: [...new Set(nearMisses.map((c) => c.docId))],
        latencyMs: retrievalLatencyMs,
      },
    };
    // Nothing was read, so nothing was found: the near misses are handed back
    // as citations, not as an answer, and no page or diagram count applies.
    await emitRetrieved(retrievedProgress(0, summary, chapters, [], [], false));
    await emit({ kind: "write", source: "near-miss" });
    await emit({ kind: "text", delta: empty.answer });
    return { answer: empty, usage: null };
  }

  const chapters = [
    ...new Set(candidates.map((c) => c.chunk.chapter).filter((v): v is string => Boolean(v))),
  ];
  const quoteSet = candidates.map((result) => ({
    docId: result.chunk.docId,
    page: result.chunk.page,
    text: result.chunk.text,
    section: result.chunk.section ?? null,
    chapter: result.chunk.chapter ?? null,
    pageLabel: result.chunk.pageLabel ?? null,
    standard: result.chunk.standard ?? null,
    sheetOf: result.chunk.sheetOf ?? null,
    sheetCount: result.chunk.sheetCount ?? null,
    score: result.confidence,
    id: result.chunk.id,
  }));
  const locations = locationsOf(quoteSet);
  const docs = [...new Set(quoteSet.map((chunk) => chunk.docId))];

  const allFigures = getAllPageFigures();
  const retrieved = retrievedProgress(
    candidates.length,
    summary,
    chapters,
    locations,
    allFigures,
    visualFirst
  );

  const buildFallback = () => {
    const citations = quoteSet
      .slice(0, 4)
      .map((chunk) => buildCitation(null, chunk, question))
      .filter((c): c is SourceCitation => c !== null);
    const exceptions = collectStoredExceptions(
      quoteSet.map((c) => c.id),
      citations
    );
    return fallbackAnswer(
      question,
      citations,
      quoteSet.map((chunk) => chunk.text),
      allFigures,
      quoteSet,
      exceptions
    );
  };

  /** The extractive answer, complete with its figures and summary. */
  const finalizeFallback = () => {
    const fallback = buildFallback();
    // Same guards as the model path: an extractive answer quotes the chunks
    // directly, which makes flattened conditionals *more* likely, not less —
    // the quote carries the condition but the assembled prose can still drop
    // it. Every consumer of this (extractive mode, model-failure fallback)
    // gets the guards through here.
    const numbersOk = verifyAnswerNumbers(
      question,
      fallback.answer,
      fallback.directAnswer,
      fallback.citations,
    );
    const faithful = verifyConditionalFidelity(
      numbersOk.answer,
      numbersOk.directAnswer,
      fallback.citations,
    );
    fallback.answer = faithful.answer;
    fallback.directAnswer = faithful.directAnswer;
    if (!numbersOk.ok || !faithful.ok) {
      fallback.grounding = "partial";
    }
    if (visualFirst && quoteSet.length > 0) {
      fallback.figures = mergeFigureLists(
        fallback.figures,
        getFigureEvidenceForPages(locationsOf(quoteSet))
      );
    }
    fallback.figures = finalizeFigures(fallback.figures, quoteSet);
    fallback.retrievalSummary = retrievalSummaryFor(
      candidates.length,
      summary,
      chapters,
      retrievalLatencyMs,
      locationsOf(quoteSet).map((l) => l.docId)
    );
    return fallback;
  };

  await emitRetrieved(retrieved);

  if (extractive) {
    const fallback = finalizeFallback();
    saveCacheEntry(
      question,
      fallback,
      config.EMBEDDING_CACHE_TTL_SECONDS,
      visualFirst,
      conversationPrefix,
      extractive
    );
    await emit({ kind: "write", source: "extractive" });
    await emit({ kind: "text", delta: fallback.answer });
    return { answer: fallback, usage: null };
  }

  const provisionalCitations = quoteSet
    .slice(0, 4)
    .map((chunk) => buildCitation(null, chunk, question))
    .filter((c): c is SourceCitation => c !== null);
  const storedExceptions = collectStoredExceptions(
    quoteSet.map((c) => c.id),
    provisionalCitations
  );

  // A coded table cell the question names outright never goes to the model:
  // the model misreads long markdown tables (it attached row 1's `A` to
  // `301A` while quoting the row that says `U`), and the row plus its legend
  // is a complete answer on its own. Skips the ~7s model call as well.
  const tableVerdict = resolveTableCode(question, quoteSet.slice(0, MAX_PROMPT_CHUNKS));
  if (tableVerdict) {
    // Verbatim spans, not resolveQuote: the row and the legend line were
    // lifted character-for-character from their chunks, so indexOf is exact
    // and the quote stays one row / one line instead of ballooning to the
    // whole table (which is what the fuzzy quoter produces here).
    const exactCitation = (text: string, chunk: RetrievalChunk): SourceCitation | null => {
      const start = chunk.text.indexOf(text);
      if (start < 0 || text.length < 8) return null;
      return {
        docId: chunk.docId,
        page: chunk.page,
        quote: text,
        section: chunk.section ?? null,
        chapter: chunk.chapter ?? null,
        pageLabel: chunk.pageLabel ?? null,
        standard: chunk.standard ?? null,
        sheetOf: chunk.sheetOf ?? null,
        sheetCount: chunk.sheetCount ?? null,
        sourceLink: evidencePageLink(chunk.docId, chunk.page),
        quoteStart: start,
        quoteEnd: start + text.length,
      };
    };
    const rowCitation = exactCitation(tableVerdict.rowText, tableVerdict.table);
    const legendCitation = exactCitation(tableVerdict.legendLine, tableVerdict.legend);
    const tableCitations = [rowCitation, legendCitation].filter(
      (c): c is SourceCitation => c !== null,
    );
    if (tableCitations.length === 2) {
      const section =
        tableVerdict.table.section ?? `the ${MANUALS[tableVerdict.table.docId].code}`;
      const tableAnswer = `${tableVerdict.token} is marked ${tableVerdict.code} (${tableVerdict.meaning}) in ${section}.`;
      let tableFigures = fallbackFigureEvidence(quoteSet, allFigures);
      if (visualFirst && quoteSet.length > 0) {
        tableFigures = mergeFigureLists(
          tableFigures,
          getFigureEvidenceForPages(locationsOf(quoteSet)),
        );
      }
      tableFigures = finalizeFigures(tableFigures, quoteSet);
      const tableResponse: ChatAnswer = {
        answer: tableAnswer,
        directAnswer: `${tableVerdict.token} is ${tableVerdict.code} (${tableVerdict.meaning}).`,
        citations: tableCitations,
        figures: tableFigures,
        exceptions: storedExceptions,
        grounding: "esr",
        notCovered: false,
        retrievalSummary: retrievalSummaryFor(
          candidates.length,
          summary,
          chapters,
          retrievalLatencyMs,
          [tableVerdict.table.docId],
        ),
      };
      saveCacheEntry(
        question,
        tableResponse,
        config.EMBEDDING_CACHE_TTL_SECONDS,
        visualFirst,
        conversationPrefix,
        extractive,
      );
      if (sink) {
        await emit({ kind: "write", source: "extractive" });
        await emit({ kind: "text", delta: tableResponse.answer });
      }
      return { answer: tableResponse, usage: null };
    }
  }

  const prompt = answerPrompt(
    question,
    quoteSet.slice(0, MAX_PROMPT_CHUNKS),
    conversationPrefix,
    storedExceptions
  );

  let parsed: ParsedModelResponse;
  let usage: OllamaUsage | null = null;
  let streamedText = false;
  try {
    if (sink) {
      await emit({ kind: "write", source: "model" });
      const streamed = await streamAnswerByModel(prompt, options.signal, async (delta) => {
        streamedText = true;
        await emit({ kind: "text", delta });
      });
      parsed = streamed.response;
      usage = streamed.usage;
    } else {
      const answered = await answerByModel(prompt);
      parsed = answered.response;
      usage = answered.usage;
    }
  } catch (error) {
    // Prose already on the wire cannot be taken back, so a failure past the
    // first token is the caller's to report, not something to paper over by
    // silently swapping in a different answer.
    if (streamedText || options.signal?.aborted) {
      throw error;
    }
    const fallback = finalizeFallback();
    if (sink) {
      await emit({ kind: "write", source: "fallback" });
      await emit({ kind: "text", delta: fallback.answer });
    }
    return { answer: fallback, usage: null };
  }

  const rawCitations = parsed.citations ?? [];
  // A citation with no verifiable quote lends authority to whatever the prose
  // claims next to it — "2.5 feet" shipped beside a quoteless row. Drop them;
  // a missing source must read as missing, never as a blank badge of honor.
  const citations = (
    rawCitations.length > 0
      ? rawCitations
          .map((citation) => {
            const index = citation.chunkIndex;
            if (typeof index !== "number" || index < 0 || index >= quoteSet.length) {
              return null;
            }
            const chunk = quoteSet[index];
            // Prefer the model's own quote; fall back to its directAnswer,
            // then to the chunk's opening sentence. Each is verified against
            // the chunk, so an unresolvable citation is dropped, not served.
            return buildCitation(citation.quote, chunk, question);
          })
          .filter((entry): entry is SourceCitation => entry !== null)
      : quoteSet
          .slice(0, 2)
          .map((chunk) => buildCitation(null, chunk, question))
          .filter((entry): entry is SourceCitation => entry !== null)
  ).filter((entry) => entry.quote.trim().length > 0);

  const exceptions = collectStoredExceptions(
    quoteSet.map((c) => c.id),
    citations
  );

  const figures = buildFigureEvidence(quoteSet, parsed.figures, allFigures);
  const rawAnswer = (parsed.answer || citations[0]?.quote || "No answer generated.")
    .replace(/\s+/g, " ")
    .split(/\n{2,}/)
    .slice(0, MAX_ANSWER_PARAGRAPHS)
    .join("\n\n");
  const rawDirectAnswer = parsed.directAnswer || citations[0]?.quote || "No direct answer.";
  const answer = compactToSentences(rawAnswer, 1, MAX_ANSWER_WORDS);
  const directAnswer = deriveDirectAnswer(question, rawDirectAnswer, citations, conversationPrefix);
  // Numbers without quotes are how confident wrong answers ship ("2.5 feet"
  // beside a quoteless row). Verify against the citations that survived: any
  // measurement the quotes do not state caps the verdict at partial, drops a
  // headline that states one, and says so in the prose.
  const verified = verifyAnswerNumbers(question, answer, directAnswer, citations);
  // Conditional fidelity composes after numbers: a flattened requirement is
  // the same class of lie by position as an unsupported number.
  const faithful = verifyConditionalFidelity(
    verified.answer,
    verified.directAnswer,
    citations,
  );

  let figuresOut = figures;
  if (visualFirst && quoteSet.length > 0) {
    figuresOut = mergeFigureLists(figuresOut, getFigureEvidenceForPages(locationsOf(quoteSet)));
  }
  figuresOut = finalizeFigures(figuresOut, quoteSet);

  const response: ChatAnswer = {
    answer: faithful.answer,
    directAnswer: faithful.directAnswer,
    citations,
    figures: figuresOut,
    exceptions,
    grounding:
      citations.length === 0
        ? "none"
        : !verified.ok || !faithful.ok || citations.length < 2
          ? "partial"
          : "esr",
    notCovered: citations.length === 0,
    retrievalSummary: retrievalSummaryFor(
      candidates.length,
      summary,
      chapters,
      retrievalLatencyMs,
      docs
    ),
  };

  saveCacheEntry(
    question,
    response,
    config.EMBEDDING_CACHE_TTL_SECONDS,
    visualFirst,
    conversationPrefix,
    extractive
  );

  return { answer: response, usage };
};

/** One-shot answer. Callers that want prose as it is produced give `sink`. */
export const answerQuestion = async (
  question: string,
  options: AnswerQuestionOptions = {}
): Promise<ChatAnswer> => {
  const { answer } = await answerCore(question, options);
  return answer;
};

/**
 * Answers a question and reports progress as it happens.
 *
 * With a `sink`, `text` events are the model's own output decoded from its JSON
 * stream, in the order it was produced — nothing is assembled before the first
 * one. The finished `ChatAnswer` still comes back whole, because citations and
 * figures cannot be known until generation ends. Without a sink this is the
 * one-shot path, and `usage` still carries the counts the model reported.
 */
export const answerQuestionOutcome = (
  question: string,
  options: AnswerQuestionOptions & { sink?: AnswerSink } = {}
): Promise<AnswerOutcome> => {
  return answerCore(question, options);
};

