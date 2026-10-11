import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import pLimit from "p-limit";

import { getAppConfig } from "@/lib/env";
import {
  clearManual,
  upsertChunks,
  upsertVisualAssets,
} from "@/lib/rag/storage";
import type {
  IndexedChunk,
  StoredChunk,
  VisualAsset,
  VisualAssetTextLayers,
  VisualKind,
} from "@/lib/rag/types";
import {
  MANUALS,
  MANUAL_IDS,
  evidencePageLink,
  footerRulesFor,
  type ManualId,
} from "@/lib/rag/docs";

/**
 * Ingest SCE manuals from MinerU layout output.
 *
 * Layout-aware: block type comes from the parser rather than from regexes over
 * markdown, so "is this a figure" and "is this a header" are answered by the
 * document model instead of guessed.
 *
 * Pipeline, per manual
 *   page-facts.py (printed page label, chapter/standard, sheet, header)
 *     + MinerU layout JSON
 *     -> chapter/section tracking
 *     -> body chunks, table chunks, visual assets
 *     -> render page (PDFKit via osascript), crop each visual, OCR the crop
 *     -> SQLite + FTS5
 *
 * Everything generated for a manual is namespaced by its id -- render cache,
 * asset and chunk ids, evidence paths, and the citation link -- because page
 * numbers repeat across manuals and a shared key silently overwrites.
 *
 * Renders are cached per manual under data/render-cache/<id>/, so a re-run
 * after a crash resumes rather than repeats.
 */

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

/** One page's citation identity, read off the printed footer. */
type PageFacts = {
  page: number;
  header: string;
  printedPage?: string | null;
  chapter?: string | null;
  standard?: string | null;
  sheetOf?: number | null;
  sheetCount?: number | null;
  effectiveDate?: string | null;
  error?: string;
};

/** Blocks that carry no searchable content. */
const SKIP_BLOCKS = new Set(["header", "footer", "page_number", "page_footnote", "index"]);

/** Visual block types. */
const VISUAL_BLOCKS = new Set(["image", "chart"]);

/**
 * Fallback chapter detection from a page's own title block, used only when the
 * footer yielded nothing (divider pages carry neither). Kept per manual
 * because the identifiers differ: ESR chapters are "ESR-3", and the sheet
 * manuals put the standard number in the footer instead of a title.
 */
const chapterTitleRe = (id: ManualId): RegExp => {
  const code = MANUALS[id].code;
  return new RegExp(`^(${code}[\\s–—-]*\\d+|[A-Z]{2,4}\\s?\\d{2,4})\\s*[:\\s]\\s*(.+)$`);
};

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

/**
 * A block's content, always as a list of typed items.
 *
 * The parser emits three shapes across these manuals: a list of
 * `{type, content}` items (most text), a bare string (a table's HTML), and a
 * list of single characters (some tables, where the HTML was serialised
 * per-character). Assuming one shape threw on the first block that used
 * another and lost the rest of the manual with it.
 */
const contentItems = (block: LayoutBlock): LayoutContentItem[] => {
  const content = block.content as unknown;
  if (typeof content === "string") return [{ type: "text", content }];
  if (!Array.isArray(content)) return [];
  if (content.length > 0 && content.every((c) => typeof c === "string")) {
    return [{ type: "text", content: content.join("") }];
  }
  return content as LayoutContentItem[];
};

/** Every character of a block as one string, whichever shape it arrived in. */
const blockText = (block: LayoutBlock): string => {
  const content = block.content as unknown;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : flattenContent((c as LayoutContentItem)?.content)))
      .join(content.every((c) => typeof c === "string") ? "" : " ");
  }
  return "";
};

const textOf = (block: LayoutBlock): string =>
  contentItems(block)
    .filter((c) => c.type === "text" || c.type === "table_caption" || c.type === "image_caption" || c.type === "chart_caption" || c.type === "caption")
    .map((c) => flattenContent(c.content))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const itemOf = (block: LayoutBlock, ...types: string[]) =>
  contentItems(block)
    .filter((c) => types.includes(c.type))
    .map((c) => flattenContent(c.content))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();

