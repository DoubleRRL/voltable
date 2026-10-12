import crypto from "node:crypto";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import type {
  StoredChunk,
  FigureEvidence,
  VisualAsset,
  StoredException,
  VisualAssetTextLayers,
} from "@/lib/rag/types";
import { getAppConfig } from "@/lib/env";
import { SHORTHAND } from "@/lib/rag/lexicon-data";

export type { VisualAsset, StoredException };

type Db = Database.Database;

const createEmbeddingPayload = (embedding: number[]) => JSON.stringify(embedding);

const parseEmbedding = (value: string) => {
  try {
    return JSON.parse(value) as number[];
  } catch {
    return [];
  }
};

const parsePairedIds = (raw: string | null | undefined): string[] => {
  if (!raw || raw === "[]") {
    return [];
  }
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const parseJsonArray = <T>(raw: string | null | undefined, fallback: T[]): T[] => {
  if (!raw) {
    return fallback;
  }
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch {
    return fallback;
  }
};

const parseTextLayers = (raw: string | null | undefined): VisualAssetTextLayers => {
  if (!raw) {
    return {};
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return {};
    }
    const out: VisualAssetTextLayers = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") {
        out[k] = val;
      }
    }
    return out;
  } catch {
    return {};
  }
};

const parseBbox = (raw: string | null): [number, number, number, number] | null => {
  if (!raw) {
    return null;
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (
      Array.isArray(v) &&
      v.length === 4 &&
      v.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return v as [number, number, number, number];
    }
  } catch {
    /* fall through */
  }
  return null;
};

const toStoredChunk = (row: Record<string, unknown>): StoredChunk => ({
  id: String(row.id),
  docId: String(row.doc_id) as StoredChunk["docId"],
  page: Number(row.page),
  chunkType: String(row.chunk_type) as StoredChunk["chunkType"],
  evidenceType: String(row.evidence_type) as StoredChunk["evidenceType"],
  text: String(row.text),
  section: row.section ? String(row.section) : null,
  sectionKey: row.section_key ? String(row.section_key) : null,
  chapter: row.chapter ? String(row.chapter) : null,
  pageLabel: row.page_label ? String(row.page_label) : null,
  standard: row.standard ? String(row.standard) : null,
  sheetOf: row.sheet_of == null ? null : Number(row.sheet_of),
  sheetCount: row.sheet_count == null ? null : Number(row.sheet_count),
  sourceLink: String(row.source_link),
  visualPath: row.visual_path ? String(row.visual_path) : null,
  embedding: parseEmbedding(String(row.embedding_json)),
  createdAt: Number(row.created_at),
  chunkRole: (row.chunk_role ? String(row.chunk_role) : "body") as StoredChunk["chunkRole"],
  visualKind:
    row.visual_kind == null || row.visual_kind === ""
      ? null
      : (String(row.visual_kind) as StoredChunk["visualKind"]),
  pairedChunkIds: parsePairedIds(row.paired_chunk_ids ? String(row.paired_chunk_ids) : null),
  pairGroupId: row.pair_group_id ? String(row.pair_group_id) : null,
});

/** A markdown rule row: `--- | --- |` and its whitespace variants. */
const isMarkdownRule = (line: string): boolean => /^[-|\s:]*[-|:][-|\s:]*$/.test(line);

/** One row of a markdown table as a line of prose: cells joined, pipes gone. */
const plainTableLine = (line: string): string =>
  line
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(" ");

/**
 * Stored exceptions in the ESR's own wording.
 *
 * Ingest left `[object Object]` in front of the table it lifted each exception
 * from, so every stored exception opened with an artefact and a `--- | ---`
 * rule. The artefact and the table scaffolding go; the ESR's words stay. An
 * entry with nothing left is not an exception, so it is dropped rather than
 * shown as an empty one.
 */
const cleanStoredExceptions = (items: StoredException[]): StoredException[] =>
  items
    .map((item) => {
      const text = item.text
        .replace("[object Object]", " ")
        .split("\n")
        .filter((line) => !isMarkdownRule(line))
        .map(plainTableLine)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return text ? { ...item, text } : null;
    })
    .filter((item): item is StoredException => item !== null);

const toVisualAsset = (row: Record<string, unknown>): VisualAsset => ({
  id: String(row.id),
  docId: (row.doc_id ? String(row.doc_id) : "esr") as VisualAsset["docId"],
  page: Number(row.page),
  kind: String(row.kind) as VisualAsset["kind"],
  chapter: row.chapter ? String(row.chapter) : null,
  standard: row.standard ? String(row.standard) : null,
  pageLabel: row.page_label ? String(row.page_label) : null,
  sheetOf: row.sheet_of == null ? null : Number(row.sheet_of),
  sheetCount: row.sheet_count == null ? null : Number(row.sheet_count),
  sectionKey: row.section_key ? String(row.section_key) : null,
  sectionPath: row.section_path ? String(row.section_path) : null,
  caption: String(row.caption ?? ""),
  figureUrl: row.figure_url ? String(row.figure_url) : null,
  thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : null,
  bbox: parseBbox(row.bbox_json ? String(row.bbox_json) : null),
  sourceLink: String(row.source_link ?? ""),
  pairGroupId: row.pair_group_id ? String(row.pair_group_id) : null,
  exceptions: cleanStoredExceptions(
    parseJsonArray<StoredException>(
      row.exceptions_json ? String(row.exceptions_json) : null,
      []
    )
  ),
  supportingChunkIds: parsePairedIds(
    row.supporting_chunk_ids_json ? String(row.supporting_chunk_ids_json) : null
  ),
  textLayers: parseTextLayers(row.text_layers_json ? String(row.text_layers_json) : null),
  createdAt: Number(row.created_at ?? 0),
});

