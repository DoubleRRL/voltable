import { getDb, replaceLexiconEntries } from "@/lib/rag/storage";
import { SHORTHAND, UNIT_ALIASES } from "@/lib/rag/lexicon-data";

/**
 * Build the corpus lexicon for the deterministic typo corrector.
 *
 * Usage:
 *   npm run lexicon:build
 *
 * Reads RAW chunk text (not fts5vocab — the FTS5 index tokenizes with
 * `porter unicode61`, so a vocab table would hold stems, not the words
 * planners type) and writes the `lexicon(term, df)` table, where df is the
 * number of chunks containing the term.
 *
 * Works against the EXISTING index without re-ingest: it only reads `chunks`
 * and writes `lexicon`. The ingest path (scripts/ingest-manuals.ts) calls
 * buildLexicon() after writing all manuals so future rebuilds stay in step.
 */

const tokenizeLexicon = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

/**
 * Sheet-ID shapes, mirroring the registry patterns in src/lib/rag/docs.ts
 * (SHEET_NUMBERED.sheet is /^([A-Z]{2,4}\s*\d{2,4})$/, e.g. "AC 370",
 * "SS 540") plus the trailing-letter extension the corpus actually prints
 * ("FC 623P", "CD 123P"). A sheet id tokenizes to two halves ("ac", "370");
 * the combined form ("ac370") is added explicitly so a typed-together id is
 * a known word rather than a correctable unknown.
 */
const SHEET_ID_RE = /\b([A-Za-z]{2,4})\s*(\d{2,4})([A-Za-z])?\b/g;

const sheetTerms = (value: string): string[] => {
  const out: string[] = [];
  for (const m of value.matchAll(SHEET_ID_RE)) {
    const prefix = (m[1] ?? "").toLowerCase();
    const digits = m[2] ?? "";
    const suffix = (m[3] ?? "").toLowerCase();
    if (!prefix || !digits) continue;
    out.push(prefix, digits, `${prefix}${digits}${suffix}`);
  }
  return out;
};

/** Page-numbered chapters ("ESR-3") and sheet standards ("AC 370"). */
const identityTerms = (value: string | null): string[] => {
  if (!value) return [];
  const terms = tokenizeLexicon(value);
  const nospace = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (nospace.length >= 2) terms.push(nospace);
  terms.push(...sheetTerms(value));
  return terms;
};

/**
 * Measurement units, from the shared vocabulary in src/lib/rag/measure.ts
 * (normalizeMeasureUnit) plus the symbols crews type. Corpus text already
 * carries most of these; the explicit list guarantees the rest are known
 * words (never correctable, always correctable-to) even where the corpus only
 * ever prints the symbol.
 */
const UNIT_TERMS = [
  "in", "inch", "inches",
  "ft", "feet", "foot",
  "v", "volt", "volts", "voltage",
  "a", "amp", "amps", "ampere", "amperes", "amperage",
  "kv", "kilovolt", "kilovolts",
  "kw", "kva", "mva",
  "ohm", "ohms",
  "hz", "hertz",
  "mg", "gauss", "milligauss",
  "phase", "ph",
  "percent", "pct",
  "watt", "watts",
];

export const buildLexicon = (): { terms: number; chunks: number; elapsedMs: number } => {
  const started = Date.now();
  const db = getDb();
  const rows = db
    .prepare("SELECT text, section, standard, chapter FROM chunks")
    .all() as {
    text: string;
    section: string | null;
    standard: string | null;
    chapter: string | null;
  }[];

  const df = new Map<string, number>();
  for (const row of rows) {
    const seen = new Set<string>();
    // RAW chunk text plus the section heading: coverage reads the heading
    // with the text, so heading words are typable retrieval words too.
    // Glossary chunks are included like everything else — their terms are
    // corpus words, which is what "glossary terms" means here.
    for (const t of tokenizeLexicon(`${row.section ?? ""}\n${row.text}`)) {
      seen.add(t);
    }
    for (const t of sheetTerms(`${row.section ?? ""}\n${row.text}`)) {
      seen.add(t);
    }
    for (const t of identityTerms(row.standard)) {
      seen.add(t);
    }
    for (const t of identityTerms(row.chapter)) {
      seen.add(t);
    }
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  for (const unit of UNIT_TERMS) {
    if (!df.has(unit)) df.set(unit, 1);
  }
  // Words the system itself injects are known words by construction: every
  // alias key/value (so typed shorthand like "svc"/"pri" is never "corrected"
  // into a nearby word — "svc" is one substitution from "sec", which would
  // send a service question down the secondary path) and every shorthand
  // replacement word. Corpus df wins where the word occurs; otherwise 1.
  const injected = new Set<string>();
  for (const key of Object.keys(UNIT_ALIASES)) injected.add(key.toLowerCase());
  for (const values of Object.values(UNIT_ALIASES)) {
    for (const value of values) injected.add(value.toLowerCase());
  }
  for (const [, replacement] of SHORTHAND) {
    for (const t of tokenizeLexicon(replacement)) injected.add(t);
  }
  for (const term of injected) {
    if (!df.has(term)) df.set(term, 1);
  }

  const entries = [...df.entries()]
    .map(([term, dfCount]) => ({ term, df: dfCount }))
    .sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  replaceLexiconEntries(entries);
  return { terms: entries.length, chunks: rows.length, elapsedMs: Date.now() - started };
};

const main = () => {
  const { terms, chunks, elapsedMs } = buildLexicon();
  console.log(
    `[lexicon] built ${terms} terms from ${chunks} chunks in ${(elapsedMs / 1000).toFixed(1)}s`
  );
};

const invokedDirectly = (process.argv[1] ?? "").endsWith("build-lexicon.ts");
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error("[lexicon] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