/**
 * The caption that belongs to a visual or table block.
 *
 * Looks at the immediately neighbouring blocks on the same page. A caption is
 * its own block type in these manuals and sits directly above or below the
 * drawing it labels, so adjacency is the association — taking the first
 * `caption` on the page instead would attach Figure 10-3's caption to
 * Figure 10-1.
 */
const captionFor = (blocks: LayoutBlock[], block: LayoutBlock, index: number): string => {
  for (const offset of [-1, 1]) {
    const neighbour = blocks[index + offset];
    if (neighbour && neighbour.type === "caption") {
      const text = textOf(neighbour);
      if (text) return text;
    }
  }
  return "";
};

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
        // Tables carry real inch/foot marks as entities (1&quot; x 7&#x27;).
        // Leaving them encoded destroys the measurement tokens the question
        // side expands ("1"" → "1 inches"), so a 1-inch anchor question can
        // never meet its table. Decode everything, not just the common four.
        .replace(/&quot;/g, '"')
        .replace(/&#x22;/gi, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#x27;/gi, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        )
        .replace(/&#(\d+);/g, (_, dec) =>
          String.fromCharCode(parseInt(dec, 10)),
        )
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
 * Footer furniture that OCR picks up out of every figure crop. Page labels are
 * stripped as a line-shape rule rather than a list, because the label differs
 * per manual ("10-8", "3-24") and a fixed stop-list only ever covered the ESR.
 */
const cleanOcr = (raw: string): string => {
  if (!raw) return "";
  if (raw.startsWith("__OCR_FAILED__")) return "";
  const stop = new Set([
    "EFFECTIVE DATE",
    "APPROVED",
    "SCE Public",
    "SCE Internal",
    "SCE Confidential",
    "ESR-1",
    "PAGE",
  ]);
  return raw
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => {
      if (line.length < 2) return false;
      if (stop.has(line)) return false;
      // "10-8", "3-24", "2 - 12": a printed page label, not drawing content.
      if (/^\d{1,4}\s*[-–—]\s*\d{1,4}$/.test(line)) return false;
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

const config = () => {
  const cfg = getAppConfig() as ReturnType<typeof getAppConfig> & { ESR_PYTHON?: string };
  return {
    ...cfg,
    ESR_PYTHON: cfg.ESR_PYTHON ?? path.join(process.cwd(), ".venv-mineru", "bin", "python"),
  };
};

const loadLayout = (layoutPath: string, id: ManualId): LayoutDoc => {
  if (!fs.existsSync(layoutPath)) {
    throw new Error(
      `MinerU layout for ${MANUALS[id].code} not found at ${layoutPath}.\n` +
        `Run: npm run parse -- ${id}`
    );
  }
  return JSON.parse(fs.readFileSync(layoutPath, "utf8")) as LayoutDoc;
};

/** Run a child process and collect stdout, rejecting on a non-zero exit. */
const runPython = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(config().ESR_PYTHON, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(err.trim() || `worker exited ${code}`));
      }
    });
  });

/**
 * Read citation identity for every page of one manual.
 *
 * Done in a single pass before any layout work: page facts decide chapter
 * tracking, so they have to be known while blocks are walked, and one pypdf
 * sweep is far cheaper than anything per page.
 */
const readPageFacts = async (
  pdfPath: string,
  id: ManualId,
  firstPage: number,
  lastPage: number
): Promise<Map<number, PageFacts>> => {
  const rulesPath = path.join(process.cwd(), "data", "mineru", `${id}.rules.json`);
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  fs.writeFileSync(rulesPath, JSON.stringify(footerRulesFor(id)));
  const out = await runPython([
    path.join(process.cwd(), "scripts", "render", "page-facts.py"),
    pdfPath,
    rulesPath,
    String(firstPage),
    String(lastPage),
  ]);
  const facts = new Map<number, PageFacts>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as PageFacts;
      facts.set(record.page, record);
    } catch {
      /* a malformed line must not lose the rest of the manual */
    }
  }
  return facts;
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
    // The cache key includes the bbox set, so a page whose catalogued visuals
    // changed re-renders instead of serving a stale crop list.
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

