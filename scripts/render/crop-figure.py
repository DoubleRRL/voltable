#!/usr/bin/env python3
"""Crop a figure out of a rendered page PNG using a MinerU normalized bbox.

MinerU reports block bboxes as [x0, y0, x1, y1] normalized to 0..1 with the
origin at the top-left, relative to the page box.

usage: crop-figure.py <page.png> <out.png> <x0> <y0> <x1> <y1> [padding_frac]
"""
import sys
from PIL import Image


def main() -> int:
    if len(sys.argv) < 7:
        print(__doc__, file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    x0, y0, x1, y1 = (float(v) for v in sys.argv[3:7])
    pad_frac = float(sys.argv[7]) if len(sys.argv) > 7 else 0.0

    im = Image.open(src).convert("RGB")
    w, h = im.size

    dx = (x1 - x0) * pad_frac
    dy = (y1 - y0) * pad_frac
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
    crop = im.crop(box)
    crop.save(dst, "PNG")
    print(f"{crop.size[0]}x{crop.size[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())