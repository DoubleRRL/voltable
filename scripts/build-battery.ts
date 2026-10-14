/**
 * Build the comprehensive question battery for SME review.
 *
 * Mines the real index across an aspect x manual grid, plus targeted mining
 * of every failure class the planner corrections have revealed (meters/sockets,
 * closest/spacing, set/installed, pdu, guy sizing, pole class, fuse tables,
 * Grade-A conditions, the 16.8-vs-4.0 distractor pattern). Hand-curated rows
 * verify their gold locations against the index and fail loud if the text
 * is not there — a battery row must never assert an unverified reference.
 *
 * Every row carries the system's own best guess (retrieval top pages +
 * coverage as the confidence proxy; full answers with --answer-path) so the
 * reviewer reacts to something concrete. Guesses are UNVERIFIED by
 * construction and labeled as such in the review page.
 *
 * Output: data/eval/battery.json (gitignored raw material — validated rows
 * graduate into tracked real.jsonl only via SME answers, never directly).
 *
 * Usage:
 *   tsx scripts/build-battery.ts                  # mine + retrieval guesses (fast)
 *   tsx scripts/build-battery.ts --answer-path    # + full answers (slow, checkpointed, resumable)
 *   tsx scripts/build-battery.ts --limit 12       # smoke test
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { getAppConfig } from "@/lib/env";
import { retrieveChunks } from "@/lib/rag/retrieval";

type BatteryRow = {
  id: string;
  aspect: string;
  manual: string;
  question: string;
  thread?: Array<{ role: string; text: string }>;
  guess_ref: Array<{ docId: string; page: number }>;
  guess_coverage: number;
  guess_notCovered: boolean;
  guess_answer?: string;
  guess_direct?: string;
  guess_grounding?: string;
  /** True when the system's own guess already looks weak — review these first. */
  suspicious: boolean;
  notes: string;
};

type Draft = {
  aspect: string;
  manual: string;
  question: string;
  thread?: Array<{ role: string; text: string }>;
  notes: string;
};

/* Deterministic RNG so the battery is byte-identical across runs on one DB. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * Section-derived topics must name a thing, not a number: "2.1 General"
 * and "Table 10–3" make nonsense questions ("Can I approve 2.1 general?").
 * Strip leading section numbers, then require real words.
 */
const cleanTopic = (section: string | null, fallback: string): string | null => {
  const text = collapse(section ?? fallback)
    .replace(/^(figure|table)\b[^:]{0,50}:?\s*/i, "")
    .replace(/^[\d.()\-–\s]+/, "")
    .replace(/^[a-z]\.\s+/i, "")
    .replace(/\s*›\s*/g, " ")
    .trim();
  const words = text.split(" ").filter((w) => /[a-z]{3,}/i.test(w));
  if (words.length < 2) return null;
  if (/^(general|scope|introduction|overview|notes?)$/i.test(words[0] as string)) return null;
  if (!words.some((w) => w.length >= 5)) return null;
  return text.slice(0, 60);
};

const db = (): Database.Database => {
  const config = getAppConfig();
  const dbPath = path.resolve(process.cwd(), config.MANUALS_DB_PATH);
  return new Database(dbPath, { readonly: true, fileMustExist: true });
};

const chunkText = (
  dbc: Database.Database,
  docId: string,
  page: number,
  like: string
): string | null => {
  const row = dbc
    .prepare(
      `SELECT text FROM chunks WHERE doc_id = ? AND page = ?
        AND lower(text) LIKE ? ORDER BY length(text) DESC LIMIT 1`
    )
    .get(docId, page, `%${like.toLowerCase()}%`) as { text: string } | undefined;
  return row ? collapse(row.text) : null;
};

/** Fail loud: a curated gold must exist in the index with the expected words. */
const requireGold = (
  dbc: Database.Database,
  docId: string,
  page: number,
  mustContain: string[]
): void => {
  const row = dbc
    .prepare(
      `SELECT text FROM chunks WHERE doc_id = ? AND page = ?`
    )
    .all(docId, page) as Array<{ text: string }>;
  const blob = row.map((r) => r.text.toLowerCase()).join("\n");
  for (const needle of mustContain) {
    if (!blob.includes(needle.toLowerCase())) {
      throw new Error(
        `gold verification failed: ${docId}:${page} lacks "${needle}" — refusing to file an unverified reference`
      );
    }
  }
};

