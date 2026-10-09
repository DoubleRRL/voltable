#!/bin/bash
# Poll MinerU until the full-document parse finishes.
#
# The `mineru parse` CLI returns as soon as its --wait elapses, but the parse
# keeps running server-side ("Re-run the same command to continue waiting"), so
# we re-issue the command until it reports status=written.
set -u

ROOT="/Users/RRL_1/manquery/esr-rag"
MINERU="$ROOT/.venv-mineru/bin/mineru"
PDF="/Users/RRL_1/manquery/Electrical Service Requirements (ESR).pdf"
OUT="$ROOT/data/mineru/esr.json"
LOG=/tmp/mineru-poll.log

: > "$LOG"
for attempt in $(seq 1 400); do
  result="$("$MINERU" parse "$PDF" -p all --tier standard -o "$OUT" --json --wait 45 2>&1)"
  status="$(printf '%s' "$result" | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin)["parse"]["status"])
except Exception:
    print("unknown")' 2>/dev/null)"

  echo "[$(date +%H:%M:%S)] attempt=$attempt status=$status" >> "$LOG"

  if [ "$status" = "done" ] || [ "$status" = "written" ]; then
    echo "PARSE_COMPLETE" >> "$LOG"
    exit 0
  fi
  sleep 5
done

echo "PARSE_GAVE_UP" >> "$LOG"
exit 1