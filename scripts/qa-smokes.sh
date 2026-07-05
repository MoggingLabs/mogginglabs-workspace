#!/usr/bin/env bash
# Full env-gated smoke sweep with per-run isolated state — ONE script, all platforms:
#   MOGGING_USERDATA   → fresh Electron userData (app-settings.db)
#   LOCALAPPDATA (win) / XDG_RUNTIME_DIR (linux) → fresh detached PTY daemon
#   (both are exported to the same iso dir; each platform reads its own)
# Verdicts come from each smoke's out/<name>-result.json ("pass") — npm/electron exit
# codes are unreliable under timeout (a lingering dev server reads as 124 even after
# the app exited cleanly). Kills each run's daemon afterwards.
# Usage: bash scripts/qa-smokes.sh   (CI wraps with xvfb-run -a; MOGGING_CI_GPU=soft
# relaxes ONLY frame-gap budgets for software-GL runners and prints loudly.)
set -u
cd "$(dirname "$0")/.."

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WIN=1 ;;
  *) IS_WIN=0 ;;
esac

# GNU timeout: present on Linux and Git Bash; stock macOS only has coreutils'
# gtimeout (preinstalled on the CI image). Fail loudly rather than sweep without
# a watchdog.
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN=timeout
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN=gtimeout
else
  echo "qa-smokes: neither timeout nor gtimeout on PATH (macOS: brew install coreutils)" >&2
  exit 1
fi

kill_electron() {
  if [ "$IS_WIN" = 1 ]; then
    taskkill //F //IM electron.exe >/dev/null 2>&1 || true
  else
    pkill -f '[e]lectron' >/dev/null 2>&1 || true
  fi
}

# Short temp root, NOT bare mktemp -d: the daemon binds a unix socket at
# $iso/local/MoggingLabs/run/v3/daemon-<pid>.sock and macOS caps sun_path at
# 104 bytes — macOS's default $TMPDIR (/var/folders/…) blows that limit.
TMPBASE="${TMPBASE:-$(mktemp -d /tmp/mog.XXXXXX)}"
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

# MOGGING_GATES: optional comma list (e.g. "TEMPLATE_A,TEMPLATE_B") to run a
# subset — for ITERATION only; certification is always the full sweep. Two-phase
# pairs share persisted state: include TEMPLATE_A/B (and PROFPERSIST_A/B) both
# or neither.
GATES="${MOGGING_GATES:-}"
should_run() {
  [ -z "$GATES" ] && return 0
  case ",$GATES," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

run_smoke() {
  local name="$1" var="$2" val="$3" timeout_s="$4" result="$5" reuse="${6:-}"
  should_run "$name" || return 0
  local iso="$TMPBASE/${reuse:-$name}"
  mkdir -p "$iso/userdata" "$iso/local"
  rm -f "out/$result-result.json"
  echo "── $name ──"
  MOGGING_USERDATA="$iso/userdata" LOCALAPPDATA="$iso/local" XDG_RUNTIME_DIR="$iso/local" \
    env "$var=$val" "$TIMEOUT_BIN" "$timeout_s" npm run dev >"$iso/$name.log" 2>&1
  local v
  v=$(verdict "$result")
  RESULTS+=("$name $v")
  echo "  $v"
  kill_electron
  # A two-phase pair's phase A must leave its daemon+state for phase B; everything
  # else (including each pair's phase B) cleans up.
  if [ -z "$reuse" ] || [ "$name" = "TEMPLATE_B" ] || [ "$name" = "PROFPERSIST_B" ]; then kill_daemon "$iso"; fi
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
run_smoke PROFILES    MOGGING_PROFILES  1 240 profiles
run_smoke REMOTE      MOGGING_REMOTE    1 240 remote
run_smoke SWARMMILESTONE MOGGING_SWARMMILESTONE 1 300 swarmmilestone
run_smoke TEMPLATE_A  MOGGING_TEMPLATE  A 180 template TEMPLATE
run_smoke TEMPLATE_B  MOGGING_TEMPLATE  B 180 template TEMPLATE
run_smoke PROFPERSIST_A MOGGING_PROFPERSIST A 180 profpersist PROFPERSIST
run_smoke PROFPERSIST_B MOGGING_PROFPERSIST B 180 profpersist PROFPERSIST

echo ""
echo "══ SWEEP RESULTS ══"
printf '%s\n' "${RESULTS[@]}"
