#!/usr/bin/env bash
# Gate a full-sweep run on its own printed results — ONE definition (this step was
# copy-pasted verbatim into the linux, macos and windows sweep jobs of ci.yml).
#   usage: bash scripts/check-sweep-log.sh sweep.log
set -u
LOG="${1:?usage: check-sweep-log.sh <sweep.log>}"
if ! grep -q 'SWEEP RESULTS' "$LOG"; then
  echo '::error::sweep never printed results'; exit 1
fi
BAD=$(sed -n '/SWEEP RESULTS/,$p' "$LOG" | grep -cE ' (FAIL|MISSING)$' || true)
if [ "$BAD" != "0" ]; then
  echo "::error::$BAD gate(s) failed"; sed -n '/SWEEP RESULTS/,$p' "$LOG"; exit 1
fi
echo 'ALL GATES PASS'; sed -n '/SWEEP RESULTS/,$p' "$LOG"