let cachedDb: Db | null = null;

const migrateChunksSchema = (db: Db) => {
  const cols = db.prepare("PRAGMA table_info(chunks)").all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));

  const addColumn = (name: string, def: string) => {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE chunks ADD COLUMN ${name} ${def}`);
      have.add(name);
    }
  };

  addColumn("chunk_role", "TEXT NOT NULL DEFAULT 'body'");
  addColumn("visual_kind", "TEXT");
  addColumn("paired_chunk_ids", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("pair_group_id", "TEXT");
  addColumn("section_key", "TEXT");
  addColumn("chapter", "TEXT");
  addColumn("standard", "TEXT");
  addColumn("sheet_of", "INTEGER");
  addColumn("sheet_count", "INTEGER");
};

const ensureVisualAssetsTable = (db: Db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS visual_assets (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL DEFAULT 'esr',
      page INTEGER NOT NULL,
      kind TEXT NOT NULL,
      chapter TEXT,
      standard TEXT,
      page_label TEXT,
      sheet_of INTEGER,
      sheet_count INTEGER,
      section_key TEXT,
      section_path TEXT,
      caption TEXT NOT NULL DEFAULT '',
      figure_url TEXT,
      thumbnail_url TEXT,
      bbox_json TEXT,
      source_link TEXT NOT NULL DEFAULT '',
      pair_group_id TEXT,
      exceptions_json TEXT NOT NULL DEFAULT '[]',
      supporting_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
      text_layers_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_visual_assets_page ON visual_assets (page);
    CREATE INDEX IF NOT EXISTS idx_visual_assets_section ON visual_assets (section_key);
    CREATE INDEX IF NOT EXISTS idx_visual_assets_pair_group ON visual_assets (pair_group_id);
    CREATE INDEX IF NOT EXISTS idx_visual_assets_chapter ON visual_assets (chapter);
  `);

  const cols = db.prepare("PRAGMA table_info(visual_assets)").all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  for (const [name, def] of [
    ["chapter", "TEXT"],
    ["figure_url", "TEXT"],
    ["bbox_json", "TEXT"],
    ["standard", "TEXT"],
    ["page_label", "TEXT"],
    ["sheet_of", "INTEGER"],
    ["sheet_count", "INTEGER"],
    ["doc_id", "TEXT NOT NULL DEFAULT 'esr'"],
  ] as const) {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE visual_assets ADD COLUMN ${name} ${def}`);
      have.add(name);
    }
  }
};

const ensureFts = (db: Db) => {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_id UNINDEXED,
      text,
      tokenize = 'porter unicode61'
    );
  `);
};

/**
 * Corpus lexicon for the deterministic typo corrector (Phase 2).
 *
 * One row per typable word seen in RAW chunk text — raw, because the FTS5
 * index tokenizes with `porter unicode61`, so an fts5vocab table would hold
 * stems ("field" and "fields" would collapse) rather than the words planners
 * actually type. `df` is the number of chunks containing the term and weights
 * correction ties toward the common word. Populated by
 * `npm run lexicon:build` (scripts/build-lexicon.ts, same builder the ingest
 * path calls), never in the retrieval hot path.
 */
