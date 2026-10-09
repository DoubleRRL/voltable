/**
 * Derive the golden eval set from the ESR's own content. No human writes these.
 *
 * The manual is organised into cohesive chapters, and a figure's answer lives
 * inside its own chapter almost always. That gives one honest, independent
 * source of truth for two things the old harness got wrong:
 *
 *   - goldPages / goldChapters come from where the figure physically is in the
 *     document, NOT from the retriever's top hit. The retriever can no longer
 *     confirm itself.
 *   - questions are synthesised from the figure's caption and section, and the
 *     answer value is the thing that gets withheld. A question never embeds the
 *     string it expects back, so hit@1 measures retrieval rather than string
 *     equality.
 *
 * Facts are extracted from three places:
 *   1. visual_assets.text_layers_json.ocr  — text OCR'd from inside the figure
 *   2. chunks (body paragraphs)            — values stated in prose
 *   3. a fixed out-of-scope list          — questions the ESR cannot answer
 *
 * Output: data/eval/golden.json, sorted by id, no timestamps. Byte-identical
 * across runs on the same DB.
 *
 * Usage: npm run build:eval
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { getAppConfig } from "@/lib/env";
import type {
  EvalConfidence,
  EvalGoldenFile,
  EvalItem,
  EvalKind,
} from "./eval-set-types";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

type GoldenFile = EvalGoldenFile;

/* -------------------------------------------------------------------------- */
/* Quotas and gates                                                            */
/* -------------------------------------------------------------------------- */

const FIGURE_QUOTA = Number(process.env.EVAL_FIGURE_QUOTA ?? "40");
const SECTION_QUOTA = Number(process.env.EVAL_SECTION_QUOTA ?? "38");
/**
 * Max facts taken from one figure.
 *
 * Sized against the richest figure in the ESR: the magnetic field diagram on
 * page 36 carries four condition/value pairs (100 A and 250 A, at 1 ft and at
 * 3 ft) plus the reduction-percentage pair that goes with them. A cap of 5 lets
 * that figure yield all of them. Any lower and the reduction percentages, which
 * are the condition-pair case the product is most likely to get wrong, are the
 * ones squeezed out.
 */
const MAX_FACTS_PER_FIGURE = 5;
/** Max facts per page, so the set spreads across the manual. */
const MAX_FACTS_PER_PAGE = 5;
/**
 * Minimum OCR length before a figure is trusted to carry a measurable fact.
 * Figure crops transcribe far less text than table crops, so the bar is set
 * where a single number plus its unit and label is the whole content.
 */
const MIN_OCR_CHARS = 80;
const MIN_OCR_DIGITS = 2;

/* -------------------------------------------------------------------------- */
/* Extraction helpers                                                          */
/* -------------------------------------------------------------------------- */

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * Strip the "Figure 1–4:" prefix so the question is not a caption lookup, and
 * reject subjects that carry no information.
 *
 * Ingest writes `String(c.content)` for caption parts, so some captions arrive
 * as the literal string "[object Object]", "Note(s): (image)" or "CONTENTS".
 * Those are worse than no caption at all, so they fall through to the section
 * tail. If that is degenerate too, the figure is skipped rather than turned
 * into a question about nothing.
 */
const DEGENERATE_SUBJECT =
  /^\s*(\[object object\]|note\(s\)?|contents?|figures?|tables?|diagrams?|images?|index|page \d+|chapter|esr[\s–—-]*\d*)\s*[:.]?\s*$/i;

