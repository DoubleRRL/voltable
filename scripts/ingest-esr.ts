import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import pLimit from "p-limit";

import { getAppConfig } from "@/lib/env";
import {
  clearIndex,
  rebuildChunkFtsIndex,
  upsertChunks,
  upsertVisualAssets,
} from "@/lib/rag/storage";
import type {
  EsrChapter,
  IndexedChunk,
  StoredChunk,
  VisualAsset,
  VisualAssetTextLayers,
  VisualKind,
} from "@/lib/rag/types";

/**
 * Ingest the ESR from MinerU layout output.
 *
 * Layout-aware: block type comes from the parser rather than from regexes over
 * markdown, so "is this a figure" and "is this a header" are answered by the
 * document model instead of guessed.
 *
 * Pipeline
 *   MinerU layout JSON
 *     -> chapter/section tracking from doc_title + paragraph_title
 *     -> body chunks, table chunks, visual assets
 *     -> render page (PDFKit via osascript), crop each visual, OCR the crop
 *     -> SQLite + FTS5
 *
 * Every render and OCR result is cached under data/render-cache so re-running
 * ingest does not repeat the expensive step.
 */

const DOC_ID = "esr";

type LayoutContentItem = {
  type: string;
  content: string;
  styles?: unknown;
};

type LayoutBlock = {
  type: string;
  index: number;
  bbox: [number, number, number, number];
  content?: LayoutContentItem[];
  level?: number;
  continues_prev?: boolean;
};

type LayoutPage = {
  page_idx: number;
  blocks: LayoutBlock[];
};

type LayoutDoc = {
  pages: LayoutPage[];
  extensions?: { docvortex_layout?: { pages?: { page_idx: number; width_pt: number; height_pt: number }[] } };
};

type RenderResult = {
  ok: boolean;
  page?: number;
  pagePng?: string;
  inkFraction?: number;
  error?: string;
  figures?: {
    index: number;
    bbox: number[];
    file?: string;
    ocr?: string;
    error?: string;
    width?: number;
    height?: number;
  }[];
};

/** Blocks that carry no searchable content. */
const SKIP_BLOCKS = new Set(["header", "footer", "page_number", "page_footnote", "index"]);

/** Visual block types. */
const VISUAL_BLOCKS = new Set(["image", "chart"]);

const CHAPTER_RE = /^(ESR[\s–—-]*\d+)\s*[:\s]\s*(.+)$/;

/**
 * MinerU puts caption content in two different shapes depending on the block
 * and tier: a plain string for `table_caption`, and a nested list of
 * `{type,content}` items for `image_caption` / `chart_caption`. Stringifying
 * the nested form produced literal "[object Object]" captions.
 */
const flattenContent = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (entry && typeof entry === "object" && "content" in entry) {
          return flattenContent((entry as { content: unknown }).content);
        }
        return flattenContent(entry);
      })
      .filter(Boolean)
      .join(" ");
  }
  if (value && typeof value === "object" && "content" in value) {
    return flattenContent((value as { content: unknown }).content);
  }
  return "";
};

const textOf = (block: LayoutBlock): string =>
  (block.content ?? [])
    .filter((c) => c.type === "text" || c.type === "table_caption" || c.type === "image_caption" || c.type === "chart_caption")
    .map((c) => flattenContent(c.content))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const itemOf = (block: LayoutBlock, ...types: string[]) =>
  (block.content ?? [])
    .filter((c) => types.includes(c.type))
    .map((c) => flattenContent(c.content))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();

/**
 * MinerU gives tables as real HTML. Converting to markdown pipes preserved
 * the cell contents, which is all retrieval and citation need, and gives the
 * UI something renderable without a second parser.
 */
export const htmlTableToMarkdown = (html: string): string => {
  const rows: string[][] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<(t[dh])[^>]*>([\s\S]*?)<\/\1>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html))) {
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const text = cellMatch[2]
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
      cells.push(text);
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const lines = [pad(rows[0]).map(() => "---").join(" | ")];
  // MinerU marks the header row inside <thead>; when absent, treat row 0 as data.
  for (const row of rows.slice(1)) lines.push(pad(row).join(" | "));
  return lines.join("\n");
};

/**
 * Figures carry caption text and OCR'd interior text. Both are indexed: the
 * caption makes the figure findable by name, the OCR makes values that exist
 * only as pixels inside a diagram findable by value.
 */
