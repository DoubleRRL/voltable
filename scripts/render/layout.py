#!/usr/bin/env python3
"""Produce a MinerU layout model for a manual.

Why not the `mineru parse` CLI: in 4.x that command outputs *content* --
markdown by default, JSON if you ask -- and writes it to `--output`. It does
not emit the layout model this pipeline ingests. `doc_analyze` is the same
engine underneath and returns the model directly, so the layout a figure or
table bbox comes from is the one the parser actually saw.

The layout is what makes ingest layout-aware: block type comes from the parser
rather than from regexes over markdown, so "is this a figure" and "is this a
header" are answered by the document model instead of guessed. Recreating it
with heuristics would trade that away.

usage:
    layout.py <pdf> <out.json> [--effort flash|medium|high|xhigh]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


def normalize(payload: dict) -> dict:
    """Reshape the parser's model into the schema ingest reads.

    `doc_analyze` returns `pages` as a list of per-page block lists. Ingest needs
    the page index alongside the blocks so it can address a citation, and needs a
    stable per-page `index` on each block because asset and chunk ids are built
    from it. Doing that here means exactly one place knows both shapes.
    """
    pages = payload.get("pages") or []
    out_pages = []
    for page_idx, blocks in enumerate(pages):
        if isinstance(blocks, dict):
            # Already in the addressed shape; keep it and only fill in gaps.
            page_idx = int(blocks.get("page_idx", page_idx))
            blocks = blocks.get("blocks") or []
        normalized = []
        for position, block in enumerate(blocks or []):
            if not isinstance(block, dict):
                continue
            normalized.append(
                {
                    "type": block.get("type", "text"),
                    "index": block.get("index", position),
                    "bbox": block.get("bbox"),
                    "content": block.get("content") or [],
                }
            )
        out_pages.append({"page_idx": page_idx, "blocks": normalized})
    return {
        "schema_version": payload.get("schema_version"),
        "extensions": payload.get("extensions") or {},
        "pages": out_pages,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pdf", nargs="?")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--effort", default="high", choices=["flash", "medium", "high", "xhigh"])
    ap.add_argument("--force", action="store_true")
    ap.add_argument(
        "--renormalize",
        help="Reshape an existing layout file in place; no inference is run.",
    )
    args = ap.parse_args()

    if args.renormalize:
        path = Path(args.renormalize)
        payload = normalize(json.loads(path.read_text()))
        tmp = path.with_suffix(path.suffix + ".partial")
        tmp.write_text(json.dumps(payload, ensure_ascii=False))
        os.replace(tmp, path)
        print(f"[layout] renormalised {path.name}: {len(payload['pages'])} pages")
        return 0

    if not args.pdf or not args.out:
        ap.error("pdf and out are required unless --renormalize is given")

    out = Path(args.out)
    if out.exists() and out.stat().st_size > 0 and not args.force:
        print(f"[layout] {out.name} already present, skipping")
        return 0

    # Model inference spawns worker processes, and spawn re-imports __main__ by
    # path. Running this module as a file is what makes that work; the same call
    # pasted into a heredoc dies with FileNotFoundError on '<stdin>'.
    from mineru.backend.analyze import doc_analyze

    source = Path(args.pdf)
    if not source.exists():
        print(f"[layout] missing source: {source}", file=sys.stderr)
        return 1

    data = source.read_bytes()
    started = time.time()
    print(f"[layout] {source.name}: analysing with effort={args.effort}", flush=True)
    _middle, model = doc_analyze(data, effort=args.effort, parse_mode="auto", image_analysis=True)

    payload = normalize(model.model_dump() if hasattr(model, "model_dump") else model.dict())
    out.parent.mkdir(parents=True, exist_ok=True)
    # Write to a sibling then rename: a killed run must not leave a truncated
    # file that the next run treats as complete.
    tmp = out.with_suffix(out.suffix + ".partial")
    tmp.write_text(json.dumps(payload, ensure_ascii=False))
    os.replace(tmp, out)

    pages = payload["pages"]
    visuals = sum(
        1 for p in pages for b in p["blocks"] if b["type"] in ("image", "chart", "table")
    )
    print(
        f"[layout] {source.name}: {len(pages)} pages, {visuals} visual blocks, "
        f"{time.time() - started:.0f}s -> {out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
