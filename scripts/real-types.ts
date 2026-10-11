/**
 * Shared shape of data/eval/real.jsonl (Phase 1 failure-capture harness).
 *
 * Gold locations are {docId, page} pairs, never bare page numbers: page 20
 * exists in all five manuals (esr, ads, doh, plm, ugs), so a bare page is an
 * ambiguous address. See src/lib/rag/docs.ts.
 */

export type RealBucket =
  | "typo-shorthand"
  | "unit-symbol"
  | "vocabulary-gap"
  | "truncated-table"
  | "wrong-manual"
  | "dropped-condition"
  | "not-in-manuals";

export type RealThreadTurn = { role: string; text: string };

export type RealRow = {
  id: string;
  question: string;
  thread?: RealThreadTurn[];
  gold: Array<{ docId: string; page: number }>;
  mustInclude: string[];
  mustNotSay: string[];
  bucket: RealBucket;
  source: string;
  /** Set on perturbed variants; absent on base rows. */
  parentId?: string;
  /** Perturbation kind label; absent on base rows. */
  perturb?: string;
};

const BUCKETS: RealBucket[] = [
  "typo-shorthand",
  "unit-symbol",
  "vocabulary-gap",
  "truncated-table",
  "wrong-manual",
  "dropped-condition",
  "not-in-manuals",
];

export const isRealRow = (value: unknown): value is RealRow => {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.question === "string" &&
    Array.isArray(row.gold) &&
    Array.isArray(row.mustInclude) &&
    Array.isArray(row.mustNotSay) &&
    typeof row.bucket === "string" &&
    (BUCKETS as string[]).includes(row.bucket as string) &&
    typeof row.source === "string"
  );
};

/**
 * Merge a follow-up question with its thread, mirroring pipeline.ts
 * `buildRetrievalQuery`: short or anaphoric questions search the tail
 * conversation (last user turns plus the last assistant answer, where the
 * referent lives) instead of the dangling words literally. Duplicated as a
 * pure function so the retrieval-only harness resolves threads exactly the
 * way the answer path does, without importing the pipeline.
 */
const ANAPHORA = /\b(it|they|them|he|she|him|her|its|their|theirs)\b/i;

export const buildRetrievalQuery = (
  question: string,
  thread: RealThreadTurn[] | undefined
): string => {
  const prefix = (thread ?? [])
    .map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.text}`)
    .join("\n")
    .trim();
  const words = question.trim().split(/\s+/).filter(Boolean);
  if (!prefix || (words.length >= 6 && !ANAPHORA.test(question))) {
    return question;
  }
  const lines = [...prefix.matchAll(/^(?:User|Assistant):\s*(.+)$/gim)].map((m) =>
    m[1].trim()
  );
  const tail = lines.slice(-3).join(" ");
  return `${tail} ${question}`.trim().slice(0, 1200);
};
