#!/bin/bash
# Produce a MinerU layout model for each manual.
#
# Concurrency is capped at two. Layout inference is the memory-hungry stage and
# this box is 16 GB with CPU-only inference; running five at once thrashes and
# takes the parse server down with it. Render and OCR, the stages that dominate
# wall clock during ingest, are per-page and fully parallel.
#
#   scripts/render/parse-manuals.sh [manual ...]     # default: all of them
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON="$ROOT/.venv-mineru/bin/python"
MANUALS_DIR="${MANUALS_DIR:-$ROOT/..}"
OUT_DIR="$ROOT/data/mineru"
# effort=high is the engine's own default and the quality the ESR index was
# built at. The tier names the CLI takes (flash/basic/standard/advanced) do not
# map onto it; `layout.py --help` lists what doc_analyze accepts.
EFFORT="${MINERU_EFFORT:-high}"
CONCURRENCY="${LAYOUT_CONCURRENCY:-2}"
LOG=/tmp/mineru-layout.log

declare -a FILES=(
  "esr|Electrical Service Requirements (ESR).pdf"
  "ads|Extracted Pages from Applicant Distribution Design Standards (ADS).pdf"
  "plm|Pole Loading Manual (PLM).pdf"
  "ugs|UGS.pdf"
  "doh|Extracted Pages from Distribution Overhead Construction Standards (DOH).pdf"
)

mkdir -p "$OUT_DIR"
: > "$LOG"

layout_one() {
  local id="$1" file="$2"
  "$PYTHON" "$ROOT/scripts/render/layout.py" \
    "$MANUALS_DIR/$file" "$OUT_DIR/$id.json" --effort "$EFFORT" >> "$LOG" 2>&1
}

active=0
for entry in "${FILES[@]}"; do
  id="${entry%%|*}"
  file="${entry#*|}"
  if [ "$#" -gt 0 ]; then
    keep=0
    for want in "$@"; do
      [ "$want" = "$id" ] && keep=1
    done
    [ "$keep" -eq 1 ] || continue
  fi
  layout_one "$id" "$file" &
  active=$((active + 1))
  if [ "$active" -ge "$CONCURRENCY" ]; then
    wait -n 2>/dev/null || wait
    active=$((active - 1))
  fi
done
wait

echo "[layout] log: $LOG"
ls -la "$OUT_DIR"/*.json 2>/dev/null | awk '{print "  " $5, $9}'
