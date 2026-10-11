/**
 * Deterministic perturbations for data/eval/real.jsonl.
 *
 * Every variant keeps the parent's gold / mustInclude / mustNotSay / bucket
 * and adds `parentId` + a `perturb` kind label, so eval-real.ts scores them
 * against the same truth. Seeded PRNG (mulberry32 over a hash of the parent
 * id): the same input file always produces the same output file.
 *
 * Rows whose bucket is not-in-manuals are skipped: there is no gold to keep,
 * and typoing a refusal question measures nothing.
 *
 * Usage:
 *   tsx scripts/perturb.ts --in data/eval/real.jsonl --out data/eval/real.perturbed.jsonl
 */

import fs from "node:fs";
import path from "node:path";

import { isRealRow, type RealRow } from "./real-types";

export type { RealRow };

/** FNV-1a hash, for seeding per-row PRNGs. */
const hash32 = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** Mulberry32: small deterministic PRNG. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

const pickWordIndex = (words: string[], rand: () => number): number => {
  const eligible = words
    .map((word, index) => ({ word, index }))
    .filter(({ word }) => /[a-z]{4,}/i.test(word));
  if (eligible.length === 0) return -1;
  return eligible[Math.floor(rand() * eligible.length)]!.index;
};

/** Single-char typo: insert a letter, delete a char, or swap two adjacent chars. */
const typoInsert = (question: string, rand: () => number): string | null => {
  const words = question.split(" ");
  const at = pickWordIndex(words, rand);
  if (at < 0) return null;
  const word = words[at]!;
  const pos = Math.floor(rand() * (word.length + 1));
  const letter = LETTERS[Math.floor(rand() * LETTERS.length)]!;
  words[at] = `${word.slice(0, pos)}${letter}${word.slice(pos)}`;
  return words.join(" ");
};

const typoDelete = (question: string, rand: () => number): string | null => {
  const words = question.split(" ");
  const at = pickWordIndex(words, rand);
  if (at < 0) return null;
  const word = words[at]!;
  const pos = Math.floor(rand() * word.length);
  words[at] = word.slice(0, pos) + word.slice(pos + 1);
  return words.join(" ");
};

const typoSwap = (question: string, rand: () => number): string | null => {
  const words = question.split(" ");
  const at = pickWordIndex(words, rand);
  if (at < 0) return null;
  const word = words[at]!;
  if (word.length < 2) return null;
  const pos = Math.floor(rand() * (word.length - 1));
  words[at] =
    word.slice(0, pos) + word[pos + 1] + word[pos] + word.slice(pos + 2);
  return words.join(" ");
};

/** Drop non-initial vowels in words of length 4+: "clearance" -> "clrnc". */
const dropVowels = (question: string): string | null => {
  const out = question
    .split(" ")
    .map((word) =>
      word.length >= 4 ? word[0] + word.slice(1).replace(/[aeiou]/gi, "") : word
    )
    .join(" ");
  return out === question ? null : out;
};

/** Unit-word swaps: feet<->ft, inches<->in. Symbol->word only when the
 *  symbol reads as a unit (a number right before it): bare "in" is far more
 *  often a preposition ("an anchor in an urban area") than a unit, and
 *  rewriting it produces gibberish rather than noise. */
const unitSwaps = (question: string): Array<{ kind: string; text: string }> => {
  const out: Array<{ kind: string; text: string }> = [];
  if (/\bfeet\b/i.test(question)) {
    out.push({ kind: "unit-feet-to-ft", text: question.replace(/\bfeet\b/gi, "ft") });
  }
  if (/\bfoot\b/i.test(question)) {
    out.push({ kind: "unit-foot-to-ft", text: question.replace(/\bfoot\b/gi, "ft") });
  }
  if (/\binches\b/i.test(question)) {
    out.push({ kind: "unit-inches-to-in", text: question.replace(/\binches\b/gi, "in") });
  }
  if (/(\d[\d,.]*\s*)ft\b/i.test(question)) {
    out.push({
      kind: "unit-ft-to-feet",
      text: question.replace(/(\d[\d,.]*\s*)ft\b/gi, "$1feet"),
    });
  }
  if (/(\d[\d,.]*\s*)in\b/i.test(question)) {
    out.push({
      kind: "unit-in-to-inches",
      text: question.replace(/(\d[\d,.]*\s*)in\b/gi, "$1inches"),
    });
  }
  return out;
};

/** Lowercase everything and double the spaces: whitespace/case noise. */
const whitespaceCase = (question: string): string | null => {
  const out = question.toLowerCase().replace(/ /g, "  ").trim();
  return out === question ? null : out;
};

