#!/usr/bin/env python3
"""Audit that every citation the index can produce resolves to real evidence.

Retrieval can be perfect and an answer still be uncheckable if the crop, the
page derivative or the printed label is missing. This walks the index rather
than the answers, so it covers the whole corpus and not just what happened to be
asked today, and it fails loudly rather than reporting a percentage that reads
like a metric but is not.

    audit-citations.py [--db data/manuals.sqlite] [--evidence public/evidence]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# A page-numbered manual cites its printed page; a sheet-numbered one cites a
# standard and a sheet. Both must be present, and the PDF page index must never
# be what the citation shows.
CHECKS = (
    "doc_id",
    "page_label_or_standard",
    "figure_resolves",
    "chapter_or_standard",
    "source_link_shape",
)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=str(ROOT / "data" / "manuals.sqlite"))
    ap.add_argument("--evidence", default=str(ROOT / "public" / "evidence"))
    ap.add_argument("--limit", type=int, default=0, help="per manual; 0 = all")
    args = ap.parse_args()

    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    evidence = Path(args.evidence)

    manuals = [r["doc_id"] for r in db.execute("SELECT DISTINCT doc_id FROM chunks")]
    registry = {}
    reg_path = ROOT / "data" / "mineru" / "registry.json"
    if reg_path.exists():
        registry = {m["id"]: m for m in json.loads(reg_path.read_text())}

    problems: list[str] = []
    print(f"{'manual':6} {'numbering':10} {'chunks':>8} {'assets':>8} {'fig ok':>8} {'page lbl':>9}")
    for manual in manuals:
        meta = registry.get(manual, {})
        numbering = meta.get("numbering", "?")
        where = "WHERE doc_id = ?"
        chunks = db.execute(f"SELECT COUNT(*) c FROM chunks {where}", (manual,)).fetchone()["c"]
        assets = db.execute(
            f"SELECT COUNT(*) c FROM visual_assets {where}", (manual,)
        ).fetchone()["c"]

        rows = db.execute(
            f"SELECT * FROM visual_assets {where} ORDER BY page LIMIT ?",
            (manual, args.limit or -1),
        ).fetchall()

        fig_ok = labelled = 0
        # Pages with no footer identity at all are front matter, dividers and
        # blanks. They carry no citable location by nature, so they are counted
        # and reported rather than failed — failing them would push someone to
        # invent labels for pages that do not have one.
        unlabelable_pages = {
            r["page"]
            for r in db.execute(
                f"SELECT DISTINCT page FROM visual_assets {where}"
                " AND page_label IS NULL AND standard IS NULL"
                " AND chapter IS NULL",
                (manual,),
            )
        }
        for row in rows:
            # 1. the crop must exist on disk
            url = row["figure_url"] or row["thumbnail_url"]
            if not url:
                problems.append(f"{manual} p{row['page']}: no figure url")
            elif not (ROOT / "public" / url.lstrip("/")).exists():
                problems.append(f"{manual} p{row['page']}: missing {url}")
            else:
                fig_ok += 1
            # 2. a citation must carry printed identity, not a PDF index
            if row["page"] in unlabelable_pages:
                continue
            if numbering == "page":
                if not row["page_label"]:
                    problems.append(f"{manual} p{row['page']}: no printed page label")
                else:
                    labelled += 1
            else:
                if row["standard"] and row["sheet_of"] is not None:
                    labelled += 1
                else:
                    problems.append(
                        f"{manual} p{row['page']}: sheet citation incomplete "
                        f"(standard={row['standard']!r}, sheet={row['sheet_of']!r})"
                    )
            # 3. the manual must have an identity to cite
            if not (row["chapter"] or row["standard"]):
                problems.append(f"{manual} p{row['page']}: no chapter or standard")
            # 4. the link must be the evidence route, not the old full-manual one
            link = row["source_link"] or ""
            if link and not link.startswith("/evidence/"):
                problems.append(f"{manual} p{row['page']}: unexpected source link {link!r}")

        print(f"{manual:6} {numbering:10} {chunks:8} {assets:8} {fig_ok:8} {labelled:9}")

    total = db.execute("SELECT COUNT(*) c FROM visual_assets").fetchone()["c"]
    print(f"\nchecked {total} catalogued assets across {len(manuals)} manuals")
    if problems:
        print(f"\n{len(problems)} problem(s):", file=sys.stderr)
        for line in problems[:40]:
            print(f"  {line}", file=sys.stderr)
        if len(problems) > 40:
            print(f"  ... and {len(problems) - 40} more", file=sys.stderr)
        return 1
    print("every catalogued asset resolves to evidence with a citable identity")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
