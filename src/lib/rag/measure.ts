/**
 * Measurement extraction shared by retrieval scoring and answer verification.
 *
 * Lives here rather than in pipeline.ts because retrieval needs it too and
 * pipeline already imports retrieval — the other direction would be a cycle.
 * One regex, one normalizer, one key function: a question's `1"` and a
 * table's `1-inch` must meet on the same key or lookup questions ("how many
 * guys on a 1-inch anchor") can never find their row. verifyAnswerNumbers'
 * discipline applies unchanged — same number, same unit, no cross-unit
 * conversion.
 */
export type VerifiedMeasurement = { value: number; unit: string };

export const normalizeMeasureUnit = (raw: string): string | null => {
  const u = raw.toLowerCase().replace(/\.$/, "");
  if (["in", "inch", "inches", '"', "″"].includes(u)) return "inches";
  if (["ft", "feet", "foot", "'", "′"].includes(u)) return "feet";
  if (["v", "volt", "volts"].includes(u)) return "volts";
  if (["a", "amp", "amps", "ampere", "amperes"].includes(u)) return "amps";
  if (["%", "percent", "pct"].includes(u)) return "percent";
  return null;
};

const parseMeasureValue = (raw: string): number | null => {
  const s = raw.replace(/\s+/g, "");
  if (s.includes("/")) {
    const [a, b] = s.split("/");
    const n = Number(a) / Number(b);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

export const extractMeasurements = (text: string): VerifiedMeasurement[] => {
  const re =
    /(\d+\s*\/\s*\d+|\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s*(inches|inch|feet|foot|volts|volt|amps|ampere|amperes|amp|percent|pct|%|in\b|ft\b|["'′″])/gi;
  const out: VerifiedMeasurement[] = [];
  for (const m of text.matchAll(re)) {
    const unit = normalizeMeasureUnit(m[2] ?? "");
    const rawNum = (m[1] ?? "").replace(/\s+/g, "");
    const value = /^\d/.test(rawNum) ? parseMeasureValue(rawNum) : WORD_NUMBERS[rawNum.toLowerCase()] ?? null;
    if (unit !== null && value !== null) out.push({ value, unit });
  }
  return out;
};

export const measureKey = (m: VerifiedMeasurement): string => `${m.value} ${m.unit}`;