const ensureLexiconTable = (db: Db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lexicon (
      term TEXT PRIMARY KEY,
      df INTEGER NOT NULL
    );
  `);
};

/** Replace the whole lexicon in one transaction. Builder-only. */
export const replaceLexiconEntries = (entries: Array<{ term: string; df: number }>) => {
  const db = getDb();
  const tx = db.transaction(() => {
    db.exec("DELETE FROM lexicon");
    const insert = db.prepare("INSERT INTO lexicon (term, df) VALUES (?, ?)");
    for (const { term, df } of entries) {
      insert.run(term, df);
    }
  });
  tx();
};

/** Every lexicon row, for the corrector's in-memory index. */
export const getLexiconEntries = (): Array<{ term: string; df: number }> => {
  const db = getDb();
  try {
    const rows = db
      .prepare("SELECT term, df FROM lexicon")
      .all() as { term: string; df: number }[];
    return rows.map((r) => ({ term: String(r.term), df: Number(r.df) }));
  } catch {
    // Table predates this database file's creation path; the corrector treats
    // a missing table as an empty lexicon and corrects nothing.
    return [];
  }
};

export const getLexiconCount = (): number => {
  const db = getDb();
  try {
    const row = db.prepare("SELECT COUNT(1) AS count FROM lexicon").get() as {
      count: number;
    };
    return row.count;
  } catch {
    return 0;
  }
};

const getDbPath = () => {
  const config = getAppConfig();
  // The magic comment is on `process.cwd()` so Turbopack treats this as a
  // runtime resolve. Without it the traced path is unknown at build time, the
  // output-file trace pulls in the whole project, and the build warns that the
  // trace was unintentionally wide.
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), config.MANUALS_DB_PATH);
};

export const getDb = () => {
  if (cachedDb) {
    return cachedDb;
  }

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      chunk_type TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      text TEXT NOT NULL,
      section TEXT,
      page_label TEXT,
      source_link TEXT NOT NULL,
      visual_path TEXT,
      embedding_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS query_cache (
      query_hash TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc_page ON chunks (doc_id, page);
    CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks (evidence_type, chunk_type);
  `);

  migrateChunksSchema(db);
  ensureVisualAssetsTable(db);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_pair_group ON chunks (pair_group_id);`);
  ensureLexiconTable(db);

  ensureFts(db);

  try {
    const counts = db
      .prepare(
        `SELECT (SELECT count(*) FROM chunks_fts) AS fts, (SELECT count(*) FROM chunks) AS chunks`
      )
      .get() as { fts: number; chunks: number };
    if (counts.chunks > 0 && counts.fts === 0) {
      db.exec(`INSERT INTO chunks_fts(chunk_id, text) SELECT id, text FROM chunks`);
    }
  } catch {
    /* FTS optional until first rebuild */
  }

  cachedDb = db;
  return db;
};

/**
 * Full FTS rebuild. Only for first build and repair — ingest keeps the index
 * in step per document instead, because a whole-corpus delete plus re-insert
 * on every manual is 20,000 wasted rows and growing.
 */
export const rebuildChunkFtsIndex = () => {
  const db = getDb();
  ensureFts(db);
  db.exec("DELETE FROM chunks_fts");
  db.exec(`
    INSERT INTO chunks_fts(chunk_id, text)
    SELECT id, text FROM chunks
  `);
};


export const upsertChunks = (chunks: StoredChunk[]) => {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO chunks (
      id, doc_id, page, chunk_type, evidence_type, text, section, section_key, page_label,
      standard, sheet_of, sheet_count,
      source_link, visual_path, embedding_json, created_at,
      chunk_role, visual_kind, paired_chunk_ids, pair_group_id, chapter
    ) VALUES (
      @id, @docId, @page, @chunkType, @evidenceType, @text, @section, @sectionKey, @pageLabel,
      @standard, @sheetOf, @sheetCount,
      @sourceLink, @visualPath, @embeddingJson, @createdAt,
      @chunkRole, @visualKind, @pairedChunkIds, @pairGroupId, @chapter
    )
  `);

  const tx = db.transaction((records: StoredChunk[]) => {
    for (const chunk of records) {
      insert.run({
        id: chunk.id,
        docId: chunk.docId,
        page: chunk.page,
        chunkType: chunk.chunkType,
        evidenceType: chunk.evidenceType,
        text: chunk.text,
        section: chunk.section,
        sectionKey: chunk.sectionKey ?? null,
        pageLabel: chunk.pageLabel ?? null,
        standard: chunk.standard ?? null,
        sheetOf: chunk.sheetOf ?? null,
        sheetCount: chunk.sheetCount ?? null,
        sourceLink: chunk.sourceLink,
        visualPath: chunk.visualPath,
        embeddingJson: createEmbeddingPayload(chunk.embedding),
        createdAt: chunk.createdAt,
        chunkRole: chunk.chunkRole ?? "body",
        visualKind: chunk.visualKind ?? null,
        pairedChunkIds: JSON.stringify(chunk.pairedChunkIds ?? []),
        pairGroupId: chunk.pairGroupId ?? null,
        chapter: chunk.chapter ?? null,
      });
    }
  });

  tx(chunks);

  // Keep the FTS index in step with exactly the rows just written. Rebuilding
  // the whole corpus here cost a full 20,000-row delete plus re-insert on
  // every manual ingest; the per-doc delete lives in clearManual, so this is
  // the matching per-doc insert.
  const db2 = getDb();
  const ftsInsert = db2.prepare(
    "INSERT INTO chunks_fts(chunk_id, text) VALUES (?, ?)"
  );
  const ftsTx = db2.transaction((records: StoredChunk[]) => {
    db2.prepare("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)").run(records[0]?.docId ?? "");
    for (const chunk of records) {
      ftsInsert.run(chunk.id, chunk.text);
    }
  });
  if (chunks.length > 0) {
    ftsTx(chunks);
  }
};

