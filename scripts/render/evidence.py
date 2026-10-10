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


def cited_pages(
    db: sqlite3.Connection, docs: list[str] | None, include_tables: bool = False
) -> dict[str, list[int]]:
    """Pages that need a one-page derivative.

    Pages carrying a figure or diagram, by default. A table-only page is already
    served better by its crop plus the table's own extracted markdown, and a
    derivative of it earned nothing: across the three manuals indexed so far,
    figure pages are 574 of 1,051 and the table-only remainder cost 160 MB of
    PDFs nobody opens. `--all-pages` puts them back.

    Everything not in this set still ships as a page render, so a citation never
    has nothing to open.
    """
    clauses = []
    params: list = []
    if docs:
        clauses.append(f"doc_id IN ({','.join('?' * len(docs))})")
        params = list(docs)
    if not include_tables:
        clauses.append("kind IN ('figure','diagram')")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
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
        keep = set(numbers)
        # Stale derivatives from an earlier, wider run would otherwise ride
        # along in the bundle: they are real pages, just not ones anything
        # cites any more.
        for existing in target.glob("page-*.pdf"):
            try:
                if int(existing.stem.split("-", 1)[1]) not in keep:
                    existing.unlink()
            except (ValueError, IndexError):
                continue
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


def pages_without_assets(db: sqlite3.Connection) -> dict[str, set[int]]:
    """Cited pages that have no catalogued crop — the only ones needing a render.

    A page render is a fallback for a cited page nothing was catalogued on. Where
    a crop exists the render is the same drawing a second time at twice the
    pixels, and across the three manuals indexed so far that redundancy was about
    420 MB of the bundle.
    """
    rows = db.execute(
        "SELECT DISTINCT doc_id, page FROM visual_assets WHERE kind IN ('figure','diagram')"
    ).fetchall()
    with_asset: dict[str, set[int]] = {}
    for doc_id, page in rows:
        with_asset.setdefault(doc_id, set()).add(page)

    needed: dict[str, set[int]] = {}
    for doc_id, page in db.execute("SELECT DISTINCT doc_id, page FROM chunks").fetchall():
        if page not in with_asset.get(doc_id, ()):
            needed.setdefault(doc_id, set()).add(page)
    return needed


def optimise_images(
    db: sqlite3.Connection, out_root: Path, docs: list[str] | None, limit: int
) -> None:
    """Emit lossless WebP at display sizes, and drop redundant page renders."""
    from PIL import Image

    renders_kept = pages_without_assets(db)

    for doc_dir in sorted(p for p in out_root.iterdir() if p.is_dir()):
        if docs and doc_dir.name not in docs:
            continue
        pngs = sorted(doc_dir.glob("*.png"))
        if limit:
            pngs = pngs[:limit]
        kept = dropped = 0
        for png in pngs:
            if png.stem.startswith("page-"):
                try:
                    page_no = int(png.stem.split("-", 1)[1])
                except (ValueError, IndexError):
                    page_no = -1
                if page_no not in renders_kept.get(doc_dir.name, set()):
                    png.unlink()
                    dropped += 1
                    continue
                longest = PAGE_MAX
            else:
                longest = CROP_MAX
            target = png.with_suffix(".webp")
            with Image.open(png) as im:
                # Line art and schematics: lossless, so a dimension stays
                # readable and no callout edge fringes. WebP lossless on this
                # material runs about 30% under PNG.
                if max(im.size) > longest:
                    scale = longest / float(max(im.size))
                    im = im.convert("RGB").resize(
                        (max(1, int(im.width * scale)), max(1, int(im.height * scale))),
                        Image.LANCZOS,
                    )
                else:
                    im = im.convert("RGB")
                im.save(target, "WEBP", lossless=True, method=4)
            png.unlink()
            kept += 1

        # Point the index at what actually shipped.
        db.execute(
            "UPDATE visual_assets SET"
            " figure_url = replace(figure_url, '.png', '.webp'),"
            " thumbnail_url = replace(thumbnail_url, '.png', '.webp')"
            " WHERE doc_id = ?",
            (doc_dir.name,),
        )
        db.commit()
        print(f"[evidence] {doc_dir.name}: {kept} webp, {dropped} redundant page renders dropped")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["build", "plan"])
    ap.add_argument("--docs", help="comma-separated manual ids")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default=str(ROOT / "public" / "evidence"))
    ap.add_argument(
        "--all-pages",
        action="store_true",
        help="Also emit derivatives for table-only pages (larger bundle).",
    )
    args = ap.parse_args()

    if not DB.exists():
        print(f"[evidence] no index at {DB}; run npm run ingest:manuals", file=sys.stderr)
        return 1
    docs = args.docs.split(",") if args.docs else None
    out_root = Path(args.out)

    db = sqlite3.connect(DB)
    pages = cited_pages(db, docs, include_tables=args.all_pages)

    if args.command == "plan":
        total = sum(len(v) for v in pages.values())
        for doc_id, numbers in pages.items():
            print(f"{doc_id}: {len(numbers)} pages")
        print(f"total page derivatives: {total}")
        return 0

    db.row_factory = sqlite3.Row
    written = write_page_pdfs(manual_pdfs(), pages, out_root)
    optimise_images(db, out_root, docs, args.limit)
    print(f"[evidence] {written} page derivatives under {out_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
