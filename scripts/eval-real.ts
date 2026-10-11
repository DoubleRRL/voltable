/**
 * Retrieval-only scoring for the Phase 1 failure-capture set.
 *
 * No LLM: imports retrieveChunks from src/lib/rag/retrieval.ts and scores
 * each row of data/eval/real.jsonl on {docId, page} pairs. Threads are merged
 * into the query exactly the way pipeline.ts does (see real-types.ts), so a
 * follow-up row measures what the answer path would actually retrieve.
 *
 * Usage:
 *   npm run eval:real              # base file, gated
 *   npm run eval:real -- --perturbed  # perturbed file instead, same gates
 *
 * Gates live in data/eval/thresholds.json under `real` and were set FROM the
 * measured baseline, so the suite is green on arrival. Per-bucket rates are
 * reported, not gated: with 1-4 rows per bucket a floor would be noise.
 */

import fs from "node:fs";
import path from "node:path";

import { retrieveChunks } from "@/lib/rag/retrieval";
import { getAppConfig } from "@/lib/env";
import {
  buildRetrievalQuery,
  isRealRow,
  type RealRow,
} from "./real-types";

const BASE_PATH = path.resolve(process.cwd(), "data/eval/real.jsonl");
const PERTURBED_PATH = path.resolve(
  process.cwd(),
  "data/eval/real.perturbed.jsonl"
);
const THRESHOLDS_PATH = path.resolve(process.cwd(), "data/eval/thresholds.json");
const REPORT_PATH = path.resolve(process.cwd(), "data/eval/real-report.json");

type RealGates = {
  minItems: number;
  hitAt1Overall: number;
  hitAt3Overall: number;
  maxWrongManualTop1Rate: number;
  minRefusalRecall: number;
  minAnswerableCoveredRate: number;
  /** Perturbed-only floor: noise transforms (dropped vowels, fragments) destroy coverage tokens by design, so the base-calibrated floor does not apply. */
  minAnswerableCoveredRatePerturbed?: number;
  maxP95LatencyMs: number;
};

type GateResult = {
  name: string;
  actual: number | null;
  threshold: number;
  operator: ">=" | "<=";
  pass: boolean;
  /** True when the metric had no rows to score (e.g. refusals on a set with no not-in-manuals rows). Skipped gates are neither pass nor fail. */
  skip?: boolean;
  detail: string;
};

const fail = (message: string): never => {
  console.error(`\n[eval-real] FATAL\n\n${message}\n`);
  process.exit(1);
};

