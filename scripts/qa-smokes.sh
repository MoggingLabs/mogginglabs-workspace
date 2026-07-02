#!/usr/bin/env bash
# Full env-gated smoke sweep with per-run isolated state:
#   MOGGING_USERDATA → fresh Electron userData (app-settings.db)
#   LOCALAPPDATA     → fresh detached PTY daemon
# Verdicts come from each smoke's out/<name>-result.json ("pass") — npm/electron exit
# codes are unreliable under timeout (a lingering dev server reads as 124 even after
# the app exited cleanly). Kills each run's daemon afterwards.
# Usage: bash scripts/qa-smokes.sh
set -u
cd "$(dirname "$0")/.."

TMPBASE="${TMPBASE:-$(mktemp -d)}"
echo "isolation root: $TMPBASE"
RESULTS=()

kill_daemon() {
  local iso="$1"
  local ep="$iso/local/MoggingLabs/run/v3/endpoint.json"
  if [ -f "$ep" ]; then
    local pid
    pid=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$ep','utf8')).pid)}catch{}" 2>/dev/null)
    if [ -n "${pid:-}" ]; then kill "$pid" 2>/dev/null && echo "  killed daemon pid $pid"; fi
  fi
}

verdict() {
  local file="out/$1-result.json"
  node -e "try{const r=JSON.parse(require('fs').readFileSync('$file','utf8'));process.stdout.write(r.pass===true?'PASS':'FAIL')}catch{process.stdout.write('MISSING')}" 2>/dev/null
}

run_smoke() {
  local name="$1" var="$2" val="$3" timeout_s="$4" result="$5" reuse="${6:-}"
  local iso="$TMPBASE/${reuse:-$name}"
  mkdir -p "$iso/userdata" "$iso/local"
  rm -f "out/$result-result.json"
  echo "── $name ──"
  MOGGING_USERDATA="$iso/userdata" LOCALAPPDATA="$iso/local" \
    env "$var=$val" timeout "$timeout_s" npm run dev >"$iso/$name.log" 2>&1
  local v
  v=$(verdict "$result")
  RESULTS+=("$name $v")
  echo "  $v"
  taskkill //F //IM electron.exe >/dev/null 2>&1
  # Template phase A must leave its daemon+state for phase B; everything else cleans up.
  if [ -z "$reuse" ] || [ "$name" = "TEMPLATE_B" ]; then kill_daemon "$iso"; fi
  return 0
}

run_smoke SMOKE       MOGGING_SMOKE     1 180 smoke
run_smoke MULTIPANE   MOGGING_MULTIPANE 1 180 multipane
run_smoke ATTENTION   MOGGING_ATTENTION 1 120 attention
run_smoke BLOCKS      MOGGING_BLOCKS    1 150 blocks
run_smoke GIT         MOGGING_GIT       1 240 git
run_smoke NOTIFY      MOGGING_NOTIFY    1 180 notify
run_smoke MILESTONE   MOGGING_MILESTONE 1 300 milestone
run_smoke FLICKER     MOGGING_FLICKER   1 240 flicker
run_smoke PERCEPTION  MOGGING_PERCEPTION 1 240 perception
run_smoke PANEOPS     MOGGING_PANEOPS   1 180 paneops
run_smoke CONTROL     MOGGING_CONTROL   1 240 control
run_smoke CONTROL2    MOGGING_CONTROL2  1 180 control2
run_smoke WORKTREE    MOGGING_WORKTREE  1 240 worktree
run_smoke REVIEW      MOGGING_REVIEW    1 240 review
run_smoke BOARD       MOGGING_BOARD     1 240 board
run_smoke ORCHESTRATION MOGGING_ORCHESTRATION 1 300 orchestration
run_smoke SWARM       MOGGING_SWARM     1 240 swarm
run_smoke LEDGER      MOGGING_LEDGER    1 240 ledger
run_smoke GATE        MOGGING_GATE      1 240 gate
run_smoke TEMPLATE_A  MOGGING_TEMPLATE  A 180 template TEMPLATE
run_smoke TEMPLATE_B  MOGGING_TEMPLATE  B 180 template TEMPLATE

echo ""
echo "══ SWEEP RESULTS ══"
printf '%s\n' "${RESULTS[@]}"
