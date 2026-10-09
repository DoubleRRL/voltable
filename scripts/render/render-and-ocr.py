#!/usr/bin/env python3
"""Render one ESR page, crop its figures, and OCR each crop.

Emits a single JSON line on stdout. Run once per page; the Node ingest
orchestrates the loop.

Pipeline per page:
  1. render the page to PNG via macOS PDFKit (osascript), because pdfjs-dist
     silently draws nothing under Node
  2. crop each requested bbox out of that PNG
  3. OCR each crop with RapidOCR so text that exists only as pixels inside a
     diagram becomes searchable

usage:
  render-and-ocr.py <pdf> <page_1indexed> <outdir> <label>
      <x0> <y0> <x1> <y1> [<x0> <y0> <x1> <y1> ...]

The bbox arguments are normalized MinerU coordinates (0..1, origin top-left).
At least one bbox must be given.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RENDER = HERE / "render-page.js"

# RapidOCR's detector crashes above roughly this dimension; downscale before OCR.
OCR_MAX_DIM = 1600

_ocr = None


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def render_page(pdf: str, page: int, out_png: Path, scale: float = 2.0) -> dict:
    """Render via PDFKit. Raises on any failure: a blank page that resolves is
    the exact failure mode that hid this bug for so long."""
    proc = subprocess.run(
        ["osascript", "-l", "JavaScript", str(RENDER), pdf, str(page), str(out_png), str(scale)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"render failed for page {page}: {proc.stderr.strip() or proc.stdout.strip()}"
        )
    if not out_png.exists() or out_png.stat().st_size < 4096:
        raise RuntimeError(f"render produced no usable PNG for page {page}")
    return {"ok": True, "detail": proc.stdout.strip()}


def nonwhite_fraction(png: Path) -> float:
    """Fraction of non-white pixels, sampled. A page of pure white means the
    renderer drew nothing even though it reported success."""
    from PIL import Image

    im = Image.open(png).convert("RGB")
    w, h = im.size
    px = im.load()
    hits = 0
    total = 0
    for y in range(0, h, 8):
        for x in range(0, w, 8):
            total += 1
            if px[x, y] != (255, 255, 255):
                hits += 1
    return hits / max(1, total)


def crop(png: Path, out_png: Path, bbox, pad_frac: float = 0.01):
    from PIL import Image

    x0, y0, x1, y1 = bbox
    im = Image.open(png).convert("RGB")
    w, h = im.size
    dx, dy = (x1 - x0) * pad_frac, (y1 - y0) * pad_frac
    x0 = max(0.0, x0 - dx)
    y0 = max(0.0, y0 - dy)
    x1 = min(1.0, x1 + dx)
    y1 = min(1.0, y1 + dy)
    box = (
        int(x0 * w),
        int(y0 * h),
        max(int(x1 * w), int(x0 * w) + 1),
        max(int(y1 * h), int(y0 * h) + 1),
    )
    crop_img = im.crop(box)
    crop_img.save(out_png, "PNG")
    return crop_img.size


def get_ocr():
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR

        _ocr = RapidOCR()
    return _ocr


def ocr_text(png: Path) -> str:
    """OCR a figure crop, downscaling first if needed.

    RapidOCR's detector segfaults on very large inputs (observed on a
    1985x2853 crop on page 272), so oversized crops are scaled down before
    detection. Figure labels are large, so quality loss here is minimal.
    """
    src = str(png)
    try:
        from PIL import Image

        with Image.open(png) as im:
            w, h = im.size
        if max(w, h) > OCR_MAX_DIM:
            scale = OCR_MAX_DIM / float(max(w, h))
            with Image.open(png) as im:
                small = im.convert("RGB").resize(
                    (max(1, int(w * scale)), max(1, int(h * scale))),
                    Image.LANCZOS,
                )
                tmp = png.with_name(png.stem + "-ocr.png")
                small.save(tmp, "PNG")
                src = str(tmp)
    except Exception:
        src = str(png)

    try:
        result, _ = get_ocr()(src)
    except Exception as exc:  # OCR failure must not kill an ingest
        return f"__OCR_FAILED__: {exc}"
    if not result:
        return ""
    lines = [str(r[1]).strip() for r in result if len(r) > 1 and str(r[1]).strip()]
    return "\n".join(lines)


def main() -> int:
    if len(sys.argv) < 9:
        emit({"ok": False, "error": "usage: render-and-ocr.py <pdf> <page> <outdir> <label> <bbox...>"})
        return 2

    pdf = sys.argv[1]
    page = int(sys.argv[2])
    outdir = Path(sys.argv[3])
    label = sys.argv[4]
    flat = [float(v) for v in sys.argv[5:]]
    bboxes = [tuple(flat[i : i + 4]) for i in range(0, len(flat) - 3, 4)]
    if not bboxes:
        emit({"ok": False, "error": "no bboxes supplied"})
        return 2

    try:
        outdir.mkdir(parents=True, exist_ok=True)
        page_png = outdir / f"page-{page}.png"
        render_page(pdf, page, page_png)
        ink = nonwhite_fraction(page_png)
        if ink < 0.002:
            raise RuntimeError(
                f"page {page} rendered essentially blank ({ink:.4%} non-white); "
                "refusing to index an empty page"
            )

        figures = []
        for i, bbox in enumerate(bboxes):
            crop_png = outdir / f"fig-{label}-{i}.png"
            try:
                cw, ch = crop(page_png, crop_png, bbox)
            except Exception as exc:
                figures.append({"index": i, "bbox": list(bbox), "error": f"crop: {exc}"})
                continue
            figures.append(
                {
                    "index": i,
                    "bbox": [round(v, 5) for v in bbox],
                    "file": crop_png.name,
                    "width": cw,
                    "height": ch,
                    "ocr": ocr_text(crop_png),
                }
            )

        emit(
            {
                "ok": True,
                "page": page,
                "pagePng": page_png.name,
                "inkFraction": round(ink, 5),
                "figures": figures,
            }
        )
        return 0
    except Exception as exc:
        emit({"ok": False, "page": page, "error": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())