const loadRows = (filePath: string): RealRow[] => {
  if (!fs.existsSync(filePath)) {
    fail(
      `Eval file not found: ${path.relative(process.cwd(), filePath)}\n\n` +
        (filePath === PERTURBED_PATH
          ? `Generate it first:\n  tsx scripts/perturb.ts --in data/eval/real.jsonl --out data/eval/real.perturbed.jsonl`
          : `Create data/eval/real.jsonl (Phase 1 seed set) first.`)
    );
  }
  const rows: RealRow[] = [];
  fs.readFileSync(filePath, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        fail(
          `Line ${index + 1} is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (!isRealRow(parsed)) {
        fail(`Line ${index + 1} is not a RealRow (check id/question/gold/bucket).`);
      }
      rows.push(parsed as RealRow);
    });
  if (rows.length === 0) {
    fail(`Eval file has zero rows: ${path.relative(process.cwd(), filePath)}`);
  }
  return rows as RealRow[];
};

const loadGates = (): RealGates | null => {
  if (!fs.existsSync(THRESHOLDS_PATH)) {
    fail(`Thresholds not found: data/eval/thresholds.json`);
  }
  const parsed = JSON.parse(fs.readFileSync(THRESHOLDS_PATH, "utf8")) as {
    real?: { gates?: RealGates };
  };
  return parsed.real?.gates ?? null;
};

type RowOutcome = {
  id: string;
  bucket: string;
  parentId?: string;
  perturb?: string;
  gold: string[];
  latencyMs: number;
  top1: string | null;
  top3: string[];
  top1Coverage: number;
  top1Confidence: number;
  notCovered: boolean;
  hitAt1: boolean;
  hitAt3: boolean;
  wrongManualTop1: boolean;
  answerable: boolean;
};

const locationKey = (docId: string, page: number): string => `${docId}:${page}`;

const percentiles = (values: number[]): { p50: number; p95: number; max: number } => {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
};

const pct = (value: number | null): string =>
  value === null ? "   n/a" : `${(value * 100).toFixed(1)}%`;

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

const run = async (): Promise<void> => {
  const startedAt = Date.now();
  const perturbed = process.argv.slice(2).includes("--perturbed");
  const filePath = perturbed ? PERTURBED_PATH : BASE_PATH;
  const rows = loadRows(filePath);
  const config = getAppConfig();
  const dbPath = path.resolve(process.cwd(), config.MANUALS_DB_PATH);
  if (!fs.existsSync(dbPath)) {
    fail(
      `Manuals database not found: ${config.MANUALS_DB_PATH}\n\nPopulate it:\n  npm run ingest:manuals`
    );
  }

  const outcomes: RowOutcome[] = [];
  for (const [index, row] of rows.entries()) {
    const effective = buildRetrievalQuery(row.question, row.thread);
    const started = Date.now();
    const result = await retrieveChunks(effective, {});
    const latencyMs = Date.now() - started;
    const goldSet = new Set(row.gold.map((g) => locationKey(g.docId, g.page)));
    const goldDocs = new Set(row.gold.map((g) => g.docId));
    const top = result.candidates.slice(0, 3);
    const topKeys = top.map((c) => locationKey(c.chunk.docId, c.chunk.page));
    const first = result.candidates[0];
    outcomes.push({
      id: row.id,
      bucket: row.bucket,
      parentId: row.parentId,
      perturb: row.perturb,
      gold: [...goldSet],
      latencyMs,
      top1: topKeys[0] ?? null,
      top3: topKeys,
      top1Coverage: result.summary.coverage,
      top1Confidence: result.summary.confidence,
      notCovered: result.summary.notCovered,
      hitAt1: topKeys[0] !== undefined && goldSet.has(topKeys[0]),
      hitAt3: topKeys.some((key) => goldSet.has(key)),
      wrongManualTop1:
        first !== undefined &&
        row.gold.length > 0 &&
        !goldDocs.has(first.chunk.docId),
      answerable: row.gold.length > 0,
    });
    process.stderr.write(
      `\r[eval-real] ${String(index + 1).padStart(3)}/${rows.length} ${row.id.padEnd(16)} ` +
        `${((Date.now() - startedAt) / 1000).toFixed(0)}s   `
    );
  }
  process.stderr.write("\r".padEnd(70) + "\r");

  // --- aggregate -----------------------------------------------------------
  const answerable = outcomes.filter((o) => o.answerable);
  const refusals = outcomes.filter((o) => !o.answerable);
  const hitAt1 = answerable.filter((o) => o.hitAt1).length;
  const hitAt3 = answerable.filter((o) => o.hitAt3).length;
  const withCandidates = answerable.filter((o) => o.top1 !== null);
  const wrongManual = answerable.filter((o) => o.wrongManualTop1).length;
  const refusalRecall = refusals.length > 0
    ? refusals.filter((o) => o.notCovered).length / refusals.length
    : null;
  const answerableCovered = answerable.length > 0
    ? answerable.filter((o) => !o.notCovered).length / answerable.length
    : null;

  const byBucket = new Map<string, RowOutcome[]>();
  for (const outcome of outcomes) {
    const list = byBucket.get(outcome.bucket) ?? [];
    list.push(outcome);
    byBucket.set(outcome.bucket, list);
  }

  const histogram = { lt030: 0, b030_045: 0, b045_060: 0, gt060: 0 };
  for (const outcome of outcomes) {
    const coverage = outcome.top1Coverage;
    if (coverage < 0.3) histogram.lt030 += 1;
    else if (coverage < 0.45) histogram.b030_045 += 1;
    else if (coverage <= 0.6) histogram.b045_060 += 1;
    else histogram.gt060 += 1;
  }

  const latency = percentiles(outcomes.map((o) => o.latencyMs));
  const runtimeSec = (Date.now() - startedAt) / 1000;

  const measured = {
    items: outcomes.length,
    answerable: answerable.length,
    refusals: refusals.length,
    hitAt1Overall: ratio(hitAt1, answerable.length),
    hitAt3Overall: ratio(hitAt3, answerable.length),
    wrongManualTop1Rate: ratio(wrongManual, withCandidates.length),
    refusalRecall,
    answerableCoveredRate: answerableCovered,
    latencyMs: latency,
    histogram,
    runtimeSec: Number(runtimeSec.toFixed(1)),
  };

  // --- gates ---------------------------------------------------------------
  const gates = loadGates();
  if (!gates) {
    console.log(`\n[eval-real] no "real" gates in data/eval/thresholds.json — calibration mode`);
    console.log(`[eval-real] measured baseline (wire these into thresholds.json -> real.gates):`);
    console.log(JSON.stringify(measured, null, 2));
    console.log(`\n[eval-real] per-bucket baseline:`);
    for (const [bucket, list] of [...byBucket.entries()].sort()) {
      const answerableList = list.filter((o) => o.answerable);
      console.log(
        `  ${bucket.padEnd(16)} n=${list.length} hit@1=${pct(ratio(answerableList.filter((o) => o.hitAt1).length, answerableList.length))} hit@3=${pct(ratio(answerableList.filter((o) => o.hitAt3).length, answerableList.length))}`
      );
    }
    console.error(`\n[eval-real] CALIBRATION NEEDED — add a "real" section to data/eval/thresholds.json and re-run.`);
    process.exitCode = 2;
    return;
  }

  const gateResults: GateResult[] = [
    {
      name: "itemCount",
      actual: measured.items,
      threshold: gates.minItems,
      operator: ">=",
      pass: measured.items >= gates.minItems,
      detail: `${measured.items} rows scored`,
    },
    {
      name: "hitAt1Overall",
      actual: measured.hitAt1Overall,
      threshold: gates.hitAt1Overall,
      operator: ">=",
      pass: measured.hitAt1Overall !== null && measured.hitAt1Overall >= gates.hitAt1Overall,
      detail: `${hitAt1}/${answerable.length} answerable rows gold at rank 1`,
    },
    {
      name: "hitAt3Overall",
      actual: measured.hitAt3Overall,
      threshold: gates.hitAt3Overall,
      operator: ">=",
      pass: measured.hitAt3Overall !== null && measured.hitAt3Overall >= gates.hitAt3Overall,
      detail: `${hitAt3}/${answerable.length} answerable rows gold in top 3`,
    },
    {
      name: "wrongManualTop1Rate",
      actual: measured.wrongManualTop1Rate,
      threshold: gates.maxWrongManualTop1Rate,
      operator: "<=",
      pass:
        measured.wrongManualTop1Rate !== null &&
        measured.wrongManualTop1Rate <= gates.maxWrongManualTop1Rate,
      detail: `${wrongManual}/${withCandidates.length} answerable rows with candidates topped by another manual`,
    },
    {
      name: "refusalRecall",
      actual: measured.refusalRecall,
      threshold: gates.minRefusalRecall,
      operator: ">=",
      skip: refusals.length === 0,
      pass: measured.refusalRecall !== null && measured.refusalRecall >= gates.minRefusalRecall,
      detail:
        refusals.length === 0
          ? "no not-in-manuals rows in this set (perturbations skip them by design) — gate not applicable"
          : `${refusals.filter((o) => o.notCovered).length}/${refusals.length} not-in-manuals rows flagged notCovered`,
    },
    {
      name: "answerableCoveredRate",
      actual: measured.answerableCoveredRate,
      threshold: perturbed ? (gates.minAnswerableCoveredRatePerturbed ?? gates.minAnswerableCoveredRate) : gates.minAnswerableCoveredRate,
      operator: ">=",
      skip: answerable.length === 0,
      pass:
        measured.answerableCoveredRate !== null &&
        measured.answerableCoveredRate >=
          (perturbed ? (gates.minAnswerableCoveredRatePerturbed ?? gates.minAnswerableCoveredRate) : gates.minAnswerableCoveredRate),
      detail: `${answerable.filter((o) => !o.notCovered).length}/${answerable.length} answerable rows NOT flagged notCovered${perturbed ? " (perturbed floor)" : ""}`,
    },
    {
      name: "retrievalLatencyP95",
      actual: measured.latencyMs.p95,
      threshold: gates.maxP95LatencyMs,
      operator: "<=",
      pass: measured.latencyMs.p95 <= gates.maxP95LatencyMs,
      detail: `p50 ${latency.p50}ms p95 ${latency.p95}ms max ${latency.max}ms over ${outcomes.length} calls`,
    },
  ];

  // --- dashboard -------------------------------------------------------------
  console.log(`\n[eval-real] file ${path.relative(process.cwd(), filePath)} (${perturbed ? "perturbed" : "base"})`);
  console.log(`[eval-real] ${measured.items} rows (${measured.answerable} answerable, ${measured.refusals} refusal) in ${measured.runtimeSec}s`);
  console.log("");
  console.log("bucket             n  hit@1   hit@3   notCovered");
  const bucketOrder = [
    "truncated-table",
    "unit-symbol",
    "typo-shorthand",
    "vocabulary-gap",
    "wrong-manual",
    "dropped-condition",
    "not-in-manuals",
  ];
  for (const bucket of bucketOrder) {
    const list = byBucket.get(bucket);
    if (!list) continue;
    const answerableList = list.filter((o) => o.answerable);
    const hasAnswerable = answerableList.length > 0;
    const red =
      hasAnswerable &&
      ratio(answerableList.filter((o) => o.hitAt1).length, answerableList.length)! <
        gates.hitAt1Overall
        ? "  RED"
        : "";
    console.log(
      `${bucket.padEnd(17)}${String(list.length).padEnd(3)}` +
        `${(hasAnswerable ? pct(ratio(answerableList.filter((o) => o.hitAt1).length, answerableList.length)) : "n/a    ").padEnd(8)}` +
        `${(hasAnswerable ? pct(ratio(answerableList.filter((o) => o.hitAt3).length, answerableList.length)) : "n/a    ").padEnd(8)}` +
        `${list.filter((o) => o.notCovered).length}/${list.length}${red}`
    );
  }
  console.log(
    `OVERALL(answerable) ${hitAt1}/${answerable.length} hit@1=${pct(measured.hitAt1Overall)} hit@3=${pct(measured.hitAt3Overall)}`
  );
  console.log("");
  console.log(
    `coverage gray band (top-1): <0.30:${histogram.lt030}  0.30-0.45:${histogram.b030_045}  0.45-0.60:${histogram.b045_060}  >0.60:${histogram.gt060}`
  );
  console.log(
    `wrong-manual-top1: ${pct(measured.wrongManualTop1Rate)}  refusal recall: ${pct(measured.refusalRecall)}  answerable covered: ${pct(measured.answerableCoveredRate)}`
  );
  console.log(
    `retrieval latency ms: p50 ${latency.p50} p95 ${latency.p95} max ${latency.max} (db: ${config.MANUALS_DB_PATH})`
  );
  console.log("");
  console.log("gates");
  for (const gate of gateResults) {
    const label = gate.skip ? "SKIP" : gate.pass ? "PASS" : "FAIL";
    console.log(
      `  ${label}  ${gate.name.padEnd(22)} actual=${String(gate.actual).padEnd(8)} ${gate.operator} ${gate.threshold}  ${gate.detail}`
    );
  }
  const misses = outcomes.filter((o) => o.answerable && (!o.hitAt1 || o.notCovered));
  if (misses.length > 0) {
    console.log("");
    console.log(`misses (${misses.length}):`);
    for (const miss of misses) {
      console.log(
        `  ${miss.id} [${miss.bucket}] hit@1=${miss.hitAt1} hit@3=${miss.hitAt3} notCovered=${miss.notCovered} wrongManual=${miss.wrongManualTop1} top1=${miss.top1 ?? "none"} gold=${miss.gold.join(",")}`
      );
    }
  }

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    harness: "scripts/eval-real.ts",
    mode: perturbed ? "perturbed" : "base",
    file: path.relative(process.cwd(), filePath),
    database: { path: config.MANUALS_DB_PATH },
    baseline: measured,
    gates,
    gateResults,
    items: outcomes,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n[eval-real] report -> data/eval/real-report.json`);

  const failed = gateResults.filter((g) => !g.skip && !g.pass);
  if (failed.length > 0) {
    console.error(`\n[eval-real] GATE FAILURE — ${failed.length} gate(s) below threshold (see data/eval/real-report.json)`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n[eval-real] all ${gateResults.length} gates passed`);
};

run().catch((error) => {
  console.error("[eval-real] harness crashed:", error);
  process.exitCode = 1;
});
