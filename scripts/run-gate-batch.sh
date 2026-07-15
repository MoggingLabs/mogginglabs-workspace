#!/usr/bin/env bash
# Sequential hand-run of a gate subset with per-gate isolation + teardown.
# Usage: bash scripts/run-gate-batch.sh SESSIONPOOL MOVEPANE ...
# Verdict files land in out/<name>-result.json; summary on stdout.
# Teardown kills every electron/node with this repo in the cmdline after each gate —
# the zombie-tree lesson (memory: a surviving dev tree overwrites verdicts with stale
# bundles). NEVER touches the installed app (different image name).
set -u
cd "$(dirname "$0")/.."
declare -A RESULT_NAME=( [SESSIONPOOL]=sessionpool [MOVEPANE]=movepane [CLIPBOARD]=clipboard [USAGE]=usage-smoke [USAGEUI]=usageui [WEBUSAGE]=webusage [CHROMEUX]=chromeux [VERDICTLIVE]=verdictlive [ATTENTION]=attention [STATE]=state-smoke [DAEMONCUSTODY]=daemoncustody )
summary=()
for GATE in "$@"; do
  rn="${RESULT_NAME[$GATE]:-$(echo "$GATE" | tr 'A-Z' 'a-z')}"
  rf="out/${rn}-result.json"
  rm -f "$rf"
  iso="$LOCALAPPDATA/Temp/claude/batch-$rn"
  rm -rf "$iso"; mkdir -p "$iso/userdata" "$iso/local"
  echo "── $GATE ──"
  env -u ELECTRON_RUN_AS_NODE -u ELECTRON_CLI_ARGS -u ELECTRON_EXEC_PATH -u NODE_ENV_ELECTRON_VITE \
    MOGGING_USERDATA="$iso/userdata" LOCALAPPDATA="$iso/local" XDG_RUNTIME_DIR="$iso/local" \
    "MOGGING_$GATE=1" timeout 240 npm run dev > "$iso/gate.log" 2>&1 &
  lp=$!
  ok=""
  for i in $(seq 1 75); do
    if [ -f "$rf" ]; then sleep 2; ok=1; break; fi
    sleep 3
  done
  if [ -n "$ok" ]; then
    v=$(node -e "try{console.log(require('./$rf').pass===true?'PASS':'FAIL')}catch{console.log('UNREADABLE')}")
  else
    v="NO-RESULT"
  fi
  echo "$GATE: $v"
  summary+=("$GATE=$v")
  kill "$lp" 2>/dev/null
  powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'electron.exe' -or \$_.Name -eq 'node.exe') -and \$_.CommandLine -like '*MoggingLabs-Workspace*' -and \$_.CommandLine -notlike '*run-gate-batch*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" > /dev/null 2>&1
  sleep 2
done
echo "════ SUMMARY ════"
printf '%s\n' "${summary[@]}"
