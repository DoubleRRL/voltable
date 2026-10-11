/**
 * Retrieval lexicon data: domain synonyms and planner-shorthand expansions.
 *
 * This is DATA, not code. A new term (a unit synonym, a crew abbreviation, a
 * shorthand shape) is added HERE — never as a new table in retrieval.ts or
 * storage.ts. Both modules import from this file; the hot path does no I/O
 * (no file reads, no database lookups) to use it.
 *
 * Two tables, one owner:
 *  - UNIT_ALIASES: ESR-domain synonyms applied to both the question and the
 *    chunk text at scoring time, so no re-index is needed to benefit.
 *  - SHORTHAND: planner shorthand expanded before tokenizing, on both the
 *    question and the chunk side.
 */

/**
 * ESR-domain synonyms.
 *
 * The ESR writes units as symbols ("mG", "ft", "1φ", "kVA") while users type
 * them as words ("milligauss", "feet", "single phase"), and it writes verdicts
 * as nouns ("Acceptability") while users ask with adjectives ("acceptable",
 * "approved"). Without this the highest-value chunks were unreachable: a
 * question about "milligauss" scored zero coverage against a figure whose
 * only text was "MAX B = 12 mG", and a question asking whether 301A is
 * "acceptable" scored 1/3 against a table whose header says "Acceptability" —
 * so the whole query fell below the coverage gate while two chunks each
 * covered two thirds of it.
 *
 * Applied to both the question and the chunk text at scoring time, so no
 * re-index is needed to benefit.
 */
export const UNIT_ALIASES: Record<string, string[]> = {
  milligauss: ["mg", "maximum"],
  approved: ["acceptable", "acceptability", "approval"],
  acceptable: ["approved", "acceptability", "approval"],
  acceptability: ["acceptable", "approved"],
  approval: ["approved", "acceptable"],
  approvals: ["approved", "acceptable"],
  unapproved: ["unacceptable"],
  pool: ["pools", "swimming"],
  pools: ["pool", "swimming"],
  swimming: ["pool", "pools"],
  // Plurals the corpus never uses: planners ask "guys" and "multiplex",
  // the manuals write "guy" and "duplex/triplex/quadruplex".
  guys: ["guy"],
  guy: ["guys"],
  multiplex: ["duplex", "triplex", "quadruplex"],
  duplex: ["multiplex"],
  triplex: ["multiplex"],
  quadruplex: ["multiplex"],
  // Crew shorthand, per planner vocabulary: oh/ug/pri/sec/svc/str/pad.
  // Short-to-long covers typed shorthand ("pri" against "primary"); the
  // reverse covers OCR and figure callouts that abbreviate ("Pri.", "Svc.").
  // Company name the same way, both directions: the manuals say SCE and
  // Company, planners say Edison. Without it "only edison on the pole"
  // matches pole-marking boilerplate ("Edison Poles" bands) instead of the
  // rule text that governs the pole, because the rule text never says Edison.
  // Deliberately not mapped to "company": that word is everywhere and would
  // dilute rather than aim.
  edison: ["sce"],
  sce: ["edison"],
  pri: ["primary"],
  primary: ["pri"],
  sec: ["secondary"],
  secondary: ["sec"],
  svc: ["service"],
  service: ["svc"],
  str: ["structure", "street"],
  structure: ["str"],
  pad: ["padmount"],
  padmount: ["pad"],
  eqmt: ["equipment"],
  equipment: ["eqmt"],
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
 * Planner shorthand, expanded before tokenizing. A question like "2' from
 * p/l" would otherwise evaporate: the tokenizer drops "2", "p" and "l" as
 * too short, deleting both the distance and the most distinctive noun. The
 * same expansion runs on chunk text at scoring time, so "3'-0"" and "3 feet"
 * meet on the same token. Slash abbreviations are standard utility
 * shorthand, and prime marks are how every planner writes feet and inches.
 */
export const SHORTHAND: Array<[RegExp, string]> = [
  [/\bp\/l\b/gi, "property line"],
  [/\bp\.l\./gi, "property line"],
  [/\bo\/h\b/gi, "overhead"],
  [/\bo\.h\./gi, "overhead"],
  [/\bu\/g\b/gi, "underground"],
  [/\bu\.g\./gi, "underground"],
  [/\boh\b/gi, "overhead"],
  [/\bug\b/gi, "underground"],
  // Pole class shorthand: planners write cl-4, cl 3; the manuals write
  // "Class 4", "Class 3". Bare "cl" is left alone — in drawings it can mean
  // centerline — but cl-plus-a-digit is always a class.
  [/\bcl[-\s]?([1-9])\b/gi, "class $1"],
  // Species shorthand: dftb is Douglas Fir through-bored, written DF-TB
  // (tokenized to df + tb) or spelled out in the manuals.
  [/\bdftb\b/gi, "douglas fir through bored df tb"],
  [/(\d+(?:\.\d+)?)\s*['′]/g, "$1 feet"],
  [/(\d+(?:\.\d+)?)\s*["″]/g, "$1 inches"],
];
