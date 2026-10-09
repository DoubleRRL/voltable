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
  docId: String(row.doc_id),
  page: Number(row.page),
  chunkType: String(row.chunk_type) as StoredChunk["chunkType"],
  evidenceType: String(row.evidence_type) as StoredChunk["evidenceType"],
  text: String(row.text),
  section: row.section ? String(row.section) : null,
  sectionKey: row.section_key ? String(row.section_key) : null,
  chapter: row.chapter ? String(row.chapter) : null,
  pageLabel: row.page_label ? String(row.page_label) : null,
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
  page: Number(row.page),
  kind: String(row.kind) as VisualAsset["kind"],
  chapter: row.chapter ? String(row.chapter) : null,
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
};

const ensureVisualAssetsTable = (db: Db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS visual_assets (
      id TEXT PRIMARY KEY,
      page INTEGER NOT NULL,
      kind TEXT NOT NULL,
      chapter TEXT,
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

const getDbPath = () => {
  const config = getAppConfig();
  // The magic comment is on `process.cwd()` so Turbopack treats this as a
  // runtime resolve. Without it the traced path is unknown at build time, the
  // output-file trace pulls in the whole project, and the build warns that the
  // trace was unintentionally wide.
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), config.ESR_DB_PATH);
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

export const rebuildChunkFtsIndex = () => {
  const db = getDb();
  ensureFts(db);
  db.exec("DELETE FROM chunks_fts");
  db.exec(`
    INSERT INTO chunks_fts(chunk_id, text)
    SELECT id, text FROM chunks
  `);
};

export const clearIndex = () => {
  const db = getDb();
  db.prepare("DELETE FROM chunks").run();
  db.prepare("DELETE FROM query_cache").run();
  try {
    db.prepare("DELETE FROM visual_assets").run();
  } catch {
    /* table may not exist on very old DBs until migrate */
  }
  try {
    db.exec("DELETE FROM chunks_fts");
  } catch {
    /* FTS may not exist on very old DBs until next open */
  }
};

export const upsertChunks = (chunks: StoredChunk[]) => {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO chunks (
      id, doc_id, page, chunk_type, evidence_type, text, section, section_key, page_label,
      source_link, visual_path, embedding_json, created_at,
      chunk_role, visual_kind, paired_chunk_ids, pair_group_id, chapter
    ) VALUES (
      @id, @docId, @page, @chunkType, @evidenceType, @text, @section, @sectionKey, @pageLabel,
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
        pageLabel: chunk.pageLabel,
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
  rebuildChunkFtsIndex();
};

export const upsertVisualAssets = (assets: VisualAsset[]) => {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO visual_assets (
      id, page, kind, chapter, section_key, section_path, caption,
      figure_url, thumbnail_url, bbox_json, source_link,
      pair_group_id, exceptions_json, supporting_chunk_ids_json, text_layers_json, created_at
    ) VALUES (
      @id, @page, @kind, @chapter, @sectionKey, @sectionPath, @caption,
      @figureUrl, @thumbnailUrl, @bboxJson, @sourceLink,
      @pairGroupId, @exceptionsJson, @supportingChunkIdsJson, @textLayersJson, @createdAt
    )
  `);

  const tx = db.transaction((records: VisualAsset[]) => {
    for (const asset of records) {
      insert.run({
        id: asset.id,
        page: asset.page,
        kind: asset.kind,
        chapter: asset.chapter ?? null,
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
  const rows = db
    .prepare("SELECT * FROM visual_assets ORDER BY page ASC, id ASC")
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
  pageLabel: string | null;
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
  pageLabel: row.page_label ? String(row.page_label) : null,
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
        source_link, visual_path, created_at, chunk_role, paired_chunk_ids, pair_group_id
        FROM chunks ORDER BY page ASC, id ASC`
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

export const getAllChunks = (): StoredChunk[] => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM chunks ORDER BY page ASC, id ASC").all() as Record<
    string,
    unknown
  >[];
  return rows.map(toStoredChunk);
};

export type SuggestHit = {
  page: number;
  /** Short line for the menu */
  preview: string;
  /** Full chunk text to paste into the question box (capped) */
  value: string;
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
export const getAllPageFigures = (): FigureEvidence[] =>
  getVisualAssets()
    .filter((asset) => !isPageHeaderBanner(asset.bbox))
    .map((asset) => ({
      asset,
      figure: {
        id: asset.id,
        page: asset.page,
        caption: figureCaption(asset),
        sourceLink: asset.sourceLink,
        chapter: asset.chapter,
        // The crop is the point of the app; the full page render stays as the
        // fallback for a catalogued asset whose crop was never written.
        figureUrl:
          asset.figureUrl ?? asset.thumbnailUrl ?? `/figures/page-${asset.page}.png`,
        ocrText: asset.textLayers.ocr?.trim() || null,
      } satisfies FigureEvidence,
    }))
    .sort(
      (a, b) =>
        a.figure.page - b.figure.page ||
        figureKindRank(a.asset.kind) - figureKindRank(b.asset.kind) ||
        a.figure.id.localeCompare(b.figure.id)
    )
    .map((entry) => entry.figure);

export const getFigureEvidenceForPages = (pages: number[]): FigureEvidence[] => {
  const want = new Set(pages.filter((p) => Number.isFinite(p)));
  if (want.size === 0) {
    return [];
  }
  const all = getAllPageFigures();
  const out: FigureEvidence[] = [];
  const seen = new Set<string>();
  for (const fig of all) {
    if (want.has(fig.page) && !seen.has(fig.id)) {
      out.push(fig);
      seen.add(fig.id);
    }
  }
  return out;
};

const cacheKey = (
  question: string,
  visualFirst: boolean,
  conversationPrefix = "",
  extractive = false
) =>
  (visualFirst ? `${question}\n__visualFirst=1` : question) +
  (extractive ? `\n__extractive=1` : "") +
  (conversationPrefix.trim() ? `\n__thread=${conversationPrefix.trim()}` : "");

export const getCacheEntry = (
  question: string,
  visualFirst = false,
  conversationPrefix = "",
  extractive = false
): unknown | null => {
  const db = getDb();
  const hash = crypto
    .createHash("sha256")
    .update(cacheKey(question, visualFirst, conversationPrefix, extractive))
    .digest("hex");
  const row = db
    .prepare("SELECT response_json FROM query_cache WHERE query_hash = ?")
    .get(hash) as { response_json: string } | undefined;

  if (!row) {
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
  "customer", "each", "for", "from", "has", "have", "in", "into", "is", "it", "its", "may",
  "must", "not", "of", "on", "or", "our", "shall", "should", "such", "than", "that", "the",
  "their", "then", "there", "these", "this", "those", "to", "was", "were", "what", "when",
  "where", "which", "who", "will", "with", "would", "you", "your",
]);

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
  for (const part of raw.toLowerCase().split(/[^a-z0-9]+/)) {
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
 * BM25 of a single chunk against a query, or null if it does not match.
 * Used to re-score specific candidates without another full sweep.
 */
export const bm25ForChunk = (chunkId: string, raw: string): number | null => {
  const match = buildFtsMatchQuery(raw);
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