export const upsertVisualAssets = (assets: VisualAsset[]) => {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO visual_assets (
      id, doc_id, page, kind, chapter, standard, page_label, sheet_of, sheet_count,
      section_key, section_path, caption,
      figure_url, thumbnail_url, bbox_json, source_link,
      pair_group_id, exceptions_json, supporting_chunk_ids_json, text_layers_json, created_at
    ) VALUES (
      @id, @docId, @page, @kind, @chapter, @standard, @pageLabel, @sheetOf, @sheetCount,
      @sectionKey, @sectionPath, @caption,
      @figureUrl, @thumbnailUrl, @bboxJson, @sourceLink,
      @pairGroupId, @exceptionsJson, @supportingChunkIdsJson, @textLayersJson, @createdAt
    )
  `);

  const tx = db.transaction((records: VisualAsset[]) => {
    for (const asset of records) {
      insert.run({
        id: asset.id,
        docId: asset.docId,
        page: asset.page,
        kind: asset.kind,
        chapter: asset.chapter ?? null,
        standard: asset.standard ?? null,
        pageLabel: asset.pageLabel ?? null,
        sheetOf: asset.sheetOf ?? null,
        sheetCount: asset.sheetCount ?? null,
        sectionKey: asset.sectionKey ?? null,
        sectionPath: asset.sectionPath ?? null,
        caption: asset.caption ?? "",
        figureUrl: asset.figureUrl ?? null,
        thumbnailUrl: asset.thumbnailUrl ?? null,
        bboxJson: asset.bbox ? JSON.stringify(asset.bbox) : null,
        sourceLink: asset.sourceLink ?? "",
        pairGroupId: asset.pairGroupId ?? null,
        exceptionsJson: JSON.stringify(asset.exceptions ?? []),
        supportingChunkIdsJson: JSON.stringify(asset.supportingChunkIds ?? []),
        textLayersJson: JSON.stringify(asset.textLayers ?? {}),
        createdAt: asset.createdAt,
      });
    }
  });

  tx(assets);
};

export const getVisualAssets = (): VisualAsset[] => {
  const db = getDb();
  // Manual first, then page: with five manuals loaded, page 73 exists in all
  // of them and a page-ordered list interleaves unrelated drawings.
  const rows = db
    .prepare("SELECT * FROM visual_assets ORDER BY doc_id ASC, page ASC, id ASC")
    .all() as Record<string, unknown>[];
  return rows.map(toVisualAsset);
};

export const getVisualAssetById = (id: string): VisualAsset | null => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM visual_assets WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toVisualAsset(row) : null;
};

/**
 * Assets linked to the given chunk ids via asset id, pair_group, or supporting ids.
 * Expands pair groups.
 */
export const getAssetsForChunkIds = (chunkIds: string[]): VisualAsset[] => {
  if (chunkIds.length === 0) {
    return [];
  }
  const idSet = new Set(chunkIds);
  const chunks = getStoredChunksByIds(chunkIds);
  for (const c of chunks) {
    if (c.pairGroupId) {
      idSet.add(c.pairGroupId);
    }
    for (const pid of c.pairedChunkIds) {
      idSet.add(pid);
    }
  }

  const all = getVisualAssets();
  const seed = all.filter((asset) => {
    if (idSet.has(asset.id)) {
      return true;
    }
    if (asset.pairGroupId && idSet.has(asset.pairGroupId)) {
      return true;
    }
    return asset.supportingChunkIds.some((sid) => idSet.has(sid));
  });

  const pairGroups = new Set(
    seed.map((a) => a.pairGroupId).filter((g): g is string => Boolean(g))
  );
  const supportingExpand = new Set<string>();
  for (const a of seed) {
    for (const sid of a.supportingChunkIds) {
      supportingExpand.add(sid);
    }
  }

  const expanded = all.filter((asset) => {
    if (seed.some((s) => s.id === asset.id)) {
      return true;
    }
    if (asset.pairGroupId && pairGroups.has(asset.pairGroupId)) {
      return true;
    }
    if (idSet.has(asset.id) || supportingExpand.has(asset.id)) {
      return true;
    }
    return false;
  });

  const seen = new Set<string>();
  const out: VisualAsset[] = [];
  for (const asset of expanded) {
    if (seen.has(asset.id)) {
      continue;
    }
    seen.add(asset.id);
    out.push(asset);
  }
  return out.sort((a, b) => a.page - b.page || a.id.localeCompare(b.id));
};

export type ChunkLight = {
  id: string;
  docId: string;
  page: number;
  chunkType: StoredChunk["chunkType"];
  evidenceType: StoredChunk["evidenceType"];
  text: string;
  section: string | null;
  sectionKey: string | null;
  chapter: string | null;
  pageLabel: string | null;
  standard: string | null;
  sheetOf: number | null;
  sheetCount: number | null;
  sourceLink: string;
  visualPath: string | null;
  createdAt: number;
  chunkRole: StoredChunk["chunkRole"];
  pairedChunkIds: string[];
  pairGroupId: string | null;
};

const toChunkLight = (row: Record<string, unknown>): ChunkLight => ({
  id: String(row.id),
  docId: String(row.doc_id),
  page: Number(row.page),
  chunkType: String(row.chunk_type) as StoredChunk["chunkType"],
  evidenceType: String(row.evidence_type) as StoredChunk["evidenceType"],
  text: String(row.text),
  section: row.section ? String(row.section) : null,
  sectionKey: row.section_key ? String(row.section_key) : null,
  chapter: row.chapter ? String(row.chapter) : null,
  pageLabel: row.page_label ? String(row.page_label) : null,
  standard: row.standard ? String(row.standard) : null,
  sheetOf: row.sheet_of == null ? null : Number(row.sheet_of),
  sheetCount: row.sheet_count == null ? null : Number(row.sheet_count),
  sourceLink: String(row.source_link),
  visualPath: row.visual_path ? String(row.visual_path) : null,
  createdAt: Number(row.created_at),
  chunkRole: (row.chunk_role ? String(row.chunk_role) : "body") as StoredChunk["chunkRole"],
  pairedChunkIds: parsePairedIds(row.paired_chunk_ids ? String(row.paired_chunk_ids) : null),
  pairGroupId: row.pair_group_id ? String(row.pair_group_id) : null,
});

/** Metadata only — no embeddings. Used for keyword prefilter before loading vectors. */
export const getAllChunksLight = (): ChunkLight[] => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, doc_id, page, chunk_type, evidence_type, text, section, section_key, page_label,
        standard, sheet_of, sheet_count, chapter,
        source_link, visual_path, created_at, chunk_role, paired_chunk_ids, pair_group_id
        FROM chunks ORDER BY doc_id ASC, page ASC, id ASC`
    )
    .all() as Record<string, unknown>[];
  return rows.map(toChunkLight);
};