const ingestManual = async (id: ManualId, opts: { force: boolean; limit: number }) => {
  const manual = MANUALS[id];
  const cfg = config();
  const pdfPath = path.resolve(cfg.MANUALS_DIR, manual.fileName);
  const layoutPath = path.resolve(process.cwd(), cfg.MANUALS_LAYOUT_DIR, `${id}.json`);
  const cacheDir = path.resolve(process.cwd(), "data", "render-cache", id);
  const evidenceDir = path.resolve(process.cwd(), "public", "evidence", id);

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`${manual.code} PDF not found: ${pdfPath}`);
  }
  if (!fs.existsSync(cfg.ESR_PYTHON)) {
    throw new Error(
      `Python interpreter not found: ${cfg.ESR_PYTHON}\nInstall it with: python3 -m venv .venv-mineru && .venv-mineru/bin/pip install mineru rapidocr-onnxruntime`
    );
  }
  fs.mkdirSync(evidenceDir, { recursive: true });

  const layout = loadLayout(layoutPath, id);
  let pages = [...layout.pages].sort((a, b) => a.page_idx - b.page_idx);
  const totalPages = pages.length;
  if (opts.limit > 0 && opts.limit < totalPages) {
    pages = pages.slice(0, opts.limit);
    console.log(`[ingest] ${manual.code}: limited to first ${opts.limit} of ${totalPages} pages`);
  }
  console.log(`[ingest] ${manual.code}: layout ${pages.length} pages from ${path.basename(layoutPath)}`);

  const facts = await readPageFacts(pdfPath, id, pages[0].page_idx + 1, pages[pages.length - 1].page_idx + 1);
  const labelled = [...facts.values()].filter((f) => f.printedPage || f.standard || f.chapter).length;
  console.log(
    `[ingest] ${manual.code}: page identity read for ${labelled}/${facts.size} pages` +
      (manual.numbering === "sheet" ? " (sheet-numbered)" : " (page-numbered)")
  );

  const chapterRe = chapterTitleRe(id);
  const chunks: IndexedChunk[] = [];
  const assets: VisualAsset[] = [];
  const pending: PendingVisual[] = [];

  let chapterTitle = "";
  let section = "";
  let now = Date.now();

  for (const page of pages) {
    const pageNo = page.page_idx + 1;
    const pageFacts = facts.get(pageNo);
    // A sheet-numbered manual's citation identity is the standard, so it
    // drives chapter tracking directly; a page-numbered one uses the chapter.
    // The chapter column also carries the standard, because every consumer of
    // `chapter` — the retrieval prior, the eval's chapter check, the badge —
    // reads that column and a NULL there would leave DOH and UGS with no
    // chapter prior at all.
    let chapterKey = pageFacts?.chapter ?? pageFacts?.standard ?? null;
    let standard = pageFacts?.standard ?? null;
    const blocks = [...page.blocks].sort((a, b) => a.index - b.index);

    for (const [index, block] of blocks.entries()) {
      const text = textOf(block);

      if (block.type === "doc_title") {
        const match = chapterRe.exec(text);
        if (match) {
          chapterKey = match[1].replace(/\s+/g, " ").replace(/[–—]/g, "-");
          // Only the sheet-numbered manuals carry a standard in their title
          // block. Setting it on a page-numbered one would make `ESR-3` render
          // as a standard number and put a bogus "standard" on every citation.
          if (!standard && manual.numbering === "sheet") standard = match[1];
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
      const sourceLink = evidencePageLink(id, pageNo);
      const location = {
        pageLabel: pageFacts?.printedPage ?? null,
        standard,
        sheetOf: pageFacts?.sheetOf ?? null,
        sheetCount: pageFacts?.sheetCount ?? null,
      };

      if (VISUAL_BLOCKS.has(block.type)) {
        // In these manuals a figure's caption is a sibling block, not part of
        // the image block — the image block's own content is empty. Without
        // this, every ADS figure was indexed under its section heading.
        const caption =
          itemOf(block, "image_caption", "chart_caption") ||
          captionFor(blocks, block, index) ||
          itemOf(block, "text") ||
          (section ? `${section} (${block.type})` : "");
        const assetId = `${id}-p${pageNo}-${block.index}`;
        const bbox = block.bbox;
        const asset: VisualAsset = {
          id: assetId,
          docId: id,
          page: pageNo,
          ...location,
          kind: (block.type === "chart" ? "diagram" : "figure") as VisualKind,
          chapter: chapterKey,
          sectionKey: section ? slug(section) : null,
          sectionPath: sectionPath || null,
          caption,
          figureUrl: null,
          thumbnailUrl: `/evidence/${id}/page-${pageNo}.png`,
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
            docId: id,
            page: pageNo,
            ...location,
            chunkType: "figure",
            evidenceType: "figure",
            text: caption,
            section,
            sectionKey: section ? slug(section) : null,
            chapter: chapterKey,
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
        // A table body is HTML with no typed wrapper: it arrives as the block's
        // raw content. Looking only for a `table_body` item found nothing in
        // ADS and silently dropped 200 tables, which is the densest evidence
        // the manual has.
        const html = itemOf(block, "table_body") || blockText(block);
        const caption = itemOf(block, "table_caption") || captionFor(blocks, block, index);
        const md = htmlTableToMarkdown(html);
        const body = [caption, md].filter(Boolean).join("\n\n");
        if (!body.trim()) continue;
        const assetId = `${id}-p${pageNo}-${block.index}`;
        const asset: VisualAsset = {
          id: assetId,
          docId: id,
          page: pageNo,
          ...location,
          kind: "table",
          chapter: chapterKey,
          standard,
          sectionKey: section ? slug(section) : null,
          sectionPath: sectionPath || null,
          caption: caption || section || `Table on ${manual.code} page ${pageNo}`,
          figureUrl: null,
          thumbnailUrl: `/evidence/${id}/page-${pageNo}.png`,
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
          docId: id,
          page: pageNo,
          ...location,
          chunkType: "table",
          evidenceType: "table",
          text: body,
          section,
          sectionKey: section ? slug(section) : null,
          chapter: chapterKey,
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
        id: `${id}-p${pageNo}-${block.index}`,
        docId: id,
        page: pageNo,
        ...location,
        chunkType: "text",
        evidenceType: "paragraph",
        text: section ? `${section}\n${text}` : text,
        section,
        sectionKey: section ? slug(section) : null,
        chapter: chapterKey,
        sourceLink,
        visualPath: null,
        createdAt: now,
        chunkRole: EXCEPTION_RE.test(text) ? "pre_visual_narrative" : "body",
        visualKind: null,
        pairedChunkIds: [],
        pairGroupId: null,
      });
    }
    now += 1;
  }

  console.log(
    `[ingest] ${manual.code}: parsed ${chunks.length} chunks and ${assets.length} visual assets`
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
          `${id}-p${page}`,
          items.map((i) => i.bbox),
          cacheDir,
          opts.force
        );
        if (!result.ok) {
          failed += 1;
          console.error(`[ingest] ${manual.code} page ${page} render failed: ${result.error}`);
          return;
        }
        // Copy cached renders into the manual's evidence directory.
        for (const name of [result.pagePng, ...(result.figures ?? []).map((f) => f.file)]) {
          if (!name) continue;
          const src = path.join(cacheDir, name);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(evidenceDir, name));
        }
        for (const fig of result.figures ?? []) {
          const item = items[fig.index];
          if (!item) continue;
          if (fig.error) {
            console.error(`[ingest] ${manual.code} page ${page} figure ${fig.index}: ${fig.error}`);
            continue;
          }
          if (fig.file) item.asset.figureUrl = `/evidence/${id}/${fig.file}`;
          const ocr = cleanOcr(fig.ocr ?? "");
          if (ocr) {
            item.asset.textLayers.ocr = ocr;
            ocrChunks.push({
              id: `${item.asset.id}-ocr`,
              docId: id,
              page: item.asset.page,
              pageLabel: item.asset.pageLabel,
              standard: item.asset.standard,
              sheetOf: item.asset.sheetOf,
              sheetCount: item.asset.sheetCount,
              chunkType: "text",
              evidenceType: "figure",
              text: `${item.asset.caption}\n${ocr}`,
              section: item.asset.sectionPath,
              sectionKey: item.asset.sectionKey,
              chapter: item.asset.chapter,
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
        if (rendered % 25 === 0) {
          console.log(`[ingest] ${manual.code}: rendered ${rendered}/${byPage.size} pages`);
        }
      })
    )
  );

  if (failed > 0) {
    throw new Error(
      `${manual.code}: ${failed} of ${byPage.size} pages failed to render. Refusing to index a ` +
        `partial manual; fix the renderer and re-run (add --force-render to bypass the cache).`
    );
  }

  const allChunks: StoredChunk[] = [...chunks, ...ocrChunks].map((c) => ({
    ...c,
    embedding: [],
  }));

  const withOcr = assets.filter((a) => a.textLayers.ocr).length;
  console.log(
    `[ingest] ${manual.code} ready: ${allChunks.length} chunks (${ocrChunks.length} from figure OCR), ` +
      `${assets.length} assets, ${withOcr} with transcribed figure text`
  );

  clearManual(id);
  upsertChunks(allChunks);
  upsertVisualAssets(assets);
  console.log(
    `[ingest] ${manual.code}: wrote ${allChunks.length} chunks and ${assets.length} assets to SQLite`
  );
  return { chunks: allChunks.length, assets: assets.length };
};

const parseArgs = () => {
  const argv = process.argv.slice(2);
  const ids: ManualId[] = [];
  let force = false;
  let limit = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force-render") {
      force = true;
    } else if (arg === "--limit") {
      limit = Number(argv[++i] ?? 0) || 0;
    } else if (arg === "--manual") {
      const value = argv[++i];
      if (value && value in MANUALS) {
        ids.push(value as ManualId);
      } else {
        throw new Error(`unknown manual: ${value} (known: ${Object.keys(MANUALS).join(", ")})`);
      }
    } else if (arg) {
      if (arg in MANUALS) {
        ids.push(arg as ManualId);
      } else {
        throw new Error(`unknown argument: ${arg}`);
      }
    }
  }
  return { ids: ids.length ? ids : (Object.keys(MANUALS) as ManualId[]), force, limit };
};

const main = async () => {
  const { ids, force, limit } = parseArgs();
  const started = Date.now();
  const totals = { chunks: 0, assets: 0 };

  // The evidence builder runs outside Node and still needs to know where each
  // manual is and what it calls itself, so the registry is written out here
  // rather than duplicated in the Python.
  const registryDir = path.resolve(process.cwd(), "data", "mineru");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "registry.json"),
    JSON.stringify(MANUAL_IDS.map((id) => MANUALS[id]), null, 2)
  );

  for (const id of ids) {
    const result = await ingestManual(id, { force, limit });
    totals.chunks += result.chunks;
    totals.assets += result.assets;
  }
  // No final FTS rebuild: upsertChunks keeps the index in step per document.
  // rebuildChunkFtsIndex() remains for first-build repair only.
  console.log(
    `[ingest] done: ${ids.map((i) => MANUALS[i].code).join(" + ")} · ` +
      `${totals.chunks} chunks · ${totals.assets} assets · ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
};

main().catch((error) => {
  console.error("[ingest] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