/** Drop a leading interrogative prefix: "what is the" / "wut's the" / "does" ... */
const fragment = (question: string): string | null => {
  const out = question
    .replace(
      /^(what'?s|what|how|when|where|why|which|does|do|is|are|can|could|should|wut'?s|whts|wut)\b[\s,]*(the|a|an|my|your)?\b\s*/i,
      ""
    )
    .trim();
  if (!out || out === question.trim() || out.split(/\s+/).length < 2) return null;
  return out;
};

/**
 * Deterministic ~6-8 variants for one base row. Returns [] for
 * not-in-manuals rows (skipped, not failed).
 */
export const perturbRow = (row: RealRow): RealRow[] => {
  if (row.bucket === "not-in-manuals") return [];
  const rand = mulberry32(hash32(row.id));
  const variants: Array<{ kind: string; text: string }> = [];
  // Dedupe set up front: a swap of a double letter ("ee" -> "ee") is a
  // no-op, so each typo kind retries with fresh randomness until it produces
  // something novel (or runs out of attempts).
  const seen = new Set([row.question]);
  const novel = (fn: (q: string, r: () => number) => string | null): string | null => {
    // No-op transforms (e.g. swapping a double letter) return the parent;
    // retry with fresh randomness. The output loop below owns dedupe.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const text = fn(row.question, rand);
      if (text && text !== row.question && !seen.has(text)) {
        return text;
      }
    }
    return null;
  };

  const insert = novel(typoInsert);
  if (insert) variants.push({ kind: "typo-insert", text: insert });
  const del = novel(typoDelete);
  if (del) variants.push({ kind: "typo-delete", text: del });
  const swap = novel(typoSwap);
  if (swap) variants.push({ kind: "typo-swap", text: swap });

  const novowel = dropVowels(row.question);
  if (novowel) variants.push({ kind: "drop-vowels", text: novowel });

  for (const swapVariant of unitSwaps(row.question)) {
    variants.push(swapVariant);
  }

  const ws = whitespaceCase(row.question);
  if (ws) variants.push({ kind: "whitespace-case", text: ws });

  const frag = fragment(row.question);
  if (frag) variants.push({ kind: "fragment", text: frag });

  // Dedupe against the parent and each other, keep order, cap at 8.
  const out: RealRow[] = [];
  for (const variant of variants) {
    if (seen.has(variant.text)) continue;
    seen.add(variant.text);
    out.push({
      ...row,
      id: `${row.id}-p${String(out.length + 1).padStart(2, "0")}`,
      question: variant.text,
      parentId: row.id,
      perturb: variant.kind,
    });
    if (out.length >= 8) break;
  }
  return out;
};

export const perturbRows = (rows: RealRow[]): RealRow[] => rows.flatMap(perturbRow);

const parseArgs = (): { input: string; output: string } => {
  const args = process.argv.slice(2);
  const at = (flag: string): string | null => {
    const index = args.indexOf(flag);
    return index >= 0 && index + 1 < args.length ? (args[index + 1] as string) : null;
  };
  return {
    input: at("--in") ?? "data/eval/real.jsonl",
    output: at("--out") ?? "data/eval/real.perturbed.jsonl",
  };
};

const readJsonl = (filePath: string): RealRow[] => {
  const absolute = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolute)) {
    console.error(`[perturb] FATAL: input not found: ${filePath}`);
    process.exit(1);
  }
  const rows: RealRow[] = [];
  const lines = fs.readFileSync(absolute, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      console.error(
        `[perturb] FATAL: line ${index + 1} of ${filePath} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      process.exit(1);
    }
    if (!isRealRow(parsed)) {
      console.error(`[perturb] FATAL: line ${index + 1} of ${filePath} is not a RealRow (bad id/question/gold/bucket?).`);
      process.exit(1);
    }
    rows.push(parsed);
  });
  return rows;
};

const runCli = (): void => {
  // Importable without side effects: only run when executed directly.
  const { input, output } = parseArgs();
  const rows = readJsonl(input);
  const skipped = rows.filter((row) => row.bucket === "not-in-manuals").length;
  const variants = perturbRows(rows);
  const absolute = path.resolve(process.cwd(), output);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(
    absolute,
    `${variants.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8"
  );
  console.log(
    `[perturb] ${rows.length} base rows -> ${variants.length} variants ` +
      `(${skipped} not-in-manuals rows skipped) -> ${output}`
  );
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
