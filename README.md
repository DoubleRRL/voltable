# ESR Assistant (local RAG)

Ask questions about **Electrical Service Requirements (ESR)** using a local SQLite index, with answers that include **citations** and **figure/table evidence** linked into the PDF.

## Prerequisites

- Node 20+
- [Ollama](https://ollama.com) running at `http://127.0.0.1:11434` with **Qwen 2.5** (default in `.env.example` is `qwen2.5:latest`; pull with `ollama pull qwen2.5`)
- Optional: `OPENAI_API_KEY` for embedding generation during ingest (see `.env.example`)
- Native `@firecrawl/pdf-inspector` binary for your platform (installed via npm optional deps). Ingest **fails loudly** if the binary is missing — there is no pdf.js text fallback.

## Setup

From this directory (`esr-rag/`):

```bash
cp .env.example .env.local
npm install
npm run ingest:esr
npm run dev
```

Open **http://localhost:3001/** and type a question.

### PDF location

If the ESR PDF lives in the **parent** folder (for example `../Electrical Service Requirements (ESR).pdf` next to `esr-rag/`), the default `ESR_PDF_PATH` in `.env.example` already targets it. The resolver also falls back to common filenames under the monorepo root. **`npm run ingest:esr` copies the resolved PDF to `public/esr.pdf`**, so `/esr.pdf#page=` links in the UI work.

### “Evidence first” in the UI

Use the **Evidence first** checkbox in the header to (1) **bias retrieval** toward figure/table chunks and (2) **de-emphasize** the long answer behind a disclosure while the evidence sidebar stays prominent when figures exist.

Equivalent API flag: `"visualFirst": true` on the same JSON body as `messages` / `question`.

You can optionally run a production build on the same machine:

```bash
npm run build
npm run start
```

## API (used by the bundled UI)

`POST /api/webapi/chat/ollama`

```json
{
  "messages": [{ "role": "user", "content": "Your question here" }],
  "stream": true,
  "visualFirst": false
}
```

- With `"stream": true`, the response is **SSE**: events `text`, `usage`, and `done`. The `done` payload includes `message.citations` and `message.figures`.
- With `"stream": false`, the response is a single JSON object with the same fields.
- With `"visualFirst": true`, retrieval favors figure/table chunks and the server **merges all figure/table evidence for retrieved pages** into `message.figures` (not only the model’s pick).

Alternatively, send `{ "question": "...", "visualFirst": true }` instead of `messages`.

## Ingest

`npm run ingest:esr` rebuilds the local SQLite index from `ESR_PDF_PATH` and copies the PDF to `public/esr.pdf`.

**Primary extractor:** [`@firecrawl/pdf-inspector`](https://github.com/firecrawl/pdf-inspector) (`extractPagesMarkdown` / `processPdf`) — per-page Markdown with headings, captions, and `|` tables. Narrative↔visual pairing is rebuilt from that Markdown (example blocks excluded). Redundant `full_page_aux` / table-oriented-line duplicate chunks are **not** emitted.

**Thumbnails only:** pdf.js + `canvas` render page PNGs under `public/figures/` for the evidence rail — not used for text extraction.

**Visual assets:** every non-example table/figure/diagram is stored in SQLite `visual_assets` with section path, ingest-time exceptions, supporting chunk ids, and optional OCR text layers. A review catalog is written to `data/eval/visual-catalog.json`.

**Optional OCR** (off by default): set `ESR_OCR=1` (or `npm run ingest:esr:ocr`) to run `scripts/ocr/ocr_page.py` on pages flagged `needs_ocr` or figure/diagram pages with weak text. Output is postprocessed (`scripts/ocr/esr_postprocess.py` — ft/in + facet keywords) and stored as `chunk_role: diagram_ocr` plus `visual_assets.text_layers.ocr`. See [`scripts/ocr/README.md`](scripts/ocr/README.md).

```bash
# Default (no OCR sidecar)
npm run ingest:esr

# With OCR when Surya is available
npm run ingest:esr:ocr
# or:
ESR_OCR=1 ESR_OCR_PYTHON=.venv-ocr/bin/python npm run ingest:esr
```

## Eval

Prefer a **small SME-labeled** golden set (`data/eval/golden.sample.json` with hand-checked `goldPage` values).

`npm run eval:golden:refresh` (`scripts/refresh-golden-pages.ts`) is **bootstrap-only**: it sets `goldPage` to the current top retrieval hit so you can scaffold questions. It is **not** a success metric — hit@k against auto-refreshed pages is circular. Re-label with an SME before trusting eval rates.

```bash
npm run eval:esr
# optional scaffolding only — then overwrite goldPage with SME labels
npm run eval:golden:refresh
```