const figureSubject = (caption: string, sectionPath: string | null): string | null => {
  const candidates: string[] = [];

  // Ingest stringifies non-string caption parts, so "[object Object]" fragments
  // arrive inline: "[object Object] [object Object]". Drop them before judging.
  const captionClean = collapse(caption).replace(/\[object object\]/gi, " ");
  const stripped = collapse(captionClean)
    .replace(/^(?:figure|fig\.?|table|diagram|chart)\s*[0-9IVXA-Z]+\s*[–—\-:]?[.:]?\s*/i, "")
    .replace(/[:\-–—]\s*$/, "")
    .replace(/\s*\((?:image|figure|table|diagram|chart)\)\s*$/i, "")
    .trim();
  candidates.push(stripped);

  const sectionTail = sectionPath ? collapse(sectionPath).split(" › ").pop() ?? "" : "";
  const sectionClean = sectionTail.replace(/^\d+(?:\.\d+)*\s*[.):]?\s*/, "").trim();
  candidates.push(sectionClean);

  for (const candidate of candidates) {
    if (candidate.length < 4 || candidate.length > 90) continue;
    if (DEGENERATE_SUBJECT.test(candidate)) continue;
    if (!/[a-z]{3}/i.test(candidate)) continue;
    if (/^\W+$/.test(candidate)) continue;
    return candidate;
  }
  return null;
};

/**
 * The ESR prints some headings in small caps and OCR reads the first letter as
 * lowercase, giving "rESPONSIBILITIES OF SOUTHERN CALIFORNIA EDISON". An
 * all-caps run is normalised to sentence case so the question reads like a
 * question a planner would actually type.
 */
const normalizeTopicCase = (value: string): string => {
  if (!/^[^a-z]*[A-Z][^a-z]*$/.test(value)) return value;
  const lowered = value.toLowerCase();
  return lowered.charAt(0).toUpperCase() + lowered.slice(1);
};

const sectionTopic = (section: string | null): string | null => {
  if (!section) return null;
  const tail = collapse(section).replace(/\[object object\]/gi, " ").split(" › ").pop() ?? "";
  const cleaned = normalizeTopicCase(tail.replace(/^\d+(?:\.\d+)*\s*[.):]?\s*/, "").trim());
  if (cleaned.length < 4) return null;
  if (DEGENERATE_SUBJECT.test(cleaned)) return null;
  const words = cleaned.split(/\s+/).slice(0, 5).join(" ");
  const topic = collapse(words);
  return topic.length >= 4 ? topic : null;
};

type NumericFact = { value: string; number: number; index: number };