/* ------------------------------------------------------------------ */
/* Mined drafts                                                         */
/* ------------------------------------------------------------------ */

const mineTableLookups = (dbc: Database.Database, push: (d: Draft) => void): void => {
  // Tables with real data rows: ask for a row key in planner words.
  // Per-manual quota: a global LIMIT lets ads+doh starve the rest.
  const manuals = ["esr", "ads", "doh", "plm", "ugs"];
  const rng = mulberry32(42);
  for (const docId of manuals) {
    const rows = dbc
      .prepare(
        `SELECT page, section, text FROM chunks
          WHERE doc_id = ? AND chunk_type = 'table'
            AND length(text) > 300 AND length(text) < 4000
          ORDER BY page LIMIT 60`
      )
      .all(docId) as Array<{ page: number; section: string | null; text: string }>;
    const shuffled = [...rows].sort(() => rng() - 0.5);
    let added = 0;
    for (const t of shuffled) {
      if (added >= 8) break;
      const dataRows = t.text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("|") && !/^[|\s:=-]+$/.test(l) && !/EFFECTIVE DATE/i.test(l));
      if (dataRows.length < 2) continue;
      // Row key = first cell with a measurement or code. No fallback: a
      // lookup table without a measurable key (phone directories, office
      // lists) makes a nonsense question ("What does the table give for
      // Bodie?"), so skip the table instead of asking about a proper noun.
      const cells = dataRows[1].split("|").map((c) => c.trim()).filter(Boolean);
      const key = cells.find((c) => /(\d|"|ft|in\b)/.test(c));
      // Bare enumerations ("2.", "(a)") are list markers, not row keys.
      if (!key || /^[\d.)(\s]+$/.test(key) || key.length < 3) continue;
      const topic = cleanTopic(t.section, "the table");
      if (!topic) continue;
      push({
        aspect: "table-lookup",
        manual: docId,
        question: `What does the table give for ${key} on ${topic}?`,
        notes: `mined table ${docId}:${t.page}; row key "${key.slice(0, 40)}"`,
      });
      push({
        aspect: "table-lookup",
        manual: docId,
        question: `lookup ${key} — ${topic.toLowerCase()} table value?`,
        notes: `messy twin of the row above; shorthand + fragment`,
      });
      added += 1;
    }
  }
};

const CONDITIONAL_RE =
  /\b(if|where|when|for|except)\b[^.]{0,120}\b(shall|must|grade|required|prohibited|limited)\b/i;

const mineConditionals = (dbc: Database.Database, push: (d: Draft) => void): void => {
  const manuals = ["esr", "ads", "doh", "plm", "ugs"];
  const rng = mulberry32(7);
  for (const docId of manuals) {
    const rows = dbc
      .prepare(
        `SELECT page, section, text FROM chunks
          WHERE doc_id = ? AND chunk_type = 'text'
            AND length(text) BETWEEN 150 AND 600
          ORDER BY page LIMIT 500`
      )
      .all(docId) as Array<{ page: number; section: string | null; text: string }>;
    const seen = new Set<number>();
    const shuffled = [...rows].sort(() => rng() - 0.5);
    let added = 0;
    for (const r of shuffled) {
      if (added >= 8) break;
      if (!CONDITIONAL_RE.test(r.text)) continue;
      if (seen.has(r.page)) continue;
      seen.add(r.page);
      const topic = cleanTopic(r.section, "the rule");
      if (!topic) continue;
      push({
        aspect: "conditional",
        manual: docId,
        question: `What applies for ${topic.toLowerCase()} — are there conditions?`,
        notes: `conditional prose ${docId}:${r.page}; does the answer carry the condition or flatten it?`,
      });
      added += 1;
    }
  }
};

const SHARED_TOPICS = [
  "clearance",
  "disconnect",
  "anchor",
  "grounding",
  "spacing",
  "guy",
  "meter",
  "transformer",
  "fuse",
  "pole",
];

const mineCrossManual = (dbc: Database.Database, push: (d: Draft) => void): void => {
  for (const topic of SHARED_TOPICS) {
    const rows = dbc
      .prepare(
        `SELECT doc_id AS docId, count(*) AS n FROM chunks_fts f
          JOIN chunks c ON c.id = f.chunk_id
          WHERE chunks_fts MATCH ? GROUP BY doc_id ORDER BY n DESC`
      )
      .all(`"${topic}"`) as Array<{ docId: string; n: number }>;
    if (rows.length < 2) continue;
    const manuals = rows.map((r) => r.docId);
    push({
      aspect: "cross-manual",
      manual: manuals[0] as string,
      question: `What does the ${manuals[0].toUpperCase()} specify for ${topic}?`,
      notes: `"${topic}" lives in ${manuals.join(", ")} — does the answer stay in the named manual?`,
    });
    push({
      aspect: "cross-manual",
      manual: "mixed",
      question: `${topic} requirements?`,
      notes: `bare-topic fragment for "${topic}" (${manuals.join(", ")}) — which manual wins, and is it the right one?`,
    });
  }
};

const mineApprovals = (dbc: Database.Database, push: (d: Draft) => void): void => {
  const manuals = ["esr", "ads", "doh", "plm", "ugs"];
  const rng = mulberry32(11);
  for (const docId of manuals) {
    const rows = dbc
      .prepare(
        `SELECT page, section, text FROM chunks
          WHERE doc_id = ? AND chunk_type = 'text' AND length(text) BETWEEN 120 AND 500
          AND (lower(text) LIKE '%shall%' OR lower(text) LIKE '%must%' OR lower(text) LIKE '%required%' OR lower(text) LIKE '%prohibited%')
          AND (lower(text) GLOB '*[0-9]*feet*' OR lower(text) GLOB '*[0-9]*inches*' OR lower(text) GLOB '*[0-9]* ft *' OR lower(text) GLOB '*[0-9]*"*')
          ORDER BY page LIMIT 100`
      )
      .all(docId) as Array<{ page: number; section: string | null; text: string }>;
    const picked = [...rows].sort(() => rng() - 0.5).slice(0, 6);
    for (const r of picked) {
      const topic = cleanTopic(r.section, "this work");
      if (!topic) continue;
      push({
        aspect: "approval",
        manual: docId,
        question: `Can I approve ${topic.toLowerCase()} as described?`,
        notes: `normative+measure chunk ${docId}:${r.page} — permission must come from the rule, not nearby topic`,
      });
    }
  }
};

/* ------------------------------------------------------------------ */
/* Curated drafts (gold verified against the index)                      */
/* ------------------------------------------------------------------ */

type Curated = {
  aspect: string;
  manual: string;
  question: string;
  thread?: Array<{ role: string; text: string }>;
  gold: Array<{ docId: string; page: number; mustContain: string[] }>;
  notes: string;
};

const CURATED: Curated[] = [
  // --- vocabulary gaps (planner slang -> formal rule words) ---
  {
    aspect: "vocabulary-gap", manual: "ugs",
    question: "wut clearence for a pdu in the parkway?",
    gold: [{ docId: "ugs", page: 515, mustContain: ["pad-mounted", "clearance"] }],
    notes: "pdu slang + typo; needs padmount + clearance vocabulary",
  },
  {
    aspect: "vocabulary-gap", manual: "ugs",
    question: "What clearance applies for pad-mounted equipment in the parkway?",
    gold: [{ docId: "ugs", page: 515, mustContain: ["pad-mounted", "clearance"] }],
    notes: "clean twin of the pdu row",
  },
  {
    aspect: "vocabulary-gap", manual: "esr",
    question: "xfmr hummin on the pole, how close can the pri svc drop be?",
    gold: [{ docId: "esr", page: 66, mustContain: ["Clearances", "Service"] }],
    notes: "xfmr/pri/svc shorthand stack",
  },
  // --- unit symbols ---
  {
    aspect: "unit-symbol", manual: "esr",
    question: "how many gauss at 3 ft from a 250A panel?",
    gold: [{ docId: "esr", page: 36, mustContain: ["mG"] }],
    notes: "gauss word vs mG symbol; feet vs ft",
  },
  // --- approval conditions ---
  {
    aspect: "approval", manual: "plm",
    question: "can i put a edison-only pole in and call it grade A?",
    gold: [{ docId: "plm", page: 30, mustContain: ["Grade A"] }],
    notes: "joint-pole conditional flattened? Edison-only must NOT get Grade A",
  },
  // --- follow-ups with thread ---
  {
    aspect: "follow-up", manual: "esr",
    question: "what about for 200 A?",
    thread: [
      { role: "user", text: "What clearance does the ESR specify for 100 A service?" },
      { role: "assistant", text: "The minimum clearance for 100 A service is 3 feet." },
    ],
    gold: [{ docId: "esr", page: 29, mustContain: ["200"] }],
    notes: "anaphoric follow-up; referent (service clearance) lives in the thread",
  },
  {
    aspect: "follow-up", manual: "esr",
    question: "and if its joint use?",
    thread: [
      { role: "user", text: "What construction grade applies to this pole?" },
      { role: "assistant", text: "Grade B applies to Edison-only poles." },
    ],
    gold: [{ docId: "ads", page: 9, mustContain: ["Grade A"] }],
    notes: "pronoun-free fragment follow-up; needs thread merge",
  },
  // --- refusals: in-corpus vocabulary, no answer ---
  {
    aspect: "refusal", manual: "mixed",
    question: "what are the recloser settings for a 12kv branch?",
    gold: [],
    notes: "recloser has NO drawing and no settings in any manual — must refuse, not invent",
  },
  {
    aspect: "refusal", manual: "mixed",
    question: "steel stub pole dimensions for a 45ft replacement?",
    gold: [],
    notes: "referenced in PLM but never drawn or dimensioned — must refuse",
  },
  {
    aspect: "refusal", manual: "mixed",
    question: "what torque for the transformer lid bolts?",
    gold: [],
    notes: "plausible-sounding hardware detail absent from all five manuals",
  },
  // --- figure / visual subjects (the 4 carousel figures) ---
  {
    aspect: "figure-visual", manual: "ads",
    question: "show me the omni-rupter switch",
    gold: [{ docId: "ads", page: 65, mustContain: ["Omni"] }],
    notes: "visual intent: switch figure subject",
  },
  {
    aspect: "figure-visual", manual: "doh",
    question: "what does a pole-top transformer hookup look like?",
    gold: [{ docId: "doh", page: 69, mustContain: ["Transformer"] }],
    notes: "visual intent: transformer figure subject",
  },
  {
    aspect: "figure-visual", manual: "ads",
    question: "sidewalk guy assembly?",
    gold: [{ docId: "ads", page: 140, mustContain: ["Sidewalk"] }],
    notes: "visual intent: sidewalk guy figure subject",
  },
  {
    aspect: "figure-visual", manual: "ads",
    question: "double arming brackets diagram?",
    gold: [{ docId: "ads", page: 126, mustContain: ["Bracket"] }],
    notes: "visual intent: brackets figure subject",
  },
  // --- multi-facet ---
  {
    aspect: "multi-facet", manual: "esr",
    question: "can i approve a panel upgrade 2 ft from the property line?",
    gold: [{ docId: "esr", page: 52, mustContain: ["property"] }],
    notes: "upgrade framing + setback substance split across chunks (joint-coverage territory)",
  },
  // --- unit traps ---
  {
    aspect: "unit-trap", manual: "esr",
    question: "riser bend radius in feet for the 30 inch dimension?",
    gold: [{ docId: "esr", page: 36, mustContain: ["30"] }],
    notes: "ft-vs-in confusion bait; verifier must catch cross-unit fabrication",
  },
  // --- sheet vs page citations ---
  {
    aspect: "sheet-page", manual: "doh",
    question: "which sheet covers anchor guy zone of proximity?",
    gold: [{ docId: "doh", page: 61, mustContain: ["AC 370"] }],
    notes: "DOH sheet identity (AC 370), not a page number",
  },
  {
    aspect: "sheet-page", manual: "ugs",
    question: "PME structure sheet?",
    gold: [{ docId: "ugs", page: 416, mustContain: ["SS 540"] }],
    notes: "UGS sheet identity (SS 540); PME abbreviation",
  },
  // --- the two live planner failures (already filed as real-015..018; regenerated here for the battery) ---
  {
    aspect: "vocabulary-gap", manual: "mixed",
    question: "closest new anchor to existing one?",
    gold: [
      { docId: "ads", page: 148, mustContain: ["plate anchors"] },
      { docId: "plm", page: 74, mustContain: ["anchors"] },
    ],
    notes: "fragment twin of the anchor-spacing failure; 4 ft lives here",
  },
  {
    aspect: "vocabulary-gap", manual: "esr",
    question: "meters before disconnect needed?",
    gold: [{ docId: "esr", page: 147, mustContain: ["six meter"] }],
    notes: "fragment twin of the disconnect failure; 6 lives here",
  },
];

const typoOf = (rng: () => number, text: string): string => {
  const words = text.split(" ").filter((w) => w.length >= 5 && /^[a-z]+$/i.test(w));
  if (words.length === 0) return text;
  const pick = words[Math.floor(rng() * words.length)] as string;
  const i = 1 + Math.floor(rng() * (pick.length - 2));
  const typo = pick.slice(0, i) + pick.slice(i + 1);
  return text.replace(pick, typo);
};

/* ------------------------------------------------------------------ */
/* Build                                                                */
/* ------------------------------------------------------------------ */

const main = async (): Promise<void> => {
  const args = new Set(process.argv.slice(2));
  if (args.has("--page")) {
    // Render the review page: template + battery rows inlined (single file,
    // works from file:// — no fetch, no network, no build).
    const templatePath = path.resolve(process.cwd(), "scripts/battery-page.html");
    const dataPath = path.resolve(process.cwd(), "data/eval/battery.json");
    const outPath = path.resolve(process.cwd(), "data/eval/battery.html");
    const template = fs.readFileSync(templatePath, "utf8");
    if (!template.includes("/*__DATA__*/")) {
      throw new Error("battery-page.html template lost its /*__DATA__*/ placeholder");
    }
    const data = JSON.parse(fs.readFileSync(dataPath, "utf8")) as { rows?: unknown[] };
    if (!Array.isArray(data.rows) || data.rows.length === 0) {
      throw new Error(`no rows in ${dataPath} — run build-battery.ts first`);
    }
    // Escape a literal </script> inside row text so the inline JSON cannot
    // break out of its script tag.
    const payload = JSON.stringify(data).replace(/<\/script/gi, "<\\/script");
    fs.writeFileSync(outPath, template.replace("/*__DATA__*/", () => payload));
    console.log(`[build-battery] page: ${data.rows.length} rows -> ${outPath}`);
    return;
  }
  const withAnswers = args.has("--answer-path");
  const limitArg = [...args].find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number.parseInt(limitArg.split("=")[1] ?? "", 10) : 0;
  const dbc = db();

  const drafts: Draft[] = [];
  const push = (d: Draft): void => {
    drafts.push(d);
  };
  mineTableLookups(dbc, push);
  mineConditionals(dbc, push);
  mineCrossManual(dbc, push);
  mineApprovals(dbc, push);

  // Curated rows (gold verified) + one deterministic typo twin each for clean rows.
  const rng = mulberry32(99);
  for (const c of CURATED) {
    for (const g of c.gold) {
      requireGold(dbc, g.docId, g.page, g.mustContain);
    }
    push({
      aspect: c.aspect,
      manual: c.manual,
      question: c.question,
      thread: c.thread,
      notes: c.notes,
    });
    if (!c.thread && /^[A-Z]/.test(c.question) && c.question.includes("?")) {
      const twin = typoOf(rng, c.question);
      if (twin !== c.question) {
        push({
          aspect: "typo-shorthand",
          manual: c.manual,
          question: twin,
          notes: `deterministic typo twin of: ${c.question.slice(0, 50)}`,
        });
      }
    }
  }

  // Dedupe on normalized question, cap per cell, deterministic order.
  const seenQ = new Set<string>();
  const cellCount = new Map<string, number>();
  const CELL_CAP = 6;
  const ordered = [...drafts]
    .sort((a, b) =>
      a.aspect < b.aspect ? -1 : a.aspect > b.aspect ? 1 : a.question < b.question ? -1 : 1
    )
    .filter((d) => {
      const key = d.question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seenQ.has(key)) return false;
      seenQ.add(key);
      const cell = `${d.aspect}:${d.manual}`;
      const n = cellCount.get(cell) ?? 0;
      if (n >= CELL_CAP) return false;
      cellCount.set(cell, n + 1);
      return true;
    });
  const sliced = limit > 0 ? ordered.slice(0, limit) : ordered;
  console.log(`[build-battery] ${drafts.length} drafts -> ${sliced.length} rows`);

  const outPath = path.resolve(process.cwd(), "data/eval/battery.json");
  let existing: BatteryRow[] = [];
  if (withAnswers && fs.existsSync(outPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(outPath, "utf8")) as { rows?: BatteryRow[] };
      existing = prev.rows ?? [];
    } catch {
      existing = [];
    }
  }
  const existingByQ = new Map(existing.map((r) => [r.question, r]));

  const { answerQuestion } = withAnswers
    ? await import("@/lib/rag/pipeline")
    : ({} as { answerQuestion?: never });

  const rows: BatteryRow[] = [];
  let n = 0;
  for (const [i, d] of sliced.entries()) {
    n += 1;
    const prior = existingByQ.get(d.question);
    if (prior?.guess_answer) {
      rows.push(prior);
      continue;
    }
    const id = `bat-${String(i + 1).padStart(3, "0")}`;
    const retrieval = await retrieveChunks(d.question);
    const top = retrieval.candidates.slice(0, 3).map((c) => {
      const ch = c.chunk as unknown as { docId: string; page: number };
      return { docId: ch.docId, page: ch.page };
    });
    const row: BatteryRow = {
      id,
      aspect: d.aspect,
      manual: d.manual,
      question: d.question,
      ...(d.thread ? { thread: d.thread } : {}),
      guess_ref: top,
      guess_coverage: Number(retrieval.summary.coverage.toFixed(3)),
      guess_notCovered: retrieval.summary.notCovered,
      suspicious:
        retrieval.summary.notCovered ||
        retrieval.summary.coverage < 0.35 ||
        top.length === 0,
      notes: d.notes,
    };
    if (withAnswers && answerQuestion) {
      try {
        const prefix = (d.thread ?? [])
          .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
          .join("\n");
        const ans = await answerQuestion(
          d.question,
          prefix ? { conversationPrefix: prefix } : {}
        );
        row.guess_answer = ans.answer.slice(0, 600);
        row.guess_direct = ans.directAnswer;
        row.guess_grounding = ans.grounding;
      } catch (error) {
        row.guess_answer = `ANSWER-PATH ERROR: ${String(error).slice(0, 120)}`;
      }
      if (n % 10 === 0) {
        fs.writeFileSync(outPath, JSON.stringify({ version: 1, rows }, null, 2));
        console.log(`[build-battery] checkpoint ${n}/${sliced.length}`);
      }
    }
    rows.push(row);
    if (!withAnswers) {
      process.stdout.write(`\r[build-battery] ${n}/${sliced.length}`);
    }
  }
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        rows,
      },
      null,
      2
    )
  );
  const susp = rows.filter((r) => r.suspicious).length;
  console.log(
    `\n[build-battery] wrote ${rows.length} rows -> ${outPath} (${susp} suspicious)`
  );
  dbc.close();
};

main().catch((error) => {
  console.error("[build-battery] FATAL:", error);
  process.exit(1);
});