export const getStoredChunksByIds = (ids: string[]): StoredChunk[] => {
  if (ids.length === 0) {
    return [];
  }
  const db = getDb();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`)
    .all(...ids) as Record<string, unknown>[];
  const rank = new Map(ids.map((id, i) => [id, i]));
  return rows
    .map(toStoredChunk)
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
};

/**
 * All chunks sharing a pair group — typically a markdown table, its OCR
 * rendering, and its caption. Used to reunite a table stub with the OCR flow
 * that actually carries its numbers.
 */
export const getChunksByPairGroup = (pairGroupId: string): StoredChunk[] => {
  if (!pairGroupId) {
    return [];
  }
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM chunks WHERE pair_group_id = ? ORDER BY id ASC")
    .all(pairGroupId) as Record<string, unknown>[];
  return rows.map(toStoredChunk);
};

/**
 * Short text chunks on the given pages — legends, footnotes, titles. A table
 * chunk is often unreadable without them: the EUSERC table's A/U/C/B column
 * is defined by a one-line legend on the same page, and retrieval that
 * returns the table without its legend hands the model a code it can only
 * guess at.
 *
 * Scoped by manual as well as page. Every manual has a page 20, and an ESR
 * legend attached to a DOH table is worse than no legend: it is a confident
 * wrong key for a code the reader then expands.
 */
export const getShortTextChunksByPages = (
  locations: Array<{ docId: string; page: number }>,
  maxChars = 400
): StoredChunk[] => {
  if (locations.length === 0) {
    return [];
  }
  const db = getDb();
  const clauses = locations.map(() => "(doc_id = ? AND page = ?)");
  const params = locations.flatMap((l) => [l.docId, l.page]);
  const rows = db
    .prepare(
      `SELECT * FROM chunks WHERE (${clauses.join(" OR ")}) AND chunk_type = 'text'
        AND length(text) <= ? ORDER BY doc_id ASC, page ASC, id ASC`
    )
    .all(...params, maxChars) as Record<string, unknown>[];
  return rows.map(toStoredChunk);
};

export const getAllChunks = (): StoredChunk[] => {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM chunks ORDER BY doc_id ASC, page ASC, id ASC")
    .all() as Record<string, unknown>[];
  return rows.map(toStoredChunk);
};

/**
 * Drop everything belonging to one manual, leaving the others indexed.
 *
 * Re-ingesting a manual has to replace it rather than merge into it, and it
 * must not take the other four manuals down with it. Every generated id is
 * namespaced by manual id, so deleting one manual's rows cannot orphan
 * another manual's evidence.
 */
export const clearManual = (docId: string) => {
  const db = getDb();
  const tx = db.transaction(() => {
    const rows = db.prepare("SELECT id FROM chunks WHERE doc_id = ?").all(docId) as {
      id: string;
    }[];
    for (const { id } of rows) {
      db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?").run(id);
    }
    db.prepare("DELETE FROM chunks WHERE doc_id = ?").run(docId);
    db.prepare("DELETE FROM visual_assets WHERE doc_id = ?").run(docId);
  });
  tx();
};

export type SuggestHit = {
  page: number;
  /** Short line for the menu */
  preview: string;
  /** Full chunk text to paste into the question box (capped) */
  value: string;
};

/**
 * How well each manual's own text matches a question, as hit counts.
 *
 * The corpus is five manuals and they overlap in vocabulary on purpose — ESR
 * sets clearances, DOH sets clearances, UGS sets clearances — so a question
 * like "what clearance, in inches, does the ESR specify for 100 A service"
 * scores just as well on a UGS vault drawing as on the ESR table that answers
 * it. Measured against the golden set, that put UGS page 99 above the ESR's
 * page 28 and failed 13 gates.
 *
 * Rather than a hand-tuned rule per manual, this asks the corpus which manual
 * the question is about: how many of its lexical hits land in each. It is one
 * grouped FTS query, local, and it needs no per-manual vocabulary list to keep
 * in sync.
 */
export const getManualAffinity = (
  question: string
): { docId: string; hits: number }[] => {
  const db = getDb();
  const query = ftsQueryTokens(question);
  if (query.length === 0) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT c.doc_id AS docId, COUNT(DISTINCT c.id) AS hits
         FROM chunks_fts f
         JOIN chunks c ON c.id = f.chunk_id
        WHERE chunks_fts MATCH ?
        GROUP BY c.doc_id
        ORDER BY hits DESC`,
    )
    .all(query.join(" OR ")) as { docId: string; hits: number }[];
  // Normalize by manual size: raw hit counts measure corpus mass, not
  // topical aboutness, and DOH (8,446 chunks) wins every shared-vocabulary
  // question by volume. Density (hits per chunk) asks which manual is
  // *about* the question instead. Measured: "how many guys on a 1-inch
  // anchor" went DOH 1213 / PLM 484 raw (PLM discounted out) versus
  // DOH 0.144 / PLM 0.210 density (PLM in play, DOH still competitive).
  const totals = db
    .prepare("SELECT doc_id AS docId, COUNT(*) AS n FROM chunks GROUP BY doc_id")
    .all() as { docId: string; n: number }[];
  const size = new Map(totals.map((t) => [t.docId, Math.max(t.n, 1)]));
  return rows
    .map((r) => ({ ...r, hits: r.hits / (size.get(r.docId) ?? 1) }))
    .sort((a, b) => b.hits - a.hits);
};

