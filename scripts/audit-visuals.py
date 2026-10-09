#!/usr/bin/env python3
"""Figure/table-vs-section cross-check over the indexed ESR.

Every ESR section generally states in prose what its visual aids show, then
gives the drawing or table. This script tests that claim corpus-wide: for
each visual asset it compares what the visual says (OCR text / table
markdown) against what the same page's section text says, and reports where
the two disagree.

Three checks, all measurement-first (planners ask about numbers, and numbers
are what can be checked mechanically):

1. MEASUREMENTS — distinctive numbers-with-units in the visual that never
   appear in the section text (e.g. a figure calling out 36" MIN with no
   matching 36 in the prose), and vice versa.
2. FIGURE REFERENCES — the section prose never names the figure ("Figure
   5-4"), which usually means the figure floats unintroduced.
3. CODE TABLES — table columns made of single-letter codes (A/U/C/B) with no
   same-page `X = ...` legend line. This exact shape once made the app answer
   "approved" against a row that says U.

Usage:
    python3 scripts/audit-visuals.py [DB_PATH]

Prints a summary plus the worst offenders. Exit 0 always; this is a report,
not a gate — judgement about which mismatches matter stays human.
"""

import json
import re
import sqlite3
import sys
from collections import defaultdict

DB = sys.argv[1] if len(sys.argv) > 1 else "data/esr.sqlite"

UNIT_MAP = {
    "inch": "in", "inches": "in", "in": "in", '"': "in",
    "foot": "ft", "feet": "ft", "ft": "ft", "'": "ft",
    "volt": "v", "volts": "v", "v": "v",
    "amp": "a", "amps": "a", "ampere": "a", "amperes": "a", "a": "a",
    "percent": "pct", "%": "pct",
    "milligauss": "mg", "gauss": "mg", "mg": "mg",
    "kilovolt": "kv", "kilovolts": "kv", "kv": "kv",
}

MEASURE_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(inches|inch|feet|foot|volts|volt|amps|ampere|amperes|amp|percent|milligauss|gauss|kilovolts|kilovolt|in|ft|v|a|mg|kv|hz|%|\"|')\b",
    re.IGNORECASE,
)

FIGURE_REF_RE = re.compile(r"figure\s+(\d+)\s*[–-]\s*(\d+)", re.IGNORECASE)
FIGURE_TITLE_RE = re.compile(r"figure\s+(\d+)\s*[–-]\s*(\d+)\s*:", re.IGNORECASE)
CODE_CELL_RE = re.compile(r"^\s*([A-Z])\s*$")
LEGEND_RE = re.compile(r"(^|[\s(])([A-Z])\s*=\s*([^;.\n]+)")


def norm_number(raw: str) -> str:
    try:
        return ("%.3f" % float(raw)).rstrip("0").rstrip(".")
    except ValueError:
        return raw


def body_text(markdown: str) -> str:
    """Table body without the title line: titles ("Table 6-2: ...") name the
    table while the prose cites body values, so matching titles against prose
    only manufactures mismatches. All data rows stay — dropping those would
    hide exactly the rows planners ask about."""
    lines = (markdown or "").split("\n")
    if lines and "|" not in lines[0]:
        lines = lines[1:]
    return "\n".join(lines)


def measurements(text: str) -> set:
    out = set()
    for num, unit in MEASURE_RE.findall(text or ""):
        unit = unit.lower()
        # A bare "a" matches the indefinite article constantly; only keep it
        # glued to a number in an electrical sense is still noisy, so the
        # caller decides — here we keep it, the diff sorts it out.
        mapped = UNIT_MAP.get(unit, unit)
        out.add(f"{norm_number(num)} {mapped}")
    return out


def figure_numbers(text: str) -> set:
    return set(FIGURE_REF_RE.findall(text or ""))


def table_codes(markdown: str) -> set:
    """Single-letter cells in a markdown table body (not the separator row)."""
    codes = set()
    for line in (markdown or "").split("\n"):
        if not line.strip().strip("|").strip():
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if cells and all(set(c) <= set("-: ") for c in cells):
            continue  # separator row
        for cell in cells:
            m = CODE_CELL_RE.match(cell)
            if m:
                codes.add(m.group(1))
    return codes