const cleanOcr = (raw: string): string => {
  if (!raw) return "";
  if (raw.startsWith("__OCR_FAILED__")) return "";
  const stop = new Set(["EFFECTIVE DATE", "APPROVED", "SCE Public", "ESR-1", "PAGE"]);
  return raw
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => {
      if (line.length < 2) return false;
      if (stop.has(line)) return false;
      if (/^\d+(\.\d+)?\s*[-–]\s*\d+$/.test(line)) return false;
      return true;
    })
    .join("\n")
    .trim();
};

const EXCEPTION_RE =
  /\b(exception|except\b|unless\b|at the company'?s discretion|subject to approval|where permitted|deviation)\b/i;

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);

type PendingVisual = {
  asset: VisualAsset;
  bbox: [number, number, number, number];
};

const loadLayout = (layoutPath: string): LayoutDoc => {
  if (!fs.existsSync(layoutPath)) {
    throw new Error(
      `MinerU layout not found at ${layoutPath}.\n` +
        `Run: .venv-mineru/bin/mineru parse "../Electrical Service Requirements (ESR).pdf" -p all --tier basic -o data/mineru/esr-basic.json --json`
    );
  }
  return JSON.parse(fs.readFileSync(layoutPath, "utf8")) as LayoutDoc;
};

/** Render a page and OCR each requested figure, with an on-disk cache. */
const renderPage = (
  pdfPath: string,
  page: number,
  label: string,
  bboxes: [number, number, number, number][],
  cacheDir: string,
  force: boolean
): Promise<RenderResult> =>
  new Promise((resolve) => {
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, `p${page}.json`);
    const key = bboxes.map((b) => b.map((v) => v.toFixed(4)).join(",")).join("|");

    if (!force && fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as RenderResult & { key?: string };
        if (cached.ok && cached.key === key) {
          resolve(cached);
          return;
        }
      } catch {
        /* fall through and re-render */
      }
    }

    const args = [
      path.join(process.cwd(), "scripts", "render", "render-and-ocr.py"),
      pdfPath,
      String(page),
      cacheDir,
      label,
      ...bboxes.flatMap((b) => b.map(String)),
    ];

    const child = spawn(config().ESR_PYTHON, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        resolve({ ok: false, page, error: err.trim() || "render worker produced no output" });
        return;
      }
      let parsed: RenderResult;
      try {
        parsed = JSON.parse(line) as RenderResult;
      } catch {
        resolve({ ok: false, page, error: `unparseable worker output: ${line.slice(0, 300)}` });
        return;
      }
      if (parsed.ok) {
        fs.writeFileSync(cacheFile, JSON.stringify({ ...parsed, key }));
      }
      resolve(parsed);
    });
  });

const config = () => {
  const cfg = getAppConfig() as ReturnType<typeof getAppConfig> & { ESR_PYTHON?: string };
  return { ...cfg, ESR_PYTHON: cfg.ESR_PYTHON ?? path.join(process.cwd(), ".venv-mineru", "bin", "python") };
};