/** ESR substring / multi-token AND search for autocomplete (local SQLite). */
export const searchChunkSuggestions = (raw: string, limit: number): SuggestHit[] => {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length < 2) {
    return [];
  }

  const tokens = normalized
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9-]/g, ""))
    .filter((t) => t.length >= 2)
    .slice(0, 5);

  const db = getDb();
  if (tokens.length === 0) {
    return [];
  }

  const escapeLike = (t: string) => `%${t.replace(/%/g, "").replace(/_/g, "")}%`;
  const patterns = tokens.map(escapeLike);

  const whereClause = tokens.map(() => "lower(text) LIKE lower(?)").join(" AND ");
  const rows = db
    .prepare(
      `SELECT text, page FROM chunks WHERE ${whereClause} ORDER BY page ASC, id ASC LIMIT 80`
    )
    .all(...patterns) as { text: string; page: number }[];

  const seen = new Set<string>();
  const out: SuggestHit[] = [];

  for (const row of rows) {
    const value = row.text.replace(/\s+/g, " ").trim().slice(0, 360);
    if (!value) {
      continue;
    }
    const key = value.slice(0, 96);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const preview =
      value.length > 140 ? `${value.slice(0, 138).trim()}…` : value;
    out.push({ page: row.page, preview, value });
    if (out.length >= limit) {
      break;
    }
  }

  return out;
};

export const countChunks = () => {
  const db = getDb();
  const value = db.prepare("SELECT COUNT(1) as count FROM chunks").get() as {
    count: number;
  };
  return value.count;
};

/**
 * A caption ingest left usable. An ingest bug wrote `[object Object]` into 210
 * of the 509 catalogued captions; that is not a caption, and showing it under a
 * diagram tells a planner nothing.
 */
const isUsableCaption = (caption: string): boolean => {
  const text = caption.trim();
  return text.length > 0 && !text.includes("[object Object]");
};

/** The deepest section an asset sits in: "… › Note(s):" → "Note(s):". */
const sectionLeaf = (sectionPath: string | null): string | null => {
  const leaf = sectionPath?.split("›").pop()?.trim();
  return leaf && leaf.length > 0 ? leaf : null;
};

/** One row of table markdown that carries content, not the `--- | ---` rules. */
const firstTableRow = (tableMarkdown: string | undefined): string | null => {
  for (const raw of (tableMarkdown ?? "").split("\n")) {
    const row = raw.trim();
    if (row.length === 0 || /^[-|\s:]+$/.test(row)) {
      continue;
    }
    return row.replace(/\s*\|\s*/g, " · ").replace(/^·\s*|\s*·$/g, "").trim();
  }
  return null;
};

/** The first words of text transcribed inside a figure. OCR arrives one text
 *  block per line, so two lines are often one sentence split in half. */
