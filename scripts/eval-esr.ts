/**
 * Honest scoring of the ESR retrieval + answer path, with gates that can fail.
 *
 * Design rules, in order of importance:
 *
 *   1. The golden set is the input, never the output. goldPages / goldChapters
 *      are read from data/eval/golden.json and are not derived from anything the
 *      retriever did. A retriever cannot mark its own homework.
 *   2. Every threshold lives in data/eval/thresholds.json as reviewable data.
 *      No magic numbers in this file.
 *   3. The run fails loudly. A missing golden file, a missing DB, an
 *      unreachable LLM, or a metric under threshold all set a non-zero exit code
 *      and print what to do about it.
 *   4. Nothing is silently skipped. If the answer path could not run, the report
 *      says so and the gate for it fails unless it was explicitly waived.
 *
 * Usage:
 *   npm run eval:esr
 *   npm run eval:esr -- --answer-sample=16      # more LLM-backed items
 *   npm run eval:esr -- --no-answer-path        # offline; answer gates become SKIPPED
 *   npm run eval:esr -- --allow-missing-llm     # offline but waived; report still records it
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { getAppConfig } from "@/lib/env";
import { askQuestionWithRag } from "@/lib/rag/chatPayload";
import { retrieveChunks } from "@/lib/rag/retrieval";
import type {
  EvalConfidence,
  EvalGoldenFile,
  EvalItem,
  EvalKind,
  EvalLoc,
  EvalThreadTurn,
  EvalThresholdsFile,
} from "./eval-set-types";

/* -------------------------------------------------------------------------- */
/* Golden set + thresholds input                                              */
/* -------------------------------------------------------------------------- */

const GOLDEN_PATH = path.resolve(process.cwd(), "data/eval/golden.json");
const THRESHOLDS_PATH = path.resolve(process.cwd(), "data/eval/thresholds.json");
const REPORT_PATH = path.resolve(process.cwd(), "data/eval/report.json");

type GoldenFile = EvalGoldenFile;
type ThresholdsFile = EvalThresholdsFile;

const fail = (message: string): never => {
  console.error(`\n[eval-esr] FATAL\n\n${message}\n`);
  process.exit(1);
};