const collectNumericFacts = (
  haystack: string,
  unitRe: RegExp
): { all: NumericFact[]; distinct: number[] } => {
  const all: NumericFact[] = [];
  const re = new RegExp(unitRe.source, unitRe.flags.includes("g") ? unitRe.flags : `${unitRe.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = re.exec(haystack)) !== null) {
    const raw = match[1].replace(/,/g, "");
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) continue;
    all.push({ value: match[0], number: parsed, index: match.index });
  }
  const distinct = [...new Set(all.map((f) => f.number))].sort((a, b) => a - b);
  return { all, distinct };
};

const countDigits = (value: string) => (value.match(/\d/g) ?? []).length;

type Draft = {
  question: string;
  mustInclude: string[];
  pattern: string;
  confidence: EvalConfidence;
  notes: string;
};

/** Canonical spelling of a required value, so the matcher has one form. */
const UNIT_DISPLAY: Record<string, string> = {
  inch: "inches",
  foot: "ft",
  degree: "degrees",
};

/**
 * OCR noise guards. A dimension of 0 inches or 130 feet is a transcription
 * artefact, not a rule, and would make the gold wrong. Bare volts and amps are
 * dropped entirely: "600 volts" and "800 amps" appear in ESR page furniture on
 * dozens of pages, so an item asking for them measures nothing.
 */
const UNIT_PLAUSIBILITY: Record<string, { min: number; max: number }> = {
  inch: { min: 1, max: 120 },
  foot: { min: 1, max: 100 },
  degree: { min: 1, max: 90 },
};

/**
 * Per-unit question wording. The unit is what the planner is asking for; the
 * figure subject is the locator. The value itself is never in the question.
 */
const UNIT_QUESTION: Record<string, string> = {
  mG: "what maximum magnetic field reading, in milligauss, does it show for {condition}?",
  inch: "what clearance, in inches, does it call out?",
  foot: "what distance, in feet, does it call out?",
  degree: "what angle, in degrees, does it call out?",
  percent: "what approximate percentage does it state for {condition}?",
};

const percentSubject = (ocr: string): string => {
  if (/\bemf\b|magnetic/i.test(ocr)) return "the EMF reduction";
  if (/reduc|decreas|lower|save|drop/i.test(ocr)) return "the reduction";
  if (/increase|higher|rise/i.test(ocr)) return "the increase";
  return "the stated value";
};

/* -------------------------------------------------------------------------- */
/* figure-fact extraction                                                      */
/* -------------------------------------------------------------------------- */

/** "100 A at 1 ft: MAX B = 96 mG" — a full condition -> value triple on one line. */
const FIELD_AT_DISTANCE_RE =
  /(\d{2,4})\s*A\s*(?:at|@)\s*(\d{1,2}(?:\.\d+)?)\s*(?:ft|feet)\b[^\n]{0,24}?MAX\s*B\s*[=:]?\s*(\d{1,4}(?:\.\d+)?)\s*mG/gi;

const PERCENT_APPROX_RE = /approximately\s+(\d{1,3})\s*(?:percent|%)/gi;

const INCH_RE = /(?<!\d)(\d{1,3}(?:\.\d+)?)\s*(?:inches|inch|in\.|")/g;
const FOOT_RE = /(?<!\d)(\d{1,4}(?:\.\d+)?)\s*(?:ft|feet|foot)\b/g;
/** ESR diagrams mark feet with a prime: 30', 16', 12'. Never a letter before it. */
const FOOT_PRIME_RE = /(?<!\d)(\d{1,3})'/g;
const DEGREE_RE = /(?<!\d)(\d{1,3})(?:\s*(?:degrees|deg\b|°))/g;

/**
 * A limit phrase: "not to exceed 3 ft", "shall not exceed 30 inches".
 *
 * The text in front of the phrase is the condition and the text after it is the
 * value, so this is the one bare-measurement pattern that can carry a real
 * question. The value is withheld; the condition is not.
 */
const LIMIT_RE =
  /(?:not\s+to\s+exceed|shall\s+not\s+exceed|must\s+not\s+exceed|may\s+not\s+exceed|no\s+more\s+than|maximum\s+of|maximum|up\s+to)\s+(\d{1,4}(?:\.\d+)?)\s*(ft|feet|foot|inches|inch|in\.|'|"|%|percent|degrees|°)/gi;

const pad3 = (value: number) => String(value).padStart(3, "0");

type FigureRow = {
  id: string;
  page: number;
  chapter: string | null;
  section_path: string | null;
  caption: string;
  kind: string;
  ocr: string;
};

const factsFromFigure = (row: FigureRow): Draft[] => {
  const drafts: Draft[] = [];
  const ocr = row.ocr;
  const subject = figureSubject(row.caption, row.section_path);
  if (!subject) return drafts;
  const where = `ESR figure "${subject}"`;

  // 1. Field-at-distance triples. Condition in the question, reading withheld.
  const fieldRe = new RegExp(FIELD_AT_DISTANCE_RE.source, FIELD_AT_DISTANCE_RE.flags);
  let fieldMatch: RegExpExecArray | null;
  const seenConditions = new Set<string>();
  while ((fieldMatch = fieldRe.exec(ocr)) !== null && drafts.length < MAX_FACTS_PER_FIGURE) {
    const amps = fieldMatch[1];
    const feet = fieldMatch[2];
    const milligauss = fieldMatch[3].replace(/,/g, "");
    const condition = `a ${amps} A service at ${feet} ft`;
    if (seenConditions.has(condition)) continue;
    seenConditions.add(condition);
    drafts.push({
      question: `In the ${where}, ${UNIT_QUESTION.mG.replace("{condition}", condition)}`,
      mustInclude: [`${milligauss} mG`],
      pattern: "field-at-distance",
      confidence: "high",
      notes:
        `OCR line "${collapse(fieldMatch[0])}" states the condition and the reading together. ` +
        `The reading is withheld from the question; the condition is not.`,
    });
  }
  if (drafts.length >= MAX_FACTS_PER_FIGURE) {
    return drafts;
  }

  // 2. Reduction percentages. All values from the figure are required, so
  //    answering with only one of a condition pair fails on purpose.
  const percentRe = new RegExp(PERCENT_APPROX_RE.source, PERCENT_APPROX_RE.flags);
  const percents: string[] = [];
  let percentMatch: RegExpExecArray | null;
  while ((percentMatch = percentRe.exec(ocr)) !== null) {
    const value = percentMatch[1];
    if (!percents.includes(value)) percents.push(value);
  }
  if (percents.length > 0) {
    drafts.push({
      question: `In the ${where}, ${UNIT_QUESTION.percent.replace(
        "{condition}",
        percentSubject(ocr)
      )}`,
      mustInclude: percents.map((value) => `${value} percent`),
      pattern: "percent-reduction",
      confidence: percents.length > 1 ? "high" : "medium",
      notes:
        `OCR states ${percents.length} percentage value(s): ${percents
          .map((v) => `${v} percent`)
          .join(", ")}. Every one is required, because the figure gives one value per ` +
        `condition and quoting a single one is the condition-pair failure this product must not have.` +
        (percents.length > 1 ? "" : " Only one percentage was transcribed, so this item cannot test the pair."),
    });
  }
  if (drafts.length >= MAX_FACTS_PER_FIGURE) {
    return drafts;
  }

  // 3. Limits. "<condition> not to exceed <value> <unit>" carries its own
  //    condition, so the question is a real question rather than a scavenger hunt.
  for (const line of ocr.split("\n")) {
    if (drafts.length >= MAX_FACTS_PER_FIGURE) break;
    const limitRe = new RegExp(LIMIT_RE.source, LIMIT_RE.flags);
    let limitMatch: RegExpExecArray | null;
    while ((limitMatch = limitRe.exec(line)) !== null && drafts.length < MAX_FACTS_PER_FIGURE) {
      const value = Number(limitMatch[1]);
      const rawUnit = limitMatch[2];
      const unit: keyof typeof UNIT_PLAUSIBILITY | "percent" =
        rawUnit === "%" || rawUnit === "percent"
          ? "percent"
          : rawUnit === "°" || rawUnit === "degrees"
            ? "degree"
            : rawUnit.startsWith("in")
              ? "inch"
              : "foot";
      const bound = UNIT_PLAUSIBILITY[unit];
      if (bound && (value < bound.min || value > bound.max)) continue;
      const before = collapse(line.slice(0, limitMatch.index));
      const condition = before.split(/[.;|]/).pop() ?? "";
      const conditionText = collapse(condition).slice(-70).trim();
      if (conditionText.length < 8) continue;
      const needle =
        unit === "percent" ? `${value} percent` : `${value} ${UNIT_DISPLAY[unit] as string}`;
      drafts.push({
        question: `In the ${where}, what limit is stated when "${conditionText}"?`,
        mustInclude: [needle],
        pattern: "limit-phrase",
        confidence: "medium",
        notes: `OCR line "${collapse(line).slice(0, 160)}" pairs the condition with the limit ` +
          `${needle}. The condition is quoted in the question; the limit is withheld.`,
      });
    }
  }
  if (drafts.length >= MAX_FACTS_PER_FIGURE) {
    return drafts;
  }

  // 4. Bare dimensions. Only when the unit appears exactly once in the OCR, so
  //    "the dimension" has a single defensible answer.
  const bare: Array<{ unit: "inch" | "foot" | "degree"; re: RegExp; label: string }> = [
    { unit: "inch", re: INCH_RE, label: "an inch dimension" },
    { unit: "foot", re: FOOT_RE, label: "a foot dimension" },
    { unit: "foot", re: FOOT_PRIME_RE, label: "a foot dimension written with a prime" },
    { unit: "degree", re: DEGREE_RE, label: "an angle" },
  ];
  for (const { unit, re, label } of bare) {
    const { distinct } = collectNumericFacts(ocr, re);
    if (distinct.length !== 1) continue;
    const value = distinct[0] as number;
    const bound = UNIT_PLAUSIBILITY[unit];
    if (bound && (value < bound.min || value > bound.max)) continue;
    drafts.push({
      question: `In the ${where}, ${UNIT_QUESTION[unit]}`,
      mustInclude: [`${value} ${UNIT_DISPLAY[unit] as string}`],
      pattern: `${unit}-dimension`,
      confidence: "low",
      notes:
        `OCR transcribed exactly one ${label} (${value}). ` +
        `Single-transcription values are the weakest items in this set: an OCR digit error ` +
        `makes the gold wrong. Triage these first.`,
    });
    break;
  }

  return drafts;
};

/* -------------------------------------------------------------------------- */
/* section-fact extraction                                                     */
/* -------------------------------------------------------------------------- */

const SECTION_UNIT_QUESTION: Record<string, string> = {
  inch: "What clearance, in inches, does the ESR specify for {topic}?",
  foot: "What distance, in feet, does the ESR require for {topic}?",
  degree: "What angle, in degrees, does the ESR specify for {topic}?",
  percent: "What percentage does the ESR give for {topic}?",
};

/** Canonical required-value spelling per unit; "inch" must not become "inchs". */
const SECTION_UNIT_DISPLAY: Record<string, string> = {
  inch: "inches",
  foot: "ft",
  degree: "degrees",
  percent: "percent",
};

const SECTION_UNIT_BOUND: Record<string, { min: number; max: number }> = {
  inch: { min: 1, max: 120 },
  foot: { min: 1, max: 100 },
  degree: { min: 1, max: 90 },
  percent: { min: 1, max: 100 },
};

type BodyChunkRow = {
  id: string;
  page: number;
  chapter: string | null;
  section: string | null;
  text: string;
};

const factsFromBodyChunk = (row: BodyChunkRow): Draft | null => {
  const topic = sectionTopic(row.section);
  if (!topic) return null;

  const candidates: Array<{ unit: keyof typeof SECTION_UNIT_QUESTION; re: RegExp }> = [
    { unit: "inch", re: INCH_RE },
    { unit: "foot", re: FOOT_RE },
    { unit: "foot", re: FOOT_PRIME_RE },
    { unit: "degree", re: DEGREE_RE },
    { unit: "percent", re: /(?<!\d)(\d{1,3}(?:\.\d+)?)\s*(?:percent|%)/g },
  ];

  for (const { unit, re } of candidates) {
    const { distinct } = collectNumericFacts(row.text, re);
    if (distinct.length !== 1) continue;
    const value = distinct[0] as number;
    const bound = SECTION_UNIT_BOUND[unit];
    if (value < bound.min || value > bound.max) continue;
    const template = SECTION_UNIT_QUESTION[unit];
    const topicPhrase = topic.charAt(0).toLowerCase() + topic.slice(1);
    return {
      question: template.replace("{topic}", topicPhrase),
      mustInclude: [`${value} ${SECTION_UNIT_DISPLAY[unit] as string}`],
      pattern: `body-${unit}`,
      confidence: "medium",
      notes:
        `Body paragraph in section "${collapse(row.section ?? "")}". ` +
        `The question is anchored on the section heading only; the value is not in the question. ` +
        `Measures section-anchored retrieval, which is easier than free-form phrasing.`,
    };
  }
  return null;
};

/* -------------------------------------------------------------------------- */
/* unanswerable                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately outside an electrical service requirements manual. Each one is
 * about a utility or policy the ESR has no jurisdiction over, so the correct
 * behaviour is to say the ESR does not cover it rather than quote the nearest
 * paragraph and dress it up.
 *
 * Written by a human on purpose: these are the one category where an authored
 * question is the right tool, because the property under test is "no such
 * content exists anywhere", which cannot be derived from the ESR's own text.
 */
const OUT_OF_SCOPE_QUESTIONS: Array<{ question: string; notes: string }> = [
  {
    question: "What is the retail electricity rate in cents per kilowatt-hour on the current SCE tariff?",
    notes: "Pricing is a tariff matter; the ESR is a design and service-requirements document.",
  },
  {
    question: "How much cash back do I get for installing a Level 2 EV charger through the utility rebate program?",
    notes: "Incentive amounts are published in marketing bulletins, not in the ESR.",
  },
  {
    question: "What is the process and timeline for a natural gas service hookup and meter set?",
    notes: "The ESR covers electric service only; gas is a different utility's document.",
  },
  {
    question: "How do I file a federal income tax return for a rental property?",
    notes: "Tax procedure is entirely outside the scope of an ESR.",
  },
  {
    question: "What is the baggage allowance and carry-on size limit for a transatlantic flight?",
    notes: "Airline policy; no plausible ESR collision.",
  },
  {
    question: "What is the deductible on my homeowners insurance policy?",
    notes: "Insurance product terms; no plausible ESR collision.",
  },
  {
    question: "What is the current mortgage interest rate for a 30-year fixed loan?",
    notes: "Financial product pricing; no plausible ESR collision.",
  },
  {
    question: "How much does tuition cost per semester at a state university?",
    notes: "Education pricing; no plausible ESR collision.",
  },
  {
    question: "What is the recommended dosage of ibuprofen for an adult?",
    notes: "Medical advice; a safety case for refusing rather than guessing.",
  },
  {
    question: "What is the population of the county where the service territory office is located?",
    notes: "Demographics; no plausible ESR collision.",
  },
  {
    question: "How long does an immigration visa application take to process?",
    notes: "Government service timelines; no plausible ESR collision.",
  },
  {
    question: "What is the boiling point of water at sea level?",
    notes: "Physics trivia; checks that the system does not attach to any numbers it finds.",
  },
];

/* -------------------------------------------------------------------------- */
/* DB access                                                                   */
/* -------------------------------------------------------------------------- */

const readDb = (dbPath: string) => {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `ESR database not found at ${dbPath}.\n` +
        `Populate it first:  npm run ingest:esr   (renders 282 pages and OCRs figure crops)`
    );
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const count = (db.prepare("SELECT COUNT(1) AS n FROM chunks").get() as { n: number }).n;
  if (count === 0) {
    db.close();
    throw new Error(
      `ESR database at ${dbPath} has 0 chunks — the ingest did not finish.\n` +
        `Re-run:  npm run ingest:esr`
    );
  }
  return { db, chunkCount: count };
};

const loadFigures = (db: Database.Database): FigureRow[] => {
  const rows = db
    .prepare(
      `SELECT id, page, chapter, section_path, caption, kind, text_layers_json
         FROM visual_assets
        ORDER BY page ASC, id ASC`
    )
    .all() as Array<Record<string, unknown>>;

  const out: FigureRow[] = [];
  for (const row of rows) {
    let layers: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(row.text_layers_json ?? "{}")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        layers = parsed as Record<string, unknown>;
      }
    } catch {
      layers = {};
    }
    const ocr = typeof layers.ocr === "string" ? layers.ocr : "";
    out.push({
      id: String(row.id),
      page: Number(row.page),
      chapter: row.chapter ? String(row.chapter) : null,
      section_path: row.section_path ? String(row.section_path) : null,
      caption: String(row.caption ?? ""),
      kind: String(row.kind ?? ""),
      ocr,
    });
  }
  return out;
};

const loadBodyChunks = (db: Database.Database): BodyChunkRow[] => {
  const rows = db
    .prepare(
      `SELECT id, page, chapter, section, text
         FROM chunks
        WHERE chunk_role = 'body' AND evidence_type = 'paragraph'
        ORDER BY page ASC, id ASC`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    page: Number(row.page),
    chapter: row.chapter ? String(row.chapter) : null,
    section: row.section ? String(row.section) : null,
    text: String(row.text ?? ""),
  }));
};

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

const main = () => {
  const config = getAppConfig();
  const dbPath = path.resolve(process.cwd(), config.ESR_DB_PATH);
  const outPath = path.resolve(process.cwd(), "data/eval/golden.json");

  const { db, chunkCount } = readDb(dbPath);
  const figures = loadFigures(db);
  const bodyChunks = loadBodyChunks(db);
  db.close();

  const skipReasons = new Map<string, number>();
  const skip = (reason: string) => {
    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
  };

  const perPage = new Map<number, number>();
  const pageSeq = new Map<number, number>();
  const seenQuestions = new Set<string>();
  const items: EvalItem[] = [];

  const dedupeKey = (question: string) =>
    question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const pageBudgetLeft = (page: number) => (perPage.get(page) ?? 0) < MAX_FACTS_PER_PAGE;

  // --- figure-fact ---------------------------------------------------------
  let figuresUsed = 0;
  let figuresSkippedNoOcr = 0;
  for (const figure of figures) {
    const ocr = figure.ocr.trim();
    if (ocr.length === 0) {
      figuresSkippedNoOcr += 1;
      skip("no ocr transcribed inside the figure");
      continue;
    }
    if (ocr.length < MIN_OCR_CHARS) {
      skip("ocr too short to carry a measurable fact");
      continue;
    }
    if (countDigits(ocr) < MIN_OCR_DIGITS) {
      skip("ocr has no measurement numbers");
      continue;
    }
    if (figuresUsed >= FIGURE_QUOTA) {
      skip("figure quota reached");
      continue;
    }

    const drafts = factsFromFigure(figure);
    if (drafts.length === 0) {
      skip("no fact pattern matched the ocr");
      continue;
    }

    let taken = 0;
    for (const draft of drafts) {
      if (taken >= MAX_FACTS_PER_FIGURE) break;
      if (items.filter((i) => i.kind === "figure-fact").length >= FIGURE_QUOTA) break;
      if (!pageBudgetLeft(figure.page)) {
        skip("page already contributed the maximum number of items");
        break;
      }
      const key = dedupeKey(draft.question);
      if (seenQuestions.has(key)) {
        skip("duplicate question");
        continue;
      }
      seenQuestions.add(key);
      perPage.set(figure.page, (perPage.get(figure.page) ?? 0) + 1);
      const seq = (pageSeq.get(figure.page) ?? 0) + 1;
      pageSeq.set(figure.page, seq);
      taken += 1;
      figuresUsed += 1;
      items.push({
        id: `ff-${pad3(figure.page)}-${String(seq).padStart(2, "0")}`,
        question: draft.question,
        goldChapters: figure.chapter ? [figure.chapter] : [],
        goldPages: [figure.page],
        mustInclude: draft.mustInclude,
        kind: "figure-fact",
        notes: `${draft.notes} Asset ${figure.id} (${figure.kind}).`,
        confidence: draft.confidence,
        pattern: draft.pattern,
        sourceId: figure.id,
      });
    }
  }

  // --- section-fact -------------------------------------------------------
  let sectionsUsed = 0;
  for (const chunk of bodyChunks) {
    if (sectionsUsed >= SECTION_QUOTA) break;
    const draft = factsFromBodyChunk(chunk);
    if (!draft) continue;
    const key = dedupeKey(draft.question);
    if (seenQuestions.has(key)) continue;
    seenQuestions.add(key);
    sectionsUsed += 1;
    items.push({
      id: `sf-${pad3(chunk.page)}-${String(sectionsUsed).padStart(2, "0")}`,
      question: draft.question,
      goldChapters: chunk.chapter ? [chunk.chapter] : [],
      goldPages: [chunk.page],
      mustInclude: draft.mustInclude,
      kind: "section-fact",
      notes: `${draft.notes} Chunk ${chunk.id}.`,
      confidence: draft.confidence,
      pattern: draft.pattern,
      sourceId: chunk.id,
    });
  }

  // --- unanswerable -------------------------------------------------------
  OUT_OF_SCOPE_QUESTIONS.forEach((entry, index) => {
    const key = dedupeKey(entry.question);
    if (seenQuestions.has(key)) return;
    seenQuestions.add(key);
    items.push({
      id: `nc-${String(index + 1).padStart(2, "0")}`,
      question: entry.question,
      goldChapters: [],
      goldPages: [],
      mustInclude: [],
      kind: "unanswerable",
      notes: entry.notes,
      confidence: "high",
      pattern: "out-of-scope-authored",
      sourceId: "authored",
      expectNotCovered: true,
    });
  });

  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const byKind: Record<EvalKind, number> = { "figure-fact": 0, "section-fact": 0, unanswerable: 0 };
  const byConfidence: Record<EvalConfidence, number> = { high: 0, medium: 0, low: 0 };
  const chapters = new Set<string>();
  const pages = new Set<number>();
  for (const item of items) {
    byKind[item.kind] += 1;
    byConfidence[item.confidence] += 1;
    item.goldChapters.forEach((chapter) => chapters.add(chapter));
    item.goldPages.forEach((page) => pages.add(page));
  }

  const file: GoldenFile = {
    version: 1,
    description:
      "Golden set for the ESR retrieval evaluation, derived from the manual's own content. " +
      "figure-fact items come from text OCR'd from inside a figure, section-fact items from body " +
      "paragraphs, and unanswerable items are out-of-scope questions the ESR cannot answer. " +
      "Questions withhold the value they expect back, so hit@1 measures retrieval rather than " +
      "string equality. goldPages and goldChapters are the figure's real location in the document, " +
      "so the retriever cannot confirm itself.",
    generatedFrom: {
      dbPath: config.ESR_DB_PATH,
      sources: [
        "visual_assets.text_layers_json.ocr",
        "visual_assets.caption",
        "visual_assets.section_path",
        "chunks (chunk_role='body', evidence_type='paragraph')",
        "authored out-of-scope list (scripts/build-eval-set.ts)",
      ],
      humanVerified: false,
      determinism:
        "No timestamps, ids derived from document position, items sorted by id. " +
        "Re-running against the same database produces a byte-identical file.",
      caveats: [
        "NOT human-verified. mustInclude values are as accurate as the OCR that produced them; " +
          "confidence marks which items a human should check first.",
        "goldPages/goldChapters encode the section-cohesion prior: a figure's answer lives in " +
          "the figure's own chapter almost always. A miss is not always a retriever bug.",
        "section-fact questions are anchored on a section heading, which is an easier retrieval " +
          "problem than free-form phrasing. figure-fact is the harder category.",
        "unanswerable items were authored, not derived, because the property under test is the " +
          "absence of content.",
      ],
    },
    counts: {
      total: items.length,
      byKind,
      byConfidence,
      chapters: [...chapters].sort(),
      pages: pages.size,
    },
    items,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");

  // --- summary ------------------------------------------------------------
  console.log(`[build-eval] db ${dbPath} (${chunkCount} chunks)`);
  console.log(`[build-eval] wrote ${items.length} items -> data/eval/golden.json`);
  console.log("");
  console.log("composition");
  console.log(`  figure-fact   ${String(byKind["figure-fact"]).padStart(3)}`);
  console.log(`  section-fact  ${String(byKind["section-fact"]).padStart(3)}`);
  console.log(`  unanswerable  ${String(byKind["unanswerable"]).padStart(3)}`);
  console.log("");
  console.log("confidence (triaging order for a human reviewer)");
  console.log(`  high    ${String(byConfidence.high).padStart(3)}`);
  console.log(`  medium  ${String(byConfidence.medium).padStart(3)}`);
  console.log(`  low     ${String(byConfidence.low).padStart(3)}`);
  console.log("");
  console.log(
    `coverage: ${file.counts.chapters.length} chapters ` +
      `[${file.counts.chapters.join(", ") || "none"}], ${file.counts.pages} distinct pages`
  );
  console.log("");
  console.log(`figures inspected ${figures.length}`);
  console.log(`  with no OCR at all            ${figuresSkippedNoOcr}`);
  for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  skipped: ${reason.padEnd(46)} ${count}`);
  }
  console.log(`body paragraphs inspected ${bodyChunks.length}`);
};

try {
  main();
} catch (error) {
  console.error("[build-eval] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}