const ocrOpening = (ocr: string | undefined): string | null => {
  const lines = (ocr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const opening = lines.slice(0, 2).join(" ");
  return opening.length >= 12 ? opening : null;
};

/** A drawing answers a clearance question; a table of notes does not. */
const figureKindRank = (kind: VisualAsset["kind"]): number =>
  kind === "table" ? 1 : 0;

/**
 * The ESR prints the same full-width header on every page — chapter, title,
 * revision date, approval signature — and ingest catalogued it as a table on
 * 213 of the 248 pages. A crop that is a tenth as tall as it is wide is that
 * header and nothing else: every one of them measures 0.082, and the next
 * smallest real crop in the catalog is 0.10.
 *
 * Such an asset is not evidence of anything on its page. Dropping it leaves the
 * page uncatalogued for figures, which is right: the pipeline then shows the
 * page render, where the drawing actually is, instead of a strip of page
 * furniture with the section heading on it.
 */
const isPageHeaderBanner = (bbox: VisualAsset["bbox"]): boolean => {
  if (!bbox) {
    return false;
  }
  const [x0, y0, x1, y1] = bbox;
  const width = x1 - x0;
  return width > 0 && (y1 - y0) / width < 0.1;
};

/**
 * The caption shown under a figure, in the order the data can actually serve
 * one: the ESR's own label, then the section the drawing sits in, then the
 * first content the figure carries, then an honest description of what it is.
 */
const figureCaption = (asset: VisualAsset): string => {
  const candidates = [
    isUsableCaption(asset.caption) ? asset.caption.trim() : null,
    sectionLeaf(asset.sectionPath),
    firstTableRow(asset.textLayers.tableMarkdown),
    ocrOpening(asset.textLayers.ocr),
  ];
  const caption = candidates.find((value): value is string => Boolean(value));
  if (!caption) {
    return `${asset.kind === "table" ? "Table" : asset.kind === "diagram" ? "Diagram" : "Figure"} on page ${asset.page}`;
  }
  return caption.length > 140 ? `${caption.slice(0, 139).trimEnd()}…` : caption;
};

/**
 * Every catalogued figure, keyed to the crop to show for it.
 *
 * This reads `visual_assets`, not the caption chunks: the chunks carry
 * `visual_path` only on the diagram-OCR rows, so building evidence from them
 * handed the UI a 2.5 MB scan of the whole page and a caption of table
 * markdown for every figure. The asset catalog holds the cropped PNG, the
 * chapter, and the text inside the figure, which is what a planner needs.
 *
 * Drawings come before tables on the same page. Retrieval picks one figure per
 * page, and a question about a clearance is answered by the drawing, not by the
 * grid of notes printed under it; `id` breaks the tie so the order is stable.
 */
/**
 * Every catalogued figure, cached for the life of the process.
 *
 * Called up to twice per query (once for the candidate set, once inside the
 * page lookup), each call a full scan and sort of 5,000+ assets. Assets never
 * change at runtime — ingest is a separate process that replaces the database
 * file — so there is nothing to invalidate against.
 */
let cachedPageFigures: FigureEvidence[] | null = null;

export const getAllPageFigures = (): FigureEvidence[] => {
  if (cachedPageFigures) {
    return cachedPageFigures;
  }
  cachedPageFigures = getVisualAssets()
    .filter((asset) => !isPageHeaderBanner(asset.bbox))
    .map((asset) => ({
      asset,
      figure: {
        id: asset.id,
        docId: asset.docId,
        page: asset.page,
        pageLabel: asset.pageLabel,
        standard: asset.standard,
        sheetOf: asset.sheetOf,
        sheetCount: asset.sheetCount,
        caption: figureCaption(asset),
        sourceLink: asset.sourceLink,
        chapter: asset.chapter,
        // The crop is the point of the app; the full page render stays as the
        // fallback for a catalogued asset whose crop was never written.
        // Shipped as .webp — see the fallback-preview note in pipeline.ts.
        figureUrl:
          asset.figureUrl ??
          asset.thumbnailUrl ??
          `/evidence/${asset.docId}/page-${asset.page}.webp`,
        ocrText: asset.textLayers.ocr?.trim() || null,
      } satisfies FigureEvidence,
    }))
    .sort(
      (a, b) =>
        a.figure.docId.localeCompare(b.figure.docId) ||
        a.figure.page - b.figure.page ||
        figureKindRank(a.asset.kind) - figureKindRank(b.asset.kind) ||
        a.figure.id.localeCompare(b.figure.id)
    )
    .map((entry) => entry.figure);
  return cachedPageFigures;
};

/**
 * Figures on specific pages of specific manuals.
 *
 * Scoped by manual because page 20 exists in all five: a bare page number
 * would answer a DOH question with an ESR drawing, which reads as a confident
 * answer rather than as a retrieval mistake.
 */
export const getFigureEvidenceForPages = (
  locations: Array<{ docId: string; page: number }>
): FigureEvidence[] => {
  const want = new Set(
    locations
      .filter((l) => Number.isFinite(l.page))
      .map((l) => `${l.docId}:${l.page}`)
  );
  if (want.size === 0) {
    return [];
  }
  const all = getAllPageFigures();
  const out: FigureEvidence[] = [];
  const seen = new Set<string>();
  for (const fig of all) {
    if (want.has(`${fig.docId}:${fig.page}`) && !seen.has(fig.id)) {
      out.push(fig);
      seen.add(fig.id);
    }
  }
  return out;
};

/**
 * Pipeline version mixed into the answer-cache key below.
 *
 * Bump this on ANY retrieval or prompt change. A cached answer is prose
 * generated from a specific retrieval result through a specific prompt, so
 * serving it after either changed replays the old system while reporting the
 * new one's numbers (this exact failure once read as an answer-recall
 * regression that did not exist). Old rows are hashed without the version, so
 * a bump retires them without a cache clear.
 */
export const PIPELINE_VERSION = 6;

const cacheKey = (
  question: string,
  visualFirst: boolean,
  conversationPrefix = "",
  extractive = false
) =>
  `v${PIPELINE_VERSION}\n` +
  (visualFirst ? `${question}\n__visualFirst=1` : question) +
  (extractive ? `\n__extractive=1` : "") +
  (conversationPrefix.trim() ? `\n__thread=${conversationPrefix.trim()}` : "");

export const getCacheEntry = (
  question: string,
  visualFirst = false,
  conversationPrefix = "",
  extractive = false,
  ttlSeconds = getAppConfig().EMBEDDING_CACHE_TTL_SECONDS
): unknown | null => {
  const db = getDb();
  const hash = crypto
    .createHash("sha256")
    .update(cacheKey(question, visualFirst, conversationPrefix, extractive))
    .digest("hex");
  const row = db
    .prepare("SELECT response_json, created_at FROM query_cache WHERE query_hash = ?")
    .get(hash) as { response_json: string; created_at: number } | undefined;

  if (!row) {
    return null;
  }

  // The writer sweeps expired rows on save, but a row written under a long
  // TTL (or just before a TTL shortening) would otherwise serve stale prose
  // indefinitely. A stale hit is a miss: the caller regenerates.
  if (!Number.isFinite(row.created_at) || Date.now() - row.created_at > ttlSeconds * 1000) {
    return null;
  }

  try {
    return JSON.parse(row.response_json);
  } catch {
    return null;
  }
};

export const saveCacheEntry = (
  question: string,
  response: unknown,
  ttlSeconds: number,
  visualFirst = false,
  conversationPrefix = "",
  extractive = false
) => {
  const db = getDb();
  const now = Date.now();
  const expireAt = now - ttlSeconds * 1000;
  db.prepare(
    "DELETE FROM query_cache WHERE created_at < ?"
  ).run(expireAt);
  db.prepare("INSERT OR REPLACE INTO query_cache (query_hash, response_json, created_at) VALUES (@hash, @responseJson, @createdAt)")
    .run({
      hash: crypto
        .createHash("sha256")
        .update(cacheKey(question, visualFirst, conversationPrefix, extractive))
        .digest("hex"),
      responseJson: JSON.stringify(response),
      createdAt: now,
    });
};

export const getQueryCacheCount = (): number => {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(1) as count FROM query_cache")
    .get() as { count: number };
  return row.count;
};

/**
 * FTS5 stopwords: the ESR is a spec, so "shall", "company", "customer" and
 * friends appear in nearly every chunk and carry no ranking signal.
 */
const FTS_STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can", "company",
  "customer", "did", "does", "each", "for", "from", "has", "have", "how", "in", "into", "is", "it", "its",
  "just", "many", "may", "much", "must", "need", "needs", "not", "of", "on", "or", "our", "please",
  "shall", "should", "such", "than", "that", "the",
  "their", "then", "there", "these", "this", "those", "to", "want", "was", "were", "what", "when",
  "where", "which", "who", "will", "with", "would", "you", "your",
]);