const loadGolden = (): GoldenFile => {
  if (!fs.existsSync(GOLDEN_PATH)) {
    fail(
      `Golden set not found: data/eval/golden.json\n\n` +
        `Generate it first:\n` +
        `  npm run ingest:manuals # only if data/manuals.sqlite is missing or empty\n` +
        `  npm run build:eval      # writes data/eval/golden.json from figure OCR`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
  } catch (error) {
    fail(
      `Golden set at data/eval/golden.json is not valid JSON: ` +
        `${error instanceof Error ? error.message : String(error)}\n\nRegenerate:  npm run build:eval`
    );
  }
  const golden = parsed as GoldenFile;
  if (!Array.isArray(golden.items) || golden.items.length === 0) {
    fail(
      `Golden set at data/eval/golden.json has zero items.\n\n` +
        `A zero-item eval run proves nothing. Regenerate:  npm run build:eval`
    );
  }
  return golden;
};

const loadThresholds = (): ThresholdsFile => {
  if (!fs.existsSync(THRESHOLDS_PATH)) {
    fail(
      `Thresholds not found: data/eval/thresholds.json\n\n` +
        `Gates are reviewable data, not magic numbers. Restore the file from version control, ` +
        `or recreate it with the `+"`gates`"+` block documented in README or the commit that added it.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(THRESHOLDS_PATH, "utf8"));
  } catch (error) {
    fail(
      `Thresholds file is not valid JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
  const file = parsed as ThresholdsFile;
  if (!file.gates || typeof file.gates !== "object") {
    fail(`Thresholds file has no "gates" object. Fix data/eval/thresholds.json.`);
  }
  return file;
};

/* -------------------------------------------------------------------------- */
/* Answer-string matching                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Normalise a haystack or a needle so that "87%", "87 percent" and
 * "87  percent." compare equal, and "12 in" equals "12 inches".
 *
 * The golden values come from OCR. The answer comes from a language model.
 * Neither writes units the way the other does, so a raw substring test would
 * measure unit formatting rather than correctness.
 */
const normalizeForMatch = (value: string): string => {
  const digitsFirst = value.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
  const units = digitsFirst
    .toLowerCase()
    .replace(/%/g, " percent ")
    .replace(/\bm\.?\s*g\.?\b/g, " milligauss ")
    .replace(/\bmilligauss\b/g, " milligauss ")
    .replace(/\binch(?:es)?\b/g, " inch ")
    .replace(/\bfeet\b|\bfoot\b|\bft\b/g, " foot ")
    .replace(/\bvolts?\b/g, " volt ")
    .replace(/\bamper(?:e|es)\b|\bamps?\b/g, " amp ")
    .replace(/["′’]/g, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return units;
};

/** `(?<![\d.])` stops "12 inch" matching inside "312 inch" or "3.12 inch". */
const containsNeedle = (haystack: string, needle: string): boolean => {
  const n = normalizeForMatch(needle);
  if (!n) return true;
  const h = normalizeForMatch(haystack);
  let from = 0;
  for (;;) {
    const at = h.indexOf(n, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : h.slice(at - 1, at);
    if (!/\d/.test(before)) return true;
    from = at + 1;
  }
};

/* -------------------------------------------------------------------------- */
/* Non-coverage detection                                                      */
/* -------------------------------------------------------------------------- */

const NOT_COVERED_PHRASES: Array<[string, RegExp]> = [
  ["not-covered-by-esr", /\bnot (?:covered|addressed|specified|described)\b/i],
  ["does-not-cover", /\b(?:does|do) not (?:cover|address|specify|include|mention|state|provide)\b/i],
  ["no-matching-content", /\bno (?:matching|corresponding|relevant|applicable) (?:esr )?(?:content|provision|requirement|information|section|answer|result|reference)/i],
  ["no-result", /\b(?:could\s?n[o']?t|cannot|unable to) find\b/i],
  ["no-result", /\bno result\b/i],
  ["not-in-index", /\bnot in (?:the |this )?(?:esr|manual|index|indexed)/i],
  ["out-of-scope", /\bout of scope\b/i],
  ["no-information", /\bno information (?:about|on|regarding)\b/i],
  ["not-specified-in-esr", /\bthe esr (?:does not|doesn't) (?:specify|cover|address)\b/i],
];

/** A number with a unit in an answer to a question that has no such answer. */
const MEASUREMENT_IN_ANSWER =
  /(?<![\d.])\d+(?:\.\d+)?\s*(?:percent|%|inch|inches|in\.|ft|feet|foot|volt|volts|amp|amps|amperes|mva|kw|kva|milligauss|mG|gauss)\b/i;

const detectNotCoveredSignals = (
  answerText: string,
  retrievalNotCovered: boolean,
  answerNotCovered: boolean | undefined
): { signalled: boolean; sources: string[] } => {
  const sources: string[] = [];
  if (retrievalNotCovered) sources.push("retrieval.notCovered");
  if (answerNotCovered === true) sources.push("answer.notCovered");
  for (const [label, re] of NOT_COVERED_PHRASES) {
    if (re.test(answerText) && !sources.includes(label)) sources.push(label);
  }
  return { signalled: sources.length > 0, sources };
};

/* -------------------------------------------------------------------------- */
/* LLM availability                                                            */
/* -------------------------------------------------------------------------- */

type OllamaProbe = { ok: boolean; detail: string };

const probeOllama = async (): Promise<OllamaProbe> => {
  const config = getAppConfig();
  const base = config.OLLAMA_BASE_URL.replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) {
      return { ok: false, detail: `${base} returned HTTP ${response.status}` };
    }
    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    const names = (body.models ?? []).map((model) => model.name ?? "").filter(Boolean);
    if (!names.includes(config.OLLAMA_CHAT_MODEL)) {
      return {
        ok: false,
        detail:
          `Ollama is up at ${base} but ${config.OLLAMA_CHAT_MODEL} is not pulled. ` +
          `Available: ${names.join(", ") || "none"}`,
      };
    }
    return { ok: true, detail: `${base} reachable, model ${config.OLLAMA_CHAT_MODEL}` };
  } catch (error) {
    return {
      ok: false,
      detail: `Ollama unreachable at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/* -------------------------------------------------------------------------- */
/* Per-item evaluation                                                         */
/* -------------------------------------------------------------------------- */

type AnswerOutcome = {
  attempted: boolean;
  ok: boolean;
  error?: string;
  latencyMs: number;
  /** True when query_cache already held this question before the call. */
  servedFromCache: boolean | null;
  /** Latency consistent with hitting the request timeout at least once. */
  hitRequestTimeout: boolean;
  answerText: string;
  citationPages: number[];
  signalledNotCovered: boolean;
  notCoveredSources: string[];
  fabricatedMeasurement: boolean;
  present: string[];
  missed: string[];
  recall: number;
};

type ItemOutcome = {
  id: string;
  kind: EvalKind;
  confidence: EvalConfidence;
  question: string;
  goldPages: number[];
  goldLocs: EvalLoc[];
  goldChapters: string[];
  mustInclude: string[];
  expectNotCovered: boolean;
  retrieval: {
    ok: boolean;
    error?: string;
    latencyMs: number;
    topLocs: EvalLoc[];
    topChapters: string[];
    confidence: number;
    intent: string;
    notCovered: boolean;
    hitAt1: boolean;
    hitAt3: boolean;
    wrongManualTop1: boolean;
    chapterHitAt1: boolean;
    presentInContext: string[];
    missingFromContext: string[];
  };
  answer: AnswerOutcome | null;
  passed: boolean;
  failureReasons: string[];
};

const fmtLoc = (loc: EvalLoc): string => `${loc.docId}:${loc.page}`;

/**
 * Gold locations as {docId, page} pairs. A golden written before pairs
 * existed carries only bare goldPages, and the old builder only ever knew the
 * ESR, so those fall back to ESR pages. Scoring never uses bare pages.
 */
const goldLocsOf = (item: EvalItem): EvalLoc[] =>
  item.goldLocs ?? item.goldPages.map((page) => ({ docId: "esr", page }));

/** The app builds this string in normalizeChatPayload; the shape is User:/Assistant: lines. */
const conversationPrefixOf = (thread: EvalThreadTurn[] | undefined): string =>
  (thread ?? [])
    .map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.text}`)
    .join("\n");

/**
 * Mirror of the anaphora/short-question merge in pipeline.ts
 * `buildRetrievalQuery`, for the eval's retrieval call.
 *
 * This is duplicated deliberately: retrieveChunks takes no conversationPrefix
 * (the merge lives in the answer path, which the eval must not change), so
 * the eval replays the same merge to test the follow-up path honestly. If the
 * two ever drift the follow-up items score differently, which is visible,
 * rather than quietly testing standalone questions.
 */
const ANAPHORA_RE = /\b(it|they|them|he|she|him|her|its|their|theirs)\b/i;

const buildEvalRetrievalQuery = (question: string, conversationPrefix: string): string => {
  const words = question.trim().split(/\s+/).filter(Boolean);
  const prefix = conversationPrefix.trim();
  if (!prefix || (words.length >= 6 && !ANAPHORA_RE.test(question))) {
    return question;
  }
  const lines = [...prefix.matchAll(/^(?:User|Assistant):\s*(.+)$/gim)].map((m) =>
    m[1].trim()
  );
  const tail = lines.slice(-3).join(" ");
  return `${tail} ${question}`.trim().slice(0, 1200);
};

/**
 * Mirror of the cache key in storage.ts `cacheKey`, for the eval's defaults
 * (extractive=false).
 *
 * This is duplicated deliberately: the cache-hit flag decides whether the
 * answer-path numbers are cold or warm, and asking the pipeline would mean
 * changing src/lib/rag. If the two ever drift the flag reads "unknown", which is
 * visible, rather than quietly reporting the wrong thing.
 *
 * EVAL_PIPELINE_VERSION must stay in sync with PIPELINE_VERSION in
 * src/lib/rag/storage.ts: bump both on any retrieval or prompt change, or the
 * flag will read cold for answers the pipeline served warm (and vice versa).
 */
const EVAL_PIPELINE_VERSION = 2;

const answerCacheKey = (
  question: string,
  visualFirst: boolean,
  conversationPrefix = ""
): string =>
  `v${EVAL_PIPELINE_VERSION}\n` +
  question +
  (visualFirst ? "\n__visualFirst=1" : "") +
  (conversationPrefix.trim() ? `\n__thread=${conversationPrefix.trim()}` : "");

const isAnswerCached = (
  dbPath: string,
  question: string,
  visualFirst: boolean,
  conversationPrefix = ""
): boolean | null => {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const hash = crypto
        .createHash("sha256")
        .update(answerCacheKey(question, visualFirst, conversationPrefix))
        .digest("hex");
      const row = db
        .prepare("SELECT 1 AS hit, created_at FROM query_cache WHERE query_hash = ?")
        .get(hash) as { hit: number; created_at: number } | undefined;
      if (row === undefined) return false;
      // Mirror of the read-path TTL in storage.ts getCacheEntry: a stale row
      // is a miss for the pipeline, so it is warm=false for the eval too.
      const ttlSeconds = getAppConfig().EMBEDDING_CACHE_TTL_SECONDS;
      if (!Number.isFinite(row.created_at) || Date.now() - row.created_at > ttlSeconds * 1000) {
        return false;
      }
      return true;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
};

/** Is there an index to score against at all? */
const probeDb = (dbPath: string): { ok: boolean; detail: string; chunks: number } => {
  if (!fs.existsSync(dbPath)) return { ok: false, detail: "file does not exist", chunks: 0 };
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT COUNT(1) AS n FROM chunks").get() as { n: number };
      if (row.n === 0) return { ok: false, detail: "0 chunks indexed", chunks: 0 };
      return { ok: true, detail: `${row.n} chunks indexed`, chunks: row.n };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      detail: `cannot open read-only: ${error instanceof Error ? error.message : String(error)}`,
      chunks: 0,
    };
  }
};

const evaluateItem = async (
  item: EvalItem,
  dbPath: string,
  runAnswerPath: boolean
): Promise<ItemOutcome> => {
  const failureReasons: string[] = [];
  const expectNotCovered = item.expectNotCovered === true;
  const visualFirst = item.kind === "figure-fact";
  const goldLocs = goldLocsOf(item);
  const goldDocs = new Set(goldLocs.map((loc) => loc.docId));
  const conversationPrefix = conversationPrefixOf(item.thread);

  const retrieval = await (async () => {
    const started = Date.now();
    try {
      const result = await retrieveChunks(buildEvalRetrievalQuery(item.question, conversationPrefix), {
        visualFirst,
      });
      const candidates = result.candidates;
      const locs: EvalLoc[] = candidates.map((candidate) => ({
        docId: candidate.chunk.docId,
        page: candidate.chunk.page,
      }));
      const chapters = candidates.map((candidate) => candidate.chunk.chapter ?? "");
      const context = candidates
        .map((candidate) => candidate.chunk.text)
        .join("\n")
        .concat(
          "\n",
          candidates
            .flatMap((candidate) => candidate.chunk.pairedChunkIds)
            .join("\n")
        );
      const present = item.mustInclude.filter((needle) => containsNeedle(context, needle));
      const missing = item.mustInclude.filter((needle) => !containsNeedle(context, needle));
      return {
        ok: true as const,
        latencyMs: Date.now() - started,
        topLocs: locs.slice(0, 5),
        topChapters: chapters.slice(0, 5),
        confidence: result.summary.confidence,
        intent: result.summary.intent.trigger,
        notCovered: result.summary.notCovered,
        hitAt1:
          locs[0] !== undefined &&
          goldLocs.some((gold) => gold.docId === locs[0]?.docId && gold.page === locs[0]?.page),
        hitAt3: locs
          .slice(0, 3)
          .some((loc) => goldLocs.some((gold) => gold.docId === loc.docId && gold.page === loc.page)),
        // A page number alone is not evidence: page 36 exists in all five
        // manuals, so a top-1 from the wrong manual is a miss with a name.
        wrongManualTop1:
          goldLocs.length > 0 && locs[0] !== undefined && !goldDocs.has(locs[0]?.docId as string),
        chapterHitAt1:
          chapters[0] !== undefined && item.goldChapters.includes(chapters[0] as string),
        presentInContext: present,
        missingFromContext: missing,
      };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error),
        latencyMs: Date.now() - started,
        topLocs: [] as EvalLoc[],
        topChapters: [] as string[],
        confidence: 0,
        intent: "error",
        notCovered: false,
        hitAt1: false,
        hitAt3: false,
        wrongManualTop1: false,
        chapterHitAt1: false,
        presentInContext: [] as string[],
        missingFromContext: item.mustInclude,
      };
    }
  })();

  if (!retrieval.ok) {
    failureReasons.push(`retrieval threw: ${retrieval.error}`);
  } else if (expectNotCovered) {
    if (!retrieval.notCovered) {
      failureReasons.push(
        `retrieval claimed coverage for an out-of-scope question ` +
          `(confidence ${retrieval.confidence.toFixed(3)}, top locs ${retrieval.topLocs.map(fmtLoc).join(",")})`
      );
    }
  } else {
    if (!retrieval.hitAt1) {
      failureReasons.push(
        `hit@1 miss: gold ${goldLocs.map(fmtLoc).join(",")}, got ${retrieval.topLocs.map(fmtLoc).join(",") || "none"}`
      );
    }
    if (!retrieval.hitAt3) {
      failureReasons.push(`hit@3 miss: gold ${goldLocs.map(fmtLoc).join(",")}`);
    }
  }

  let answer: AnswerOutcome | null = null;
  if (runAnswerPath) {
    const requestTimeoutMs = getAppConfig().REQUEST_TIMEOUT_MS;
    const cachedBefore = isAnswerCached(dbPath, item.question, visualFirst, conversationPrefix);
    const started = Date.now();
    try {
      const result = await askQuestionWithRag(item.question, visualFirst, conversationPrefix);
      const latencyMs = Date.now() - started;
      const answerText = `${result.answer}\n${result.directAnswer}\n${result.citations
        .map((citation) => citation.quote)
        .join("\n")}`;
      const signals = detectNotCoveredSignals(answerText, retrieval.notCovered, result.notCovered);
      const present = item.mustInclude.filter((needle) => containsNeedle(answerText, needle));
      const missed = item.mustInclude.filter((needle) => !containsNeedle(answerText, needle));
      answer = {
        attempted: true,
        ok: true,
        latencyMs,
        servedFromCache: cachedBefore,
        // pipeline.answerQuestion retries the model call, so two consecutive
        // request timeouts is a reliable signature of the LLM path giving up.
        hitRequestTimeout: latencyMs >= requestTimeoutMs * 2,
        answerText: `${result.answer}`.slice(0, 600),
        citationPages: result.citations.map((citation) => citation.page),
        signalledNotCovered: signals.signalled,
        notCoveredSources: signals.sources,
        // A fabrication is the system *asserting* a value for an out-of-scope
        // question. When it correctly refuses, the refusal copy itself quotes
        // no measurement; when it answers, a number in the prose is the tell.
        // Excluding the refuse path stops the notice's own wording from being
        // scored as a fabricated answer.
        fabricatedMeasurement:
          expectNotCovered &&
          !signals.signalled &&
          MEASUREMENT_IN_ANSWER.test(answerText),
        present,
        missed,
        recall: item.mustInclude.length === 0 ? 1 : present.length / item.mustInclude.length,
      };

      if (expectNotCovered) {
        if (!answer.signalledNotCovered) {
          failureReasons.push(
            `answer did not signal non-coverage (sources tried: ${
              answer.notCoveredSources.join(", ") || "none"
            })`
          );
        }
        if (answer.fabricatedMeasurement) {
          failureReasons.push(
            "answer invented a measurement for an out-of-scope question"
          );
        }
      } else if (item.mustInclude.length > 0 && answer.missed.length > 0) {
        failureReasons.push(`answer missed: ${answer.missed.join(" | ")}`);
      }
    } catch (error) {
      answer = {
        attempted: true,
        ok: false,
        error: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error),
        latencyMs: Date.now() - started,
        servedFromCache: cachedBefore,
        hitRequestTimeout: false,
        answerText: "",
        citationPages: [],
        signalledNotCovered: false,
        notCoveredSources: [],
        fabricatedMeasurement: false,
        present: [],
        missed: item.mustInclude,
        recall: item.mustInclude.length === 0 ? 0 : 0,
      };
      failureReasons.push(`answer path threw: ${answer.error}`);
    }
  }

  return {
    id: item.id,
    kind: item.kind,
    confidence: item.confidence,
    question: item.question,
    goldPages: item.goldPages,
    goldLocs,
    goldChapters: item.goldChapters,
    mustInclude: item.mustInclude,
    expectNotCovered,
    retrieval,
    answer,
    passed: failureReasons.length === 0,
    failureReasons,
  };
};

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                 */
/* -------------------------------------------------------------------------- */

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

type Bucket = {
  items: number;
  retrievalErrors: number;
  hitAt1: number;
  hitAt3: number;
  wrongManualTop1: number;
  wrongManualAssessed: number;
  chapterHitAt1: number;
  notCoveredItems: number;
  notCoveredSignalled: number;
  fabrications: number;
  mustIncludeStrings: number;
  mustIncludePresent: number;
  mustIncludePresentInContext: number;
  answered: number;
  answerErrors: number;
  answerCacheHits: number;
  answerTimeoutStrikes: number;
  answerPassed: number;
};

const emptyBucket = (): Bucket => ({
  items: 0,
  retrievalErrors: 0,
  hitAt1: 0,
  hitAt3: 0,
  wrongManualTop1: 0,
  wrongManualAssessed: 0,
  chapterHitAt1: 0,
  notCoveredItems: 0,
  notCoveredSignalled: 0,
  fabrications: 0,
  mustIncludeStrings: 0,
  mustIncludePresent: 0,
  mustIncludePresentInContext: 0,
  answered: 0,
  answerErrors: 0,
  answerCacheHits: 0,
  answerTimeoutStrikes: 0,
  answerPassed: 0,
});

const fold = (bucket: Bucket, outcome: ItemOutcome): void => {
  bucket.items += 1;
  if (!outcome.retrieval.ok) bucket.retrievalErrors += 1;
  if (outcome.retrieval.hitAt1) bucket.hitAt1 += 1;
  if (outcome.retrieval.hitAt3) bucket.hitAt3 += 1;
  // Unanswerable items have no gold manual, and a retrieval error has no
  // top-1, so neither is assessed: this is a fraction over answerable items
  // with a top-1, not over the whole set.
  if (outcome.retrieval.ok && outcome.goldLocs.length > 0 && outcome.retrieval.topLocs.length > 0) {
    bucket.wrongManualAssessed += 1;
    if (outcome.retrieval.wrongManualTop1) bucket.wrongManualTop1 += 1;
  }
  if (outcome.retrieval.chapterHitAt1) bucket.chapterHitAt1 += 1;
  if (outcome.expectNotCovered) {
    bucket.notCoveredItems += 1;
    if (outcome.retrieval.notCovered) bucket.notCoveredSignalled += 1;
    if (outcome.answer?.fabricatedMeasurement) bucket.fabrications += 1;
  }
  bucket.mustIncludeStrings += outcome.mustInclude.length;
  bucket.mustIncludePresentInContext += outcome.retrieval.presentInContext.length;
  if (outcome.answer) {
    bucket.answered += 1;
    if (!outcome.answer.ok) bucket.answerErrors += 1;
    if (outcome.answer.servedFromCache === true) bucket.answerCacheHits += 1;
    if (outcome.answer.hitRequestTimeout) bucket.answerTimeoutStrikes += 1;
    bucket.mustIncludePresent += outcome.answer.present.length;
    if (outcome.answer.ok) bucket.answerPassed += 1;
  }
};

type BucketSummary = {
  items: number;
  retrievalErrors: number;
  hitAt1: number;
  hitAt3: number;
  wrongManualTop1: number | null;
  chapterHitAt1: number;
  mustIncludeRecall: number | null;
  mustIncludeRecallInContext: number | null;
  notCoveredRecall: number | null;
  fabrications: number;
  answered: number;
  answerErrors: number;
  answerCacheHits: number;
  answerTimeoutStrikes: number;
  answerItemPassRate: number | null;
};

const summarise = (bucket: Bucket): BucketSummary => ({
  items: bucket.items,
  retrievalErrors: bucket.retrievalErrors,
  hitAt1: Number(ratio(bucket.hitAt1, bucket.items).toFixed(4)),
  hitAt3: Number(ratio(bucket.hitAt3, bucket.items).toFixed(4)),
  wrongManualTop1:
    bucket.wrongManualAssessed > 0
      ? Number(ratio(bucket.wrongManualTop1, bucket.wrongManualAssessed).toFixed(4))
      : null,
  chapterHitAt1: Number(ratio(bucket.chapterHitAt1, bucket.items).toFixed(4)),
  mustIncludeRecall:
    bucket.answered > 0 && bucket.mustIncludeStrings > 0
      ? Number(ratio(bucket.mustIncludePresent, bucket.mustIncludeStrings).toFixed(4))
      : null,
  mustIncludeRecallInContext:
    bucket.mustIncludeStrings > 0
      ? Number(ratio(bucket.mustIncludePresentInContext, bucket.mustIncludeStrings).toFixed(4))
      : null,
  notCoveredRecall:
    bucket.notCoveredItems > 0 ? Number(ratio(bucket.notCoveredSignalled, bucket.notCoveredItems).toFixed(4)) : null,
  fabrications: bucket.fabrications,
  answered: bucket.answered,
  answerErrors: bucket.answerErrors,
  answerCacheHits: bucket.answerCacheHits,
  answerTimeoutStrikes: bucket.answerTimeoutStrikes,
  answerItemPassRate: bucket.answered > 0 ? Number(ratio(bucket.answerPassed, bucket.answered).toFixed(4)) : null,
});

const percentiles = (values: number[]): { p50: number; p95: number; max: number } => {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
};

/* -------------------------------------------------------------------------- */
/* Gates                                                                       */
/* -------------------------------------------------------------------------- */

type GateResult = {
  name: string;
  scope: string;
  threshold: number;
  actual: number | null;
  pass: boolean;
  skipped: boolean;
  detail: string;
};

const atLeast = (name: string, scope: string, actual: number | null, threshold: number, detail: string): GateResult => ({
  name,
  scope,
  threshold,
  actual,
  pass: actual !== null && actual >= threshold,
  skipped: actual === null,
  detail,
});

/** Latency is a ceiling, not a floor. Being faster than the budget is a pass. */
const atMost = (name: string, scope: string, actual: number | null, threshold: number, detail: string): GateResult => ({
  name,
  scope,
  threshold,
  actual,
  pass: actual !== null && actual <= threshold,
  skipped: actual === null,
  detail,
});

/* -------------------------------------------------------------------------- */
/* Output helpers                                                              */
/* -------------------------------------------------------------------------- */

const pct = (value: number | null): string => (value === null ? "   n/a" : `${(value * 100).toFixed(1)}%`);

const table = (headers: string[], rows: string[][]): void => {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length))
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join("  ").trimEnd();
  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
};

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

const parseArgs = () => {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const sampleArg = args.find((arg) => arg.startsWith("--answer-sample="));
  const parsedSample = sampleArg ? Number.parseInt(sampleArg.split("=")[1] ?? "", 10) : Number.NaN;
  return {
    answerSample: Number.isFinite(parsedSample) && parsedSample > 0 ? parsedSample : 12,
    noAnswerPath: flags.has("--no-answer-path"),
    allowMissingLlm: flags.has("--allow-missing-llm"),
    allowItemFailures: flags.has("--allow-item-failures"),
  };
};

const run = async () => {
  const startedAt = Date.now();
  const options = parseArgs();
  const golden = loadGolden();
  const thresholds = loadThresholds();
  const config = getAppConfig();
  const dbPath = path.resolve(process.cwd(), config.MANUALS_DB_PATH);

  if (!fs.existsSync(dbPath)) {
    fail(
      `ESR database not found: ${config.MANUALS_DB_PATH}\n\n` +
        `Nothing can be scored against an empty index. Populate it:\n` +
        `  npm run ingest:esr`
    );
  }
  const dbProbe = probeDb(dbPath);
  if (!dbProbe.ok) {
    fail(
      `ESR database not usable at ${config.MANUALS_DB_PATH}: ${dbProbe.detail}\n\n` +
        `Nothing can be scored against an empty or missing index. Populate it:\n` +
        `  npm run ingest:esr`
    );
  }

  // --- answer path availability -------------------------------------------
  const probe = options.noAnswerPath ? { ok: false, detail: "disabled by --no-answer-path" } : await probeOllama();
  const runAnswerPath = probe.ok;
  const answerPathStatus: "measured" | "unavailable" | "disabled" = options.noAnswerPath
    ? "disabled"
    : probe.ok
      ? "measured"
      : "unavailable";

  if (!runAnswerPath) {
    const remedy = options.noAnswerPath
      ? "answer path was disabled with --no-answer-path"
      : "start Ollama (`ollama serve`) and pull the configured chat model";
    console.warn(
      `\n[eval-esr] ANSWER PATH NOT MEASURED\n` +
        `  ${probe.detail}\n` +
        `  mustInclude recall cannot be scored. To fix: ${remedy}.\n` +
        (options.allowMissingLlm
          ? `  --allow-missing-llm was passed, so mustIncludeRecall is reported as SKIPPED, not passed.\n`
          : `  Re-run with --allow-missing-llm to waive it deliberately.\n`)
    );
  }

  // --- deterministic item selection --------------------------------------
  const items = [...golden.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const answerTargets = runAnswerPath
    ? (() => {
        const byKind = new Map<EvalKind, EvalItem[]>();
        for (const item of items) {
          const list = byKind.get(item.kind) ?? [];
          list.push(item);
          byKind.set(item.kind, list);
        }
        const kinds: EvalKind[] = ["figure-fact", "section-fact", "unanswerable"];
        // Round-robin across kinds so the LLM sample covers all three behaviours.
        const picked: EvalItem[] = [];
        let round = 0;
        while (picked.length < options.answerSample) {
          let added = false;
          for (const kind of kinds) {
            const list = byKind.get(kind) ?? [];
            if (round < list.length && picked.length < options.answerSample) {
              picked.push(list[round] as EvalItem);
              added = true;
            }
          }
          if (!added) break;
          round += 1;
        }
        return new Set(picked.map((item) => item.id));
      })()
    : new Set<string>();

  // --- run ----------------------------------------------------------------
  const outcomes: ItemOutcome[] = [];
  const runStarted = Date.now();
  for (const [index, item] of items.entries()) {
    const outcome = await evaluateItem(item, dbPath, answerTargets.has(item.id));
    outcomes.push(outcome);
    const marks = [
      outcome.retrieval.ok ? null : "E",
      outcome.retrieval.hitAt1 ? "1" : ".",
      outcome.retrieval.hitAt3 ? "3" : ".",
      outcome.answer ? (outcome.answer.ok ? "a" : "A") : " ",
    ].filter(Boolean);
    process.stderr.write(
      `\r[eval-esr] ${String(index + 1).padStart(3)}/${items.length} ` +
        `${outcome.id.padEnd(10)} ${marks.join("")} ` +
        `${((Date.now() - runStarted) / 1000).toFixed(0)}s   `
    );
  }
  process.stderr.write("\r".padEnd(90) + "\r");

  // --- aggregate ----------------------------------------------------------
  const overall = emptyBucket();
  const byKindBuckets = new Map<EvalKind, Bucket>();
  for (const outcome of outcomes) {
    fold(overall, outcome);
    const bucket = byKindBuckets.get(outcome.kind) ?? emptyBucket();
    fold(bucket, outcome);
    byKindBuckets.set(outcome.kind, bucket);
  }

  const retrievalLatency = outcomes.map((outcome) => outcome.retrieval.latencyMs);
  const answersMeasured = outcomes
    .map((outcome) => outcome.answer)
    .filter((answer): answer is AnswerOutcome => answer !== null);
  // A served-from-cache answer measures SQLite, not the pipeline: its latency
  // is a cache-hit artefact, and mixing it into the percentiles lets a warm
  // cache read as a fast model. Only cold answers describe the answer path.
  const coldAnswers = answersMeasured.filter((answer) => answer.servedFromCache !== true);
  const answerLatency = coldAnswers.map((answer) => answer.latencyMs);
  const answerColdN = coldAnswers.length;

  // --- gates --------------------------------------------------------------
  const gates: GateResult[] = [];
  gates.push(
    atLeast(
      "itemCount",
      "overall",
      outcomes.length,
      thresholds.gates.minItems,
      `a set smaller than ${thresholds.gates.minItems} is not a measurement`
    )
  );

  const floorFor = (map: Record<string, number>, kind: EvalKind): number | undefined => {
    const value = map[kind] ?? map.overall;
    return typeof value === "number" ? value : undefined;
  };

  for (const kind of ["figure-fact", "section-fact", "unanswerable"] as EvalKind[]) {
    const bucket = byKindBuckets.get(kind);
    if (!bucket || bucket.items === 0) continue;
    if (kind === "unanswerable") continue;
    const summary = summarise(bucket);
    const gate1 = floorFor(thresholds.gates.hitAt1, kind);
    const gate3 = floorFor(thresholds.gates.hitAt3, kind);
    if (gate1 !== undefined) {
      gates.push(atLeast("hitAt1", kind, summary.hitAt1, gate1, `${summary.hitAt1} of ${summary.items}`));
    }
    if (gate3 !== undefined) {
      gates.push(atLeast("hitAt3", kind, summary.hitAt3, gate3, `${summary.hitAt3} of ${summary.items}`));
    }
  }

  // The whole set is gated as well as each category. A per-kind-only gate set
  // would let the mix of goldens change the verdict without anything regressing.
  const overallSummary = summarise(overall);
  if (typeof thresholds.gates.hitAt1.overall === "number") {
    gates.push(
      atLeast(
        "hitAt1",
        "overall",
        overallSummary.hitAt1,
        thresholds.gates.hitAt1.overall,
        `${overallSummary.hitAt1} of ${overallSummary.items}`
      )
    );
  }
  if (typeof thresholds.gates.hitAt3.overall === "number") {
    gates.push(
      atLeast(
        "hitAt3",
        "overall",
        overallSummary.hitAt3,
        thresholds.gates.hitAt3.overall,
        `${overallSummary.hitAt3} of ${overallSummary.items}`
      )
    );
  }

  const answerSummary = summarise(overall);
  gates.push(
    atLeast(
      "mustIncludeRecall",
      "answerText",
      answerSummary.mustIncludeRecall,
      thresholds.gates.mustIncludeRecall,
      answerSummary.mustIncludeRecall === null
        ? "no answers were produced, so recall is unmeasured"
        : `${answerSummary.mustIncludeRecall} of required strings present across ${overall.answered} answers`
    )
  );

  const unanswerableBucket = byKindBuckets.get("unanswerable");
  const unanswerableSummary = unanswerableBucket ? summarise(unanswerableBucket) : null;
  gates.push(
    atLeast(
      "notCoveredRecall",
      "unanswerable",
      unanswerableSummary?.notCoveredRecall ?? null,
      thresholds.gates.notCoveredRecall,
      unanswerableSummary === null
        ? "no unanswerable items in the golden set"
        : `${unanswerableSummary.notCoveredRecall} of ${unanswerableSummary.items} out-of-scope questions signalled as not covered`
    )
  );

  const retrievalLatencySummary = percentiles(retrievalLatency);
  gates.push(
    atMost(
      "retrievalLatencyP50",
      "overall",
      retrievalLatencySummary.p50,
      thresholds.gates.maxRetrievalLatencyMs.p50,
      `${retrievalLatencySummary.p50} ms, budget ${thresholds.gates.maxRetrievalLatencyMs.p50} ms`
    )
  );
  gates.push(
    atMost(
      "retrievalLatencyP95",
      "overall",
      retrievalLatencySummary.p95,
      thresholds.gates.maxRetrievalLatencyMs.p95,
      `${retrievalLatencySummary.p95} ms, budget ${thresholds.gates.maxRetrievalLatencyMs.p95} ms`
    )
  );

  const modelPathRate =
    overall.answered > 0 ? 1 - overall.answerTimeoutStrikes / overall.answered : null;
  gates.push(
    atLeast(
      "answerModelPathRate",
      "answerText",
      modelPathRate,
      thresholds.gates.minAnswerModelPathRate,
      modelPathRate === null
        ? "no answers, so the model path rate is unmeasured"
        : `${overall.answered - overall.answerTimeoutStrikes} of ${overall.answered} answers came from the model, ` +
            `${overall.answerTimeoutStrikes} fell back to extractive after hitting REQUEST_TIMEOUT_MS ` +
            `(${config.REQUEST_TIMEOUT_MS} ms)`
    )
  );

  gates.push({
    name: "answerPathMeasured",
    scope: "harness",
    threshold: thresholds.gates.requireAnswerPath ? 1 : 0,
    actual: runAnswerPath ? 1 : 0,
    pass: runAnswerPath || !thresholds.gates.requireAnswerPath,
    skipped: false,
    detail: runAnswerPath
      ? `measured on ${overall.answered} items`
      : `NOT measured: ${probe.detail}. mustIncludeRecall is reported as skipped rather than passed.`,
  });

  // --- dashboard ----------------------------------------------------------
  const kindOrder: EvalKind[] = ["figure-fact", "section-fact", "unanswerable"];
  console.log(`\n[eval-esr] golden set  data/eval/golden.json`);
  console.log(`[eval-esr] ${golden.counts.total} items, human-verified=${golden.generatedFrom.humanVerified}`);
  console.log(`[eval-esr] thresholds data/eval/thresholds.json`);
  console.log(
    `[eval-esr] answer path ${answerPathStatus} (${probe.detail}) — ${overall.answered} of ${outcomes.length} items answered, ` +
      `${overall.answerCacheHits} served from the query cache`
  );
  if (overall.answered > 0 && overall.answerTimeoutStrikes > 0) {
    console.log(
      `[eval-esr] WARNING ${overall.answerTimeoutStrikes} of ${overall.answered} answers took at least ` +
        `2x REQUEST_TIMEOUT_MS (${config.REQUEST_TIMEOUT_MS} ms). pipeline.answerQuestion retries the model ` +
        `call, so those answers came from the extractive fallback, not the LLM. These numbers describe ` +
        `the fallback path. Raise REQUEST_TIMEOUT_MS or use a smaller model to measure the model path.`
    );
  }
  console.log("");

  const rows: string[][] = [];
  for (const kind of kindOrder) {
    const summary = byKindBuckets.has(kind) ? summarise(byKindBuckets.get(kind) as Bucket) : null;
    if (!summary) continue;
    rows.push([
      kind,
      String(summary.items),
      String(summary.retrievalErrors),
      pct(summary.hitAt1),
      pct(summary.hitAt3),
      pct(summary.chapterHitAt1),
      pct(summary.mustIncludeRecall),
      summary.notCoveredRecall === null ? "n/a" : pct(summary.notCoveredRecall),
      String(summary.answered),
    ]);
  }
  rows.push([
    "OVERALL",
    String(overallSummary.items),
    String(overallSummary.retrievalErrors),
    pct(overallSummary.hitAt1),
    pct(overallSummary.hitAt3),
    pct(overallSummary.chapterHitAt1),
    pct(overallSummary.mustIncludeRecall),
    overallSummary.notCoveredRecall === null ? "n/a" : pct(overallSummary.notCoveredRecall),
    String(overallSummary.answered),
  ]);
  table(
    ["category", "items", "errs", "hit@1", "hit@3", "chap@1", "mustInc", "notCov", "answered"],
    rows
  );

  console.log("");
  console.log(
    `retrieval latency ms  p50 ${retrievalLatencySummary.p50}  p95 ${retrievalLatencySummary.p95}  max ${retrievalLatencySummary.max}`
  );
  const answerLatencySummary = percentiles(answerLatency);
  console.log(
    `answer    latency ms (cold n=${answerColdN} of ${overall.answered} answers)  p50 ${answerLatencySummary.p50}  p95 ${answerLatencySummary.p95}  max ${answerLatencySummary.max}`
  );
  if (overall.answered > 0 && answerColdN < 8) {
    console.log(
      `[eval-esr] WARNING only ${answerColdN} of ${overall.answered} answers were cold ` +
        `(the rest were served from the query cache). Cold percentiles over fewer than 8 ` +
        `samples are noise: clear stale cache rows or re-run after a pipeline change to ` +
        `measure the real answer path.`
    );
  }
  console.log(
    `wrong-manual top-1: ${overallSummary.wrongManualTop1 === null ? "n/a" : pct(overallSummary.wrongManualTop1)} ` +
      `of answerable items (${overall.wrongManualTop1}/${overall.wrongManualAssessed} ` +
      `put a wrong manual's page at rank 1; reported, not gated)`
  );
  console.log(
    `mustInclude strings present in retrieved context: ${
      overall.mustIncludePresentInContext
    }/${overall.mustIncludeStrings} (${pct(ratio(overall.mustIncludePresentInContext, overall.mustIncludeStrings))})`
  );

  console.log("");
  console.log("gates");
  for (const gate of gates) {
    const mark = gate.skipped ? "SKIP" : gate.pass ? "PASS" : "FAIL";
    const actual = gate.actual === null ? "n/a" : String(gate.actual);
    console.log(
      `  ${mark}  ${`${gate.name}[${gate.scope}]`.padEnd(30)} actual=${actual.padEnd(8)} threshold=>=${String(
        gate.threshold
      ).padEnd(8)} ${gate.detail}`
    );
  }

  const failedItems = outcomes.filter((outcome) => !outcome.passed);
  console.log("");
  console.log(
    `item pass/fail  ${outcomes.length - failedItems.length} pass / ${failedItems.length} fail` +
      (thresholds.rationale.itemPassRate
        ? `  (item-level pass rate is reported, not gated; gates are on the metrics above)`
        : "")
  );
  for (const outcome of failedItems.slice(0, 15)) {
    console.log(`  FAIL ${outcome.id} (${outcome.kind}) ${outcome.question}`);
    for (const reason of outcome.failureReasons) console.log(`       - ${reason}`);
  }
  if (failedItems.length > 15) {
    console.log(`  ... ${failedItems.length - 15} more failures; see data/eval/report.json`);
  }

  // --- report -------------------------------------------------------------
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    harness: "scripts/eval-esr.ts",
    goldenSet: {
      path: "data/eval/golden.json",
      items: golden.counts.total,
      byKind: golden.counts.byKind,
      humanVerified: golden.generatedFrom.humanVerified,
    },
    thresholds: thresholds.gates,
    answerPath: {
      status: answerPathStatus,
      detail: probe.detail,
      waived: options.allowMissingLlm,
      sampleSize: overall.answered,
      coldSampleSize: answerColdN,
      servedFromCache: overall.answerCacheHits,
      requestTimeoutMs: config.REQUEST_TIMEOUT_MS,
      requestTimeoutStrikes: overall.answerTimeoutStrikes,
      errors: overall.answerErrors,
    },
    database: { path: config.MANUALS_DB_PATH },
    metrics: {
      overall: overallSummary,
      byKind: Object.fromEntries(
        kindOrder
          .filter((kind) => byKindBuckets.has(kind))
          .map((kind) => [kind, summarise(byKindBuckets.get(kind) as Bucket)])
      ),
    },
    latencyMs: { retrieval: retrievalLatencySummary, answer: answerLatencySummary },
    gates,
    items: outcomes,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n[eval-esr] report -> data/eval/report.json`);

  // A gate with no measurement has not passed. It is reported as SKIP, never as
// PASS, and `requireAnswerPath` decides whether an unmeasurable answer path is
// itself a failure.
const failed = gates.filter((gate) => !gate.pass && !gate.skipped);
const skippedGates = gates.filter((gate) => gate.skipped);
const failedHarness = failed.filter((gate) => gate.name === "answerPathMeasured");
const failedMetrics = failed.filter((gate) => gate.name !== "answerPathMeasured");

const operator = (gate: GateResult) =>
  gate.name.startsWith("retrievalLatency") ? "<=" : ">=";

if (failed.length > 0 || skippedGates.length > 0) {
  if (failedMetrics.length > 0) {
    console.error("");
    console.error(
      `[eval-esr] GATE FAILURE — ${failedMetrics.length} metric gate(s) below threshold:`
    );
    for (const gate of failedMetrics) {
      console.error(
        `  ${gate.name}[${gate.scope}] = ${gate.actual ?? "n/a"}, required ${operator(gate)} ${gate.threshold}  ${gate.detail}`
      );
    }
  }
  if (failedHarness.length > 0) {
    console.error("");
    console.error("[eval-esr] HARNESS FAILURE — the harness could not measure what it was asked to measure:");
    for (const gate of failedHarness) {
      console.error(`  ${gate.name}: ${gate.detail}`);
    }
  }
  if (skippedGates.length > 0) {
    console.error("");
    console.error(
      `[eval-esr] ${skippedGates.length} gate(s) SKIPPED, not passed: ` +
        skippedGates.map((gate) => gate.name).join(", ")
    );
  }
  console.error(`  full detail in data/eval/report.json`);
  process.exitCode = 1;
  return;
}
console.log(`\n[eval-esr] all ${gates.length} gates passed`);
};

run().catch((error) => {
  console.error("[eval-esr] harness crashed:", error);
  process.exitCode = 1;
});