const main = async () => {
  const force = process.argv.includes("--force-render");
  const cfg = config();
  const pdfPath = path.resolve(process.cwd(), cfg.ESR_PDF_PATH);
  const layoutPath = path.resolve(process.cwd(), cfg.ESR_LAYOUT_PATH);
  const cacheDir = path.resolve(process.cwd(), "data", "render-cache");
  const figuresDir = path.resolve(process.cwd(), "public", "figures");

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`ESR PDF not found: ${pdfPath}`);
  }
  if (!fs.existsSync(cfg.ESR_PYTHON)) {
    throw new Error(
      `Python interpreter not found: ${cfg.ESR_PYTHON}\nInstall it with: python3 -m venv .venv-mineru && .venv-mineru/bin/pip install mineru rapidocr-onnxruntime`
    );
  }
  fs.mkdirSync(figuresDir, { recursive: true });

  const layout = loadLayout(layoutPath);
  const pages = [...layout.pages].sort((a, b) => a.page_idx - b.page_idx);
  console.log(`[ingest] layout: ${pages.length} pages from ${path.basename(layoutPath)}`);

  const chunks: IndexedChunk[] = [];
  const assets: VisualAsset[] = [];
  const pending: PendingVisual[] = [];

  let chapter: EsrChapter | null = null;
  let chapterTitle = "";
  let section = "";
  const seenChapters = new Map<string, number[]>();
  let now = Date.now();

  for (const page of pages) {
    const pageNo = page.page_idx + 1;
    const blocks = [...page.blocks].sort((a, b) => a.index - b.index);

    for (const block of blocks) {
      const text = textOf(block);

      if (block.type === "doc_title") {
        const match = CHAPTER_RE.exec(text);
        if (match) {
          // Normalize the ESR's en-dash to a hyphen so chapter ids are stable
          // ASCII regardless of how the PDF renders the dash glyph.
          chapter = match[1].replace(/\s+/g, "").replace(/[–—]/g, "-");
          chapterTitle = match[2].trim();
          section = "";
        }
        continue;
      }

      if (SKIP_BLOCKS.has(block.type)) continue;

      if (block.type === "paragraph_title") {
        if (text) section = text;
        continue;
      }

      const sectionPath = [chapterTitle, section].filter(Boolean).join(" › ");
      const sourceLink = `${cfg.ESR_SOURCE_LINK_PREFIX}${pageNo}`;
      const chapterKey = chapter;

      if (VISUAL_BLOCKS.has(block.type)) {
        const caption =
          itemOf(block, "image_caption", "chart_caption") ||
          itemOf(block, "text") ||
          (section ? `${section} (${block.type})` : "");
        const assetId = `p${pageNo}-${block.index}`;
        const bbox = block.bbox;
        const asset: VisualAsset = {
          id: assetId,
          page: pageNo,
          kind: (block.type === "chart" ? "diagram" : "figure") as VisualKind,
          chapter: chapterKey,
          sectionKey: section ? slug(section) : null,
          sectionPath: sectionPath || null,
          caption,
          figureUrl: null,
          thumbnailUrl: `/figures/page-${pageNo}.png`,
          bbox,
          sourceLink,
          pairGroupId: null,
          exceptions: EXCEPTION_RE.test(caption)
            ? [{ text: caption, page: pageNo, sourceLink }]
            : [],
          supportingChunkIds: [],
          textLayers: { caption } as VisualAssetTextLayers,
          createdAt: now,
        };
        assets.push(asset);
        pending.push({ asset, bbox });

        // The figure caption is indexed on its own so the figure is findable
        // by name; the OCR text lands in a paired chunk once rendered.
        if (caption) {
          chunks.push({
            id: `${assetId}-cap`,
            docId: DOC_ID,
            page: pageNo,
            chunkType: "figure",
            evidenceType: "figure",
            text: caption,
            section,
            sectionKey: section ? slug(section) : null,
            chapter: chapterKey,
            pageLabel: null,
            sourceLink,
            visualPath: null,
            createdAt: now,
            chunkRole: "visual_caption",
            visualKind: asset.kind,
            pairedChunkIds: [],
            pairGroupId: assetId,
          });
        }
        continue;
      }

      if (block.type === "table") {
        const html = itemOf(block, "table_body");
        const caption = itemOf(block, "table_caption");
        const md = htmlTableToMarkdown(html);
        const body = [caption, md].filter(Boolean).join("\n\n");
        if (!body.trim()) continue;
        const assetId = `p${pageNo}-${block.index}`;
        const asset: VisualAsset = {
          id: assetId,
          page: pageNo,
          kind: "table",
          chapter: chapterKey,
          sectionKey: section ? slug(section) : null,
          sectionPath: sectionPath || null,
          caption: caption || section || `Table on page ${pageNo}`,
          figureUrl: null,
          thumbnailUrl: `/figures/page-${pageNo}.png`,
          bbox: block.bbox,
          sourceLink,
          pairGroupId: null,
          exceptions: EXCEPTION_RE.test(body)
            ? [{ text: body.slice(0, 400), page: pageNo, sourceLink }]
            : [],
          supportingChunkIds: [],
          textLayers: { caption: caption || "", tableMarkdown: md } as VisualAssetTextLayers,
          createdAt: now,
        };
        assets.push(asset);
        pending.push({ asset, bbox: block.bbox });

        chunks.push({
          id: assetId,
          docId: DOC_ID,
          page: pageNo,
          chunkType: "table",
          evidenceType: "table",
          text: body,
          section,
          sectionKey: section ? slug(section) : null,
          chapter: chapterKey,
          pageLabel: null,
          sourceLink,
          visualPath: null,
          createdAt: now,
          chunkRole: "visual_caption",
          visualKind: "table",
          pairedChunkIds: [],
          pairGroupId: assetId,
        });
        continue;
      }

      // Remaining narrative-bearing block types.
      if (!text || text.length < 12) continue;
      chunks.push({
        id: `p${pageNo}-${block.index}`,
        docId: DOC_ID,
        page: pageNo,
        chunkType: "text",
        evidenceType: "paragraph",
        text: section ? `${section}\n${text}` : text,
        section,
        sectionKey: section ? slug(section) : null,
        chapter: chapterKey,
        pageLabel: null,
        sourceLink,
        visualPath: null,
        createdAt: now,
        chunkRole: EXCEPTION_RE.test(text) ? "pre_visual_narrative" : "body",
        visualKind: null,
        pairedChunkIds: [],
        pairGroupId: null,
      });
      if (chapterKey) {
        const list = seenChapters.get(chapterKey) ?? [];
        list.push(pageNo);
        seenChapters.set(chapterKey, list);
      }
    }
    now += 1;
  }

  console.log(
    `[ingest] parsed ${chunks.length} chunks and ${assets.length} visual assets ` +
      `across ${seenChapters.size} chapters`
  );

  // Render + crop + OCR, grouped per page.
  const byPage = new Map<number, PendingVisual[]>();
  for (const item of pending) {
    const list = byPage.get(item.asset.page) ?? [];
    list.push(item);
    byPage.set(item.asset.page, list);
  }

  const limit = pLimit(3);
  let rendered = 0;
  let failed = 0;
  const ocrChunks: IndexedChunk[] = [];

  await Promise.all(
    [...byPage.entries()].map(([page, items]) =>
      limit(async () => {
        const result = await renderPage(
          pdfPath,
          page,
          `p${page}`,
          items.map((i) => i.bbox),
          cacheDir,
          force
        );
        if (!result.ok) {
          failed += 1;
          console.error(`[ingest] page ${page} render failed: ${result.error}`);
          return;
        }
        // Copy cached renders into public/.
        for (const name of [result.pagePng, ...(result.figures ?? []).map((f) => f.file)]) {
          if (!name) continue;
          const src = path.join(cacheDir, name);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(figuresDir, name));
        }
        for (const fig of result.figures ?? []) {
          const item = items[fig.index];
          if (!item) continue;
          if (fig.error) {
            console.error(`[ingest] page ${page} figure ${fig.index}: ${fig.error}`);
            continue;
          }
          if (fig.file) item.asset.figureUrl = `/figures/${fig.file}`;
          const ocr = cleanOcr(fig.ocr ?? "");
          if (ocr) {
            item.asset.textLayers.ocr = ocr;
            ocrChunks.push({
              id: `${item.asset.id}-ocr`,
              docId: DOC_ID,
              page: item.asset.page,
              chunkType: "text",
              evidenceType: "figure",
              text: `${item.asset.caption}\n${ocr}`,
              section: item.asset.sectionPath,
              sectionKey: item.asset.sectionKey,
              chapter: item.asset.chapter,
              pageLabel: null,
              sourceLink: item.asset.sourceLink,
              visualPath: item.asset.figureUrl,
              createdAt: Date.now(),
              chunkRole: "diagram_ocr",
              visualKind: item.asset.kind,
              pairedChunkIds: [],
              pairGroupId: item.asset.id,
            });
          }
        }
        rendered += 1;
        if (rendered % 25 === 0) console.log(`[ingest] rendered ${rendered}/${byPage.size} pages`);
      })
    )
  );

  if (failed > 0) {
    throw new Error(
      `${failed} of ${byPage.size} pages failed to render. Refusing to index a partial document; ` +
        `fix the renderer and re-run (add --force-render to bypass the cache).`
    );
  }

  const allChunks: StoredChunk[] = [...chunks, ...ocrChunks].map((c) => ({
    ...c,
    embedding: [],
  }));

  const withOcr = assets.filter((a) => a.textLayers.ocr).length;
  console.log(
    `[ingest] ready: ${allChunks.length} chunks (${ocrChunks.length} from figure OCR), ` +
      `${assets.length} assets, ${withOcr} with transcribed figure text`
  );

  clearIndex();
  upsertChunks(allChunks);
  upsertVisualAssets(assets);
  rebuildChunkFtsIndex();
  console.log(`[ingest] wrote ${allChunks.length} chunks and ${assets.length} assets to SQLite`);
};

main().catch((error) => {
  console.error("[ingest] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});