/**
 * Planner shorthand lives in lexicon-data.ts (data, not code). Imported here
 * for query expansion; a new shorthand shape is a data edit in that file.
 */

export const expandShorthand = (raw: string): string => {
  let out = raw;
  for (const [pattern, replacement] of SHORTHAND) {
    // Fresh regex state per call: the patterns are global and `lastIndex`
    // would otherwise leak between questions.
    out = out.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }
  return out;
};

/**
 * Content tokens for FTS5 MATCH, in order, deduped.
 *
 * OR-relaxed on purpose. ANDing every token meant one misspelled or
 * out-of-vocabulary word silently returned zero rows, which surfaced as
 * "no results" rather than as a weaker match. BM25's IDF weighting is what
 * makes OR safe here: rare terms dominate, so a chunk matching several rare
 * terms outranks one matching only common words.
 */
export const ftsQueryTokens = (raw: string): string[] => {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of expandShorthand(raw).toLowerCase().split(/[^a-z0-9]+/)) {
    const token = part.trim();
    if (token.length < 3) continue;
    if (FTS_STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= 16) break;
  }
  return tokens;
};

/** OR-relaxed FTS5 MATCH expression, or null when there is nothing to search for. */
export const buildFtsMatchQuery = (raw: string): string | null => {
  const tokens = ftsQueryTokens(raw);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((t) => `"${t}"`).join(" OR ");
};

export type FtsHit = { chunkId: string; bm25: number };

/**
 * Lexical retrieval via FTS5 BM25. Lower bm25 is better (SQLite returns
 * negated values).
 *
 * Errors propagate. The previous implementation swallowed them into an
 * empty array, which was indistinguishable from "nothing matched" and made a
 * broken index look like an empty corpus.
 */
export const searchChunksFts = (raw: string, limit: number): FtsHit[] => {
  const match = buildFtsMatchQuery(raw);
  if (!match) {
    return [];
  }
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT chunk_id, bm25(chunks_fts) AS b
         FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY b ASC
        LIMIT ?`
    )
    .all(match, limit) as { chunk_id: string; b: number }[];
  return rows.map((r) => ({ chunkId: String(r.chunk_id), bm25: Number(r.b) }));
};

/**
 * Table chunks containing any of the given measurement keys ("1 inches").
 *
 * Lookup questions name the row key, but giant tables BM25-rank in the
 * hundreds against prose-length competition — Table 10-45 sat at rank 586 for
 * a question it answers, so no re-ranking boost could ever reach it. This is
 * the second candidate stream that fixes the generation side: tables matching
 * the question's measurements enter candidates on their own merit, where the
 * measure-match prior then scores them. Restricted to tables and capped,
 * because "1 inches" alone matches dozens of dimension tables and the scorer —
 * not the fetcher — decides between them.
 */
export const searchTablesByMeasure = (
  measureKeys: string[],
  limit = 40,
  topicalTerms: string[] = [],
): FtsHit[] => {
  const measures = [...new Set(measureKeys.flatMap((k) => k.split(" ")))].filter(
    (t) => t.length > 0,
  );
  if (measures.length === 0) {
    return [];
  }
  // The measurement alone matches hundreds of dimension tables ("1 inch" is
  // everywhere hardware is sized), so the topical nouns come along: a lookup
  // table for THIS question carries both the measurement and the topic. Either
  // side alone is a flood; together they are a filter.
  const topical = [...new Set(topicalTerms)].filter((t) => t.length >= 3).slice(0, 8);
  const measureClause = `(${measures.map((t) => `"${t}"`).join(" OR ")})`;
  const match =
    topical.length > 0
      ? `${measureClause} AND (${topical.map((t) => `"${t}"`).join(" OR ")})`
      : measureClause;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT f.chunk_id, bm25(chunks_fts) AS b
         FROM chunks_fts f
         JOIN chunks c ON c.id = f.chunk_id
        WHERE chunks_fts MATCH ?
          AND c.chunk_type = 'table'
        ORDER BY b ASC
        LIMIT ?`,
    )
    .all(match, limit) as {
    chunk_id: string;
    b: number;
  }[];
  return rows.map((r) => ({ chunkId: String(r.chunk_id), bm25: Number(r.b) }));
};

/**
 * BM25 of a single chunk against a query, or null if it does not match.
 * Used to re-score specific candidates without another full sweep.
 */
export const bm25ForChunk = (chunkId: string, raw: string): number | null => {  const match = buildFtsMatchQuery(raw);
  if (!match) {
    return null;
  }
  const db = getDb();
  const row = db
    .prepare(
      `SELECT bm25(chunks_fts) AS b
         FROM chunks_fts
        WHERE chunks_fts MATCH ? AND chunk_id = ?`
    )
    .get(match, chunkId) as { b: number } | undefined;
  return row ? Number(row.b) : null;
};
