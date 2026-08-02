#!/usr/bin/env bash
# Assert a full-sweep run's verdict — ONE definition (this step is copy-pasted
# verbatim into the linux, macos and windows sweep jobs of ci.yml).
#
# This script does NOT decide which gates failed. qa-smokes.sh derives that once,
# from the RESULTS it already owns, into out/sweep-summary.json; here we only
# assert over it.
#
# It used to re-derive from the log with its own token list — ' (FAIL|MISSING)$' —
# which did not match BOOTFAIL. So a gate that never booted printed
# "ALL GATES PASS", and on linux and macos that was the whole story: those jobs
# also lacked `shell: bash`, so no pipefail, so `| tee` swallowed the sweep's own
# exit 1 as well. Two independent derivations of one verdict is the bug class.
#   usage: bash scripts/check-sweep-log.sh <sweep.log>
set -u
LOG="${1:?usage: check-sweep-log.sh <sweep.log>}"
SUMMARY="out/sweep-summary.json"

# Tripwire: the sweep died before it printed anything at all.
if ! grep -q 'SWEEP RESULTS' "$LOG"; then
  echo '::error::sweep never printed results'; exit 1
fi
# Tripwire: it printed the header but never wrote the summary — it died between
# the two, and an absent summary must never read as "nothing failed".
if [ ! -f "$SUMMARY" ]; then
  echo "::error::sweep printed results but wrote no $SUMMARY — it died between the two"; exit 1
fi

node -e '
  const fs = require("fs")
  const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  if (s.bad !== 0) {
    console.error("::error::" + s.bad + " of " + s.total + " gate(s) did not pass: " + s.failed.join(", "))
    process.exit(1)
  }
  // A subset run is not a certification, and must never print the words that
  // read like one. Nightly + PR sweeps pass no filter, so they land COMPLETE.
  if (s.coverage !== "COMPLETE") {
    console.log("PARTIAL SWEEP OK — " + s.total + " gate(s) ran (" + s.gatesFilter + "). This is NOT a certification.")
    process.exit(0)
  }
  console.log("ALL " + s.total + " GATES PASS")
' "$SUMMARY"
STATUS=$?

sed -n '/SWEEP RESULTS/,$p' "$LOG"
exit $STATUS
