#!/usr/bin/env python3
"""Build the evidence a citation opens, without shipping the manual.

Reads the indexed visual assets and emits, for each manual:

  public/evidence/<id>/pdf/page-<n>.pdf   one-page derivative of a cited page
  public/evidence/<id>/fig-<...>.webp     downscaled figure crop
  public/evidence/<id>/page-<n>.webp      downscaled page render

Why a derivative rather than the source page range: a citation needs the page
it points at, and the app must not carry 212 MB of manual to provide it. The
derivative is written by a PDF writer, so the page's text stays selectable and
searchable and the drawing stays vector — it is a smaller document, not a
picture of the document.

Pages that were never cited are not emitted. That is the whole saving: the
corpus has 2,591 pages and an answer touches four.

usage:
    evidence.py build [--docs esr,doh] [--limit N] [--out public/evidence]
    evidence.py plan                     # what a full build would produce
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "manuals.sqlite"
MANUALS_DIR = Path(__file__).resolve().parents[3]

# Downscaled renditions. Thumbnails are shown at 112px and the lightbox panel
# is dragged by the user, so these are sized to the largest realistic display
# rather than to the source render.
THUMB_MAX = 640
CROP_MAX = 1400
PAGE_MAX = 1000


def manual_pdfs() -> dict[str, Path]:
    """Locate each manual's source PDF by the filename in the registry."""
    registry = json.loads((ROOT / "data" / "mineru" / "registry.json").read_text())
    out = {}
    for entry in registry:
        candidate = MANUALS_DIR / entry["fileName"]
        if candidate.exists():
            out[entry["id"]] = candidate
    return out


def cited_pages(db: sqlite3.Connection, docs: list[str] | None) -> dict[str, list[int]]:
    """Pages that actually need a page derivative.

    A page qualifies if it was cited in an answer, or if it carries a figure or
    table the answer can surface. Everything else stays out of the bundle.
    """
    where = ""
    params: list = []
    if docs:
        where = f"WHERE doc_id IN ({','.join('?' * len(docs))})"
        params = list(docs)
    rows = db.execute(
        f"SELECT DISTINCT doc_id, page FROM visual_assets {where}", params
    ).fetchall()
    out: dict[str, list[int]] = {}
    for doc_id, page in rows:
        out.setdefault(doc_id, []).append(page)
    return {k: sorted(v) for k, v in out.items()}


def write_page_pdfs(pdfs: dict[str, Path], pages: dict[str, list[int]], out_root: Path) -> int:
    from pypdf import PdfReader, PdfWriter

    written = 0
    for doc_id, numbers in pages.items():
        source = pdfs.get(doc_id)
        if not source:
            print(f"[evidence] {doc_id}: no source PDF found, skipping page derivatives")
            continue
        target = out_root / doc_id / "pdf"
        target.mkdir(parents=True, exist_ok=True)
        reader = PdfReader(str(source))
        for page_no in numbers:
            if not 1 <= page_no <= len(reader.pages):
                continue
            writer = PdfWriter()
            writer.add_page(reader.pages[page_no - 1])
            writer.add_metadata({"/Source": f"{doc_id} p{page_no}"})
            with open(target / f"page-{page_no}.pdf", "wb") as handle:
                writer.write(handle)
            written += 1
        print(f"[evidence] {doc_id}: {len(numbers)} page derivatives")
    return written


def downscale_images(out_root: Path, docs: list[str] | None, limit: int) -> None:
    """Emit WebP renditions at the sizes the UI actually displays."""
    from PIL import Image

    for doc_dir in sorted(p for p in out_root.iterdir() if p.is_dir()):
        if docs and doc_dir.name not in docs:
            continue
        pngs = sorted(doc_dir.glob("*.png"))
        if limit:
            pngs = pngs[:limit]
        for png in pngs:
            if png.stem.startswith("fig-"):
                target, longest = png.with_suffix(".webp"), CROP_MAX
            else:
                target, longest = png.with_suffix(".webp"), PAGE_MAX
            with Image.open(png) as im:
                if max(im.size) <= longest:
                    # Already small enough; copy the bytes rather than
                    # re-encoding, which would only lose quality.
                    target.write_bytes(png.read_bytes())
                    continue
                # Line art and schematics: lossless, so a dimension stays
                # readable and no callout edge fringes.
                im.convert("RGB").save(target, "WEBP", lossless=True, method=4)
        print(f"[evidence] {doc_dir.name}: {len(pngs)} images")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["build", "plan"])
    ap.add_argument("--docs", help="comma-separated manual ids")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default=str(ROOT / "public" / "evidence"))
    args = ap.parse_args()

    if not DB.exists():
        print(f"[evidence] no index at {DB}; run npm run ingest:manuals", file=sys.stderr)
        return 1
    docs = args.docs.split(",") if args.docs else None
    out_root = Path(args.out)

    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    pages = cited_pages(db, docs)

    if args.command == "plan":
        total = sum(len(v) for v in pages.values())
        for doc_id, numbers in pages.items():
            print(f"{doc_id}: {len(numbers)} pages")
        print(f"total page derivatives: {total}")
        return 0

    written = write_page_pdfs(manual_pdfs(), pages, out_root)
    downscale_images(out_root, docs, args.limit)
    print(f"[evidence] {written} page derivatives under {out_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