def legend_for(code: str, texts: list) -> str | None:
    pattern = re.compile(r"(^|[\s(])" + re.escape(code) + r"\s*=\s*([^;.\n]+)")
    for text in texts:
        m = pattern.search(text or "")
        if m:
            return m.group(2).strip()
    return None


def main() -> None:
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row

    assets = db.execute(
        "SELECT id, page, kind, caption, figure_url, text_layers_json FROM visual_assets ORDER BY page"
    ).fetchall()
    chunks = db.execute(
        "SELECT id, page, chunk_type, section, text FROM chunks ORDER BY page, id"
    ).fetchall()
    by_page: dict = defaultdict(list)
    for c in chunks:
        by_page[c["page"]].append(c)

    report = {
        "assets_checked": 0,
        "measurement_mismatches": [],
        "unreferenced_figures": [],
        "codeless_legends": [],
    }

    for asset in assets:
        try:
            layers = json.loads(asset["text_layers_json"] or "{}")
        except json.JSONDecodeError:
            layers = {}
        ocr = layers.get("ocrText") or ""
        markdown = layers.get("tableMarkdown") or ""
        visual_text = (body_text(markdown) + "\n" + ocr).strip()
        if not visual_text:
            continue
        page_chunks = [c for c in by_page.get(asset["page"], []) if c["chunk_type"] == "text"]
        section_text = "\n".join(c["text"] for c in page_chunks)
        if not section_text.strip():
            continue
        report["assets_checked"] += 1

        # 1. measurements both ways
        vis_meas = measurements(visual_text)
        sec_meas = measurements(section_text)
        only_visual = sorted(vis_meas - sec_meas)
        only_section = sorted(sec_meas - vis_meas)
        # A figure legitimately shows a subset; flag only when the visual
        # carries numbers the prose never states (the direction that burns).
        if only_visual:
            report["measurement_mismatches"].append({
                "page": asset["page"],
                "caption": (asset["caption"] or "")[:70],
                "in_visual_not_prose": only_visual[:8],
            })

        # 2. figure references
        title_no = set(FIGURE_TITLE_RE.findall(asset["caption"] or ""))
        if title_no and not (title_no & figure_numbers(section_text)):
            report["unreferenced_figures"].append({
                "page": asset["page"],
                "caption": (asset["caption"] or "")[:70],
            })

        # 3. code tables without a legend
        codes = table_codes(markdown)
        if codes:
            missing = [c for c in sorted(codes) if not legend_for(c, [section_text, visual_text])]
            if missing:
                report["codeless_legends"].append({
                    "page": asset["page"],
                    "caption": (asset["caption"] or "")[:70],
                    "codes_without_legend": missing,
                })

    print(f"assets checked: {report['assets_checked']}")
    print(f"visuals with numbers the prose never states: {len(report['measurement_mismatches'])}")
    print(f"figures never named in their section: {len(report['unreferenced_figures'])}")
    print(f"code tables with no same-page legend: {len(report['codeless_legends'])}")

    def show(title, rows, fmt):
        print(f"\n=== {title} ({len(rows)}) ===")
        for r in rows[:15]:
            print(fmt(r))
        if len(rows) > 15:
            print(f"... and {len(rows) - 15} more")

    show("MEASUREMENTS in visual, not in prose", report["measurement_mismatches"],
         lambda r: f"p.{r['page']} {r['caption']} :: {', '.join(r['in_visual_not_prose'])}")
    show("FIGURES never named in section", report["unreferenced_figures"],
         lambda r: f"p.{r['page']} {r['caption']}")
    show("CODE TABLES with no legend", report["codeless_legends"],
         lambda r: f"p.{r['page']} {r['caption']} :: codes {', '.join(r['codes_without_legend'])}")

    with open("/tmp/visual-audit.json", "w") as f:
        json.dump(report, f, indent=1)
    print("\nfull report -> /tmp/visual-audit.json")


if __name__ == "__main__":
    main()
