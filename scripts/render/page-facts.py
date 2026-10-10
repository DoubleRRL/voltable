#!/usr/bin/env python3
"""Read citation identity off each PDF page's header and footer bands.

Emits one JSON object per page on stdout (JSONL), or to ``--out``.

Why this exists
---------------
Every SCE manual is printed from the same FrameMaker template: the running
header is the manual title, and the footer carries the printed page label, the
chapter or standard number, the effective date, and the section title. That
footer is the only place a citation can get a *stable* identity from. The PDF
page index is an artefact of which pages someone extracted into this file --
the ADS copy starts at printed page 10-1 as PDF page 1 -- so a planner cannot
look it up and it does not survive the next issue.

It also has to be positional. ``page.extract_text()`` on these files emits the
footer as a pile of unmerged fragments in no reliable order, but each fragment
carries its own text-matrix origin. Filtering by the y coordinate puts the
header and footer back in their own bands, and joining the fragments inside a
band is enough: the band is a *set* of tokens, and every token a citation needs
is in it exactly once.

Usage
-----
    page-facts.py <pdf> <config.json> <first_page> <last_page> [--out f]

``config.json`` is one serialised entry from ``footerRulesFor`` in
``src/lib/rag/docs.ts``; the Node ingest writes it, so the manual's numbering
scheme is defined in exactly one place.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader

# Fraction of the page height occupied by the running header and footer. The
# footer is two rows tall on these templates, so the band has to clear both.
HEADER_BAND = (0.915, 1.0)
FOOTER_BAND = (0.0, 0.115)

# Effective dates are always printed with a four-digit year, which is what
# keeps them from colliding with a printed page label like "10-28".
DATE_RE = re.compile(r"\b(\d{1,2}[-/]\d{1,2}[-/]\d{4})\b")
# The printed page label, e.g. "10-8", "3-24", "2 - 12". Deliberately *not*
# anchored on the literal "PAGE": the two sit on different baselines and come
# out of extract_text() in arbitrary order, so adjacency is not available.
PAGE_LABEL_RE = re.compile(r"\b(\d{1,4}\s*[-–—]\s*\d{1,4})\b")
CHAPTER_RE = re.compile(r"\b(ESR|ADS|PLM)[-–—]\s*(\d+)\b")
# Standard numbers look like "AC 120", "CD 132", "SS564", "MC830".
STANDARD_RE = re.compile(r"\b([A-Z]{2,4}\s?\d{2,4})\b")
SHEET_RE = re.compile(r"\b(\d{1,4})\s*of\s*(\d{1,4})\b", re.IGNORECASE)


def band_fragments(page, low: float, high: float) -> list[tuple[float, float, str]]:
    """Every text fragment whose baseline sits inside the band, in reading order."""
    height = float(page.mediabox.height)
    low_pt, high_pt = low * height, high * height
    fragments: list[tuple[float, float, str]] = []

    def visitor(text, cm, tm, font_dict, font_size):
        collapsed = " ".join(text.split())
        if collapsed:
            fragments.append((tm[5], tm[4], collapsed))

    page.extract_text(visitor_text=visitor)
    inside = [f for f in fragments if low_pt <= f[0] <= high_pt]
    # Sort by y descending then x ascending purely so output is stable across
    # runs; nothing below depends on the resulting order except page-label
    # association, which uses the original coordinates.
    inside.sort(key=lambda f: (-round(f[0], 1), f[1]))
    return inside


def band_text(fragments) -> str:
    return " ".join(text for _, _, text in fragments)


def resolve_page_label(fragments) -> str | None:
    """Find the printed page label by association with its ``PAGE`` token.

    The footer band holds the section title too, and ESR section titles end in
    a voltage -- "Underground Service Connections 0-600 V" -- which is a
    dash-pair indistinguishable from a page label in the flattened text. The
    literal ``PAGE`` token is its own fragment on all three page-numbered
    manuals, so the label is the dash-pair fragment sitting nearest to it in
    the footer rather than the first one that happens to match.
    """
    anchors = [f for f in fragments if f[2].strip().upper().startswith("PAGE")]
    candidates = [f for f in fragments if PAGE_LABEL_RE.fullmatch(f[2].strip())]
    if not candidates:
        return None
    if not anchors:
        return candidates[0][2]
    best = min(
        candidates,
        key=lambda c: (
            min(abs(c[0] - a[0]) for a in anchors),
            min(abs(c[1] - a[1]) for a in anchors),
        ),
    )
    return re.sub(r"\s*[-–—]\s*", "-", best[2].strip())


def parse(rules: dict, fragments) -> dict:
    footer = band_text(fragments)
    # Key names match the TypeScript PageFacts so ingest reads them by name.
    # Emitting "sheet" here read as `sheetOf: undefined` on the other side and
    # silently dropped the sheet number from every sheet-numbered citation.
    out = {
        "printedPage": None,
        "chapter": None,
        "standard": None,
        "sheetOf": None,
        "sheetCount": None,
        "effectiveDate": None,
    }

    date = DATE_RE.search(footer)
    if date:
        out["effectiveDate"] = date.group(1)

    if rules.get("numbering") == "page":
        out["printedPage"] = resolve_page_label(fragments)
        chapter = CHAPTER_RE.search(footer)
        if chapter:
            out["chapter"] = f"{chapter.group(1).upper()}-{chapter.group(2)}"
    else:
        standard = STANDARD_RE.search(footer)
        if standard:
            out["standard"] = re.sub(r"\s+", " ", standard.group(1).strip())
        sheet = SHEET_RE.search(footer)
        if sheet:
            out["sheetOf"] = int(sheet.group(1))
            out["sheetCount"] = int(sheet.group(2))

    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pdf")
    ap.add_argument("config")
    ap.add_argument("first_page", type=int)
    ap.add_argument("last_page", type=int)
    ap.add_argument("--out")
    args = ap.parse_args()

    rules = json.loads(Path(args.config).read_text())
    reader = PdfReader(args.pdf)
    last = min(args.last_page, len(reader.pages))

    sink = open(args.out, "w", encoding="utf-8") if args.out else sys.stdout
    try:
        for number in range(max(1, args.first_page), last + 1):
            try:
                page = reader.pages[number - 1]
                header_frags = band_fragments(page, *HEADER_BAND)
                footer_frags = band_fragments(page, *FOOTER_BAND)
                record = {
                    "page": number,
                    "header": band_text(header_frags).strip(),
                    **parse(rules, footer_frags),
                }
            except Exception as exc:  # a bad page must not abort the manual
                record = {"page": number, "header": "", "error": str(exc)[:200]}
            sink.write(json.dumps(record) + "\n")
    finally:
        if sink is not sys.stdout:
            sink.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
