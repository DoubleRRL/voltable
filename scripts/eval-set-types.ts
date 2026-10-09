/**
 * Shared shape of data/eval/golden.json.
 *
 * Lives in its own module so scripts/build-eval-set.ts (the writer) and
 * scripts/eval-esr.ts (the reader) cannot drift. It is types only: importing it
 * runs no code, so the reader never triggers a rebuild.
 */

export type EvalKind = "figure-fact" | "section-fact" | "unanswerable";

export type EvalConfidence = "high" | "medium" | "low";

export type EvalItem = {
  id: string;
  question: string;
  goldChapters: string[];
  goldPages: number[];
  mustInclude: string[];
  kind: EvalKind;
  notes: string;
  /**
   * How much a human should trust this item before it is used to gate a
   * release. Derived-from-OCR goldens are not human-verified; triage high
   * confidence first.
   */
  confidence: EvalConfidence;
  expectNotCovered?: true;
  /** Which extractor produced the item, so a bad item can be traced back. */
  pattern: string;
  /** Asset or chunk id in esr.sqlite, for triage. */
  sourceId: string;
};

export type EvalGoldenFile = {
  version: number;
  description: string;
  generatedFrom: {
    dbPath: string;
    sources: string[];
    humanVerified: false;
    determinism: string;
    caveats: string[];
  };
  counts: {
    total: number;
    byKind: Record<EvalKind, number>;
    byConfidence: Record<EvalConfidence, number>;
    chapters: string[];
    pages: number;
  };
  items: EvalItem[];
};

export type EvalGateThresholds = {
  /** Per-category floor, plus an `overall` fallback. */
  hitAt1: Record<string, number>;
  hitAt3: Record<string, number>;
  /** Fraction of required strings that must appear in the answer text. */
  mustIncludeRecall: number;
  /** Fraction of expectNotCovered items that must be signalled as not covered. */
  notCoveredRecall: number;
  /** p50/p95 ceiling in ms for a single retrieveChunks call. */
  maxRetrievalLatencyMs: { p50: number; p95: number };
  /** An eval set smaller than this is not a measurement. */
  minItems: number;
  /**
   * Fraction of answers that must come from the model rather than from the
   * extractive fallback that kicks in when every model retry hits the request
   * timeout. Guards against measuring a different system than the one shipping.
   */
  minAnswerModelPathRate: number;
  /** When true, an unmeasurable answer path fails the run. */
  requireAnswerPath: boolean;
  /** Informational only: the item-level pass rate that a healthy run should beat. */
  itemPassRate: number;
};

export type EvalThresholdsFile = {
  version: number;
  rationale: Record<string, string>;
  gates: EvalGateThresholds;
};