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
#
# 183 gates: 23 static (AUDIT · SPACING · PTYSEAM · PROTOVER · CHANNELS · AGENTCAT · LAYOUT ·
# DOCSREFS · CUSTODY · MOTION · NPMCONFIG · PRODARTIFACT · GATECOUNT · LINT · UNIT ·
# GITPURE · REMOTEBOOT · CONNPURE · PREREGCLIENT · ORIGINPIN · FUSES · BYTECODE ·
# GRAMMARCAT) + 160 app-boot
# The registry below is the source of truth for the gate count, and check-gate-count.mjs
# DERIVES it from these rows rather than trusting any prose (finding 40: every doc that
# stated the sweep's size stated a different one). Agent settings adds a catalog gate, a
# windowless control-plane gate, and a composed Settings UI gate.
# Phase 11 (Files — the explorer) added seven, and they run LAST:
#   FSLIST          the read service, zero UI (files+dirs, caps, typed refusals)
#   FILETREE        the virtualized tree (10k rows, APG keyboard, tree ARIA)
#   EXPLORER        the dock (four doors, re-rooting, per-workspace memory)
#   TREELIVE        the liveness law (coalescing, capped pool + poll tier, suspend rules)
#   TREEGIT         the decorations (badges, propagation, ignore dim, the Changes lens)
#   FILEACT         the actions (open/reveal via a SPY, copy, send-to-pane, hostile names)
#   FILESMILESTONE  THE authority on "Phase 11 done" — the whole promise composed, and
#                   both perf budgets measured ON the composed surface (16 panes + the
#                   explorer open + a write torrent)
#
# WHY SEQUENTIAL (investigated 2026-07-06, do not re-litigate blindly): each gate
# boots a FULL app via `electron-vite dev` — a Vite dev server + Electron + a
# detached PTY daemon, ~8 processes per gate. Running gates N-at-a-time was
# measured 3x SLOWER (8 gates: 2m02s serial vs 6m02s at JOBS=4) because 4
# concurrent app boots saturate disk/GPU/CPU and each gate slows ~12x — the
# bottleneck is heavyweight per-gate startup, not CPU-parallelizable work. It
# also flaked timing-sensitive gates (USAGE's poller-pause) under contention.
# The real speedup lever is a build-once + `electron-vite preview` per gate
# (skip the per-gate Vite dev compile) — a larger, separate change; parallelism
# only becomes worthwhile AFTER the per-gate boot is cheap. Verdict: stay serial.
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

# Scoped, never by image name: `taskkill //F //IM electron.exe` (and `pkill -f electron`)
# swept the whole MACHINE — including the user's live dev app and, worse, their REAL detached
# PTY daemons (a daemon was electron.exe run as Node then; it is mogging-node.exe now —
# ADR 0016 — and sweeping THAT image would be the same crime), killing live agent sessions
# every gate. kill-devservers.mjs reaps only THIS repo's dev tree, parent-first, and spares
# daemons; a gate's own isolated daemon is reaped by kill_daemon below via its endpoint.json pid.
kill_electron() {
  node scripts/kill-devservers.mjs --quiet >/dev/null 2>&1 || true
}

# `npm run dev` returns the moment the smoke calls app.exit(), but the
# electron-vite it spawned lingers a few seconds tearing down its watcher — and
# it is node.exe, so kill_electron never caught it. If the next gate starts
# inside that window, the dying watcher clears out/main/index.js while the new
# gate's Electron is loading it: "App threw an error during load / ENOENT". The
# gate never runs and reads as MISSING. Intermittent by nature (an idle machine
# sweeps clean; a busy one drops gates), so reap it explicitly, every time.
# Only THIS repo's electron-vite is killed — see scripts/kill-devservers.mjs.
kill_devserver() {
  node scripts/kill-devservers.mjs --quiet >/dev/null 2>&1 || true
}

# Short temp root, NOT bare mktemp -d: the daemon binds a unix socket at
# $iso/local/MoggingLabs/run/v<N>/daemon-<pid>.sock and macOS caps sun_path at
# 104 bytes — macOS's default $TMPDIR (/var/folders/…) blows that limit.
TMPBASE="${TMPBASE:-$(mktemp -d /tmp/mog.XXXXXX)}"
echo "isolation root: $TMPBASE"
RESULTS=()

kill_daemon() {
  local iso="$1"
  # Version-agnostic: the runtime dir is namespaced by DAEMON_PROTOCOL_VERSION (ADR 0006),
  # so a literal vN here silently stops reaping the moment the protocol is bumped — every
  # gate then leaks its daemon into the next one. Glob instead; there is only ever one.
  local ep
  ep=$(ls "$iso"/local/MoggingLabs/run/v*/endpoint.json 2>/dev/null | head -1)
  if [ -f "$ep" ]; then
    local pid
    # BOTH halves live in node, fed over STDIN. Two Windows traps here: node resolves
    # a git-bash /tmp/... argv path drive-relatively (C:\tmp\..., reads nothing), and
    # git-bash `kill` cannot signal native pids — either one silently leaks the daemon
    # (measured: 49+ idle daemons starved a full sweep to MISSING verdicts).
    pid=$(node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>{try{const p=JSON.parse(s).pid;process.kill(p);console.log(p)}catch{}})" <"$ep" 2>/dev/null)
    if [ -n "${pid:-}" ]; then echo "  killed daemon pid $pid"; fi
  fi
}

verdict() {
  local file="out/$1-result.json"
  node -e "try{const r=JSON.parse(require('fs').readFileSync('$file','utf8'));process.stdout.write(r.pass===true?'PASS':'FAIL')}catch{process.stdout.write('MISSING')}" 2>/dev/null
}

# MOGGING_GATES: optional comma list (e.g. "TEMPLATE_A,TEMPLATE_B") to run a
# subset — for ITERATION only; certification is always the full sweep. Two-phase
# pairs share persisted state: include TEMPLATE_A/B (and PROFPERSIST_A/B,
# SURVIVE_A/B) both or neither.
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
  # FIRSTRUN drives the update UX with a fake version (no network) — 6/06.
  local extra=""
  [ "$name" = "FIRSTRUN" ] && extra="MOGGING_FAKE_UPDATE=9.9.9"
  [ "$name" = "ROLERACE" ] && extra="MOGGING_DAEMON_SPAWN_DELAY_MS=2500"
  [ "$name" = "CWD_INPROC" ] && extra="MOGGING_INPROC=1"
  # The canonical HARNESS machine (64 GiB / 16 cores): the pane budget otherwise
  # clamps dense fixtures to whatever box CI rents (a 7 GiB macOS runner budgets
  # six panes — a 16-pane gate would go red for the hardware, not the product).
  # The budget's policy math is pinned in the unit suite; WIZLAYOUT proves the
  # end-to-end wiring against these pinned inputs.
  MOGGING_USERDATA="$iso/userdata" LOCALAPPDATA="$iso/local" XDG_RUNTIME_DIR="$iso/local" \
    MOGGING_MACHINE_MB=65536 MOGGING_MACHINE_CORES=16 \
    env $extra "$var=$val" "$TIMEOUT_BIN" "$timeout_s" npm run dev >"$iso/$name.log" 2>&1
  local v
  v=$(verdict "$result")
  # A gate that never booted is NOT a gate that failed. Say so, loudly, and once
  # — a silent MISSING sends you hunting a product bug that never existed.
  if [ "$v" = "MISSING" ] && grep -q "App threw an error during load" "$iso/$name.log" 2>/dev/null; then
    v="BOOTFAIL"
  fi
  RESULTS+=("$name $v")
  echo "  $v"
  # On a non-PASS, surface the smoke's own flags into the job log (artifacts
  # don't reliably carry the per-gate result JSON) — the fastest path to a
  # platform root cause without a second dispatch.
  if [ "$v" != "PASS" ]; then
    echo "  ── $result diagnostics ──"
    if [ "$v" = "BOOTFAIL" ]; then
      grep -m3 -A2 "App threw an error during load" "$iso/$name.log" 2>/dev/null | sed 's/^/  /'
    else
      node -e "try{console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('out/$result-result.json','utf8')),null,0))}catch(e){console.log('(no result json)')}" 2>/dev/null | sed 's/^/  /'
    fi
  fi
  # Parent FIRST: electron-vite supervises electron and respawns it on death, so
  # the old `kill_electron`-only teardown left a CPU floor that starved the heavy
  # gates. Reap the tree, then sweep any stray electron from another checkout.
  kill_devserver
  kill_electron
  # A two-phase pair's phase A must leave its daemon+state for phase B; everything
  # else (including each pair's phase B) cleans up.
  if [ -z "$reuse" ] || [ "$name" = "TEMPLATE_B" ] || [ "$name" = "PROFPERSIST_B" ] || [ "$name" = "SURVIVE_B" ]; then kill_daemon "$iso"; fi
  return 0
}

# Static gates (Phase-8.5/09): no Electron boot — pure Node checks over the repo. Run
# FIRST so a drifted ledger or a spacing regression fails the sweep in seconds, before
# minutes of app boots. AUDIT is the coverage gate (no Grades row below A, no unrouted
# finding); SPACING freezes the drift grep at --max 0 (every bucket zero, shared row too).
run_static() {
  local name="$1"; shift
  should_run "$name" || return 0
  echo "── $name ──"
  if "$@" >"$TMPBASE/$name.log" 2>&1; then
    RESULTS+=("$name PASS"); echo "  PASS"
  else
    RESULTS+=("$name FAIL"); echo "  FAIL"
    echo "  ── $name diagnostics ──"
    sed 's/^/  /' "$TMPBASE/$name.log" | tail -25
  fi
}
run_static AUDIT   node scripts/check-audit.mjs
run_static SPACING node scripts/check-spacing.mjs --max 0
run_static PTYSEAM node scripts/check-pty-seam.mjs
run_static PROTOVER node scripts/check-protocol-version.mjs
# The preload allowlist: every channel map spread into AllChannels (a forgotten spread
# refuses a whole feature IPC surface with nothing but "channel not allowed" to show).
run_static CHANNELS node scripts/check-channels.mjs
run_static AGENTCAT node scripts/check-agent-settings-catalog.mjs
run_static LAYOUT  node scripts/check-layout-invariants.mjs
# DOCSREFS: the docs cite each other constantly (the roadmap points at ADRs, ADRs at
# research, phases at the pack that shipped them). Rename a doc and every citation keeps
# reading as true while the link 404s. Free to check, invisible when wrong.
run_static DOCSREFS node scripts/check-docs-refs.mjs
# CUSTODY: "no keys stored" is a sentence that FEELS like the brand and is false — the
# vault holds the integration keys you paste. The CLI login is the thing we never touch.
# Five surfaces had drifted into the broad claim before anyone noticed (finding 27).
run_static CUSTODY node scripts/check-credential-wording.mjs
# MOTION: the becalming rules are themselves CSS, and CSS has a cascade — a twin with enough
# specificity outranks the blanket clamp. Finding 36: five indicators had their pulse "becalmed"
# into an INFINITE fade, so prefers-reduced-motion installed the very thing it exists to decline.
run_static MOTION  node scripts/check-reduced-motion.mjs
# NPMCONFIG: .npmrc carried `build_from_source=true` — a key npm has NEVER supported. It warned on
# every install and hard-fails in npm's next major; electron-builder.yml's buildDependenciesFromSource
# was doing the work all along. Two layers: no unsanctioned key in a root .npmrc, and a real
# `npm install --dry-run` that must print no config warning (so it also catches keys arriving from
# ~/.npmrc or the environment). Lockfile-only, offline-safe, writes nothing, ~1.3s.
run_static NPMCONFIG node scripts/check-npm-config.mjs
# PRODARTIFACT: the harness used to SHIP. src/main/index.ts imported ~100 run*Smoke modules, so a
# third of out/main/index.js — which electron-builder globs into app.asar — was a test rig every
# user downloaded and loaded into the main process, wakeable by an env var (finding 41). Dev and
# build now take different entries (index.dev.ts / index.ts) over one boot.ts. This gate BUILDS the
# production entry itself and greps the bundles: one stray harness import puts it all back. It is
# the twin of check-gates.mjs — that one asserts the DEV entry knows every gate, this one asserts
# the PRODUCTION entry knows none. ~15s (it must build; it leaves out/ holding the prod bundle,
# which the first `npm run dev` below overwrites).
run_static PRODARTIFACT node scripts/check-prod-artifact.mjs
# GATECOUNT: finding 40. Every doc that stated the sweep's size stated a different one — 24, 35
# (x3), 83, 87 — and ci.yml contradicted ITSELF, claiming 87 on line 7 and 35 on three others.
# Each was true the day it was typed. This gate DERIVES the count from the run_smoke/run_static
# rows below and fails any doc that disagrees; it also pins docs/10's release commands to
# package.json's version (they still said v0.4.0 at v0.9.0). Dated changelog lines are scoped out.
run_static GATECOUNT node scripts/check-gate-count.mjs
# LINT: eslint over the whole repo (eslint.config.mjs). Syntax-tier only — no type-aware
# rules — so it stays seconds, and unused eslint-disable directives are themselves errors
# (three files carried disables for a linter the repo didn't have; that can't re-accrete).
run_static LINT npm run lint
# UNIT: the headless tier (vitest, tests/unit). Pure-module goldens — pace math, codec
# editing, secret redaction, shell quoting — answered in seconds; the booted gates below
# still hold the same logic in situ.
run_static UNIT npm run test
run_static GITPURE npm run smoke:git-pure
run_static REMOTEBOOT npm run smoke:remote-bootstrap-pure
# CONNPURE: the connections/OAuth regression suite (ADR 0014) — a hermetic fixture AS +
# MCP server driving the REAL oauth client and the REAL bridge binary. Mutation-proven:
# reintroducing the scope over-ask, the rotation-merge drop, or the whoami unfence each
# turns it red. Everything it asserts failed silently once; this is what stops the reprise.
run_static CONNPURE npm run smoke:connections-pure
# PREREGCLIENT: pre-registered OAuth clients for no-DCR providers (Google/GitHub/Slack).
# Three fixture AS shapes prove: no-DCR fails ACTIONABLY (needsClientId → the paste form),
# a refusing-but-live registration endpoint does NOT, a pasted secret rides the exchange,
# one issuer-keyed client covers the whole Workspace group, and a user record is never
# purged on redirect drift (a dcr record still is — each gets the advice that is true).
run_static PREREGCLIENT npm run smoke:preregistered-client-pure
# ORIGINPIN: ADR 0015 — a shipped build talks to exactly the origins compiled into it.
# An env var (the old registry override, catalog.ts) could repoint where a signed
# install fetched the integrations registry; the same pattern is a licensing bypass the
# day an entitlement endpoint exists. origins.ts is the single frozen source. Proves no
# MOGGING_*_BASE read survives in src/ or bin/, the pinned URLs exist nowhere else, the
# prod-artifact banlist carries all four names, and the wording gate still BITES
# (sabotage-and-revert against a scratch cwd, never the repo).
run_static ORIGINPIN node scripts/check-originpin.mjs
# FUSES: ADR 0015 §hardening — the packaged artifact carries the EXACT declared fuse
# wall (cookie-enc ON, nodeOptions OFF, cliInspect OFF, both asar fuses ON, runAsNode
# ON until step 09), read off the binary with @electron/fuses, then a tampered
# app.asar is proven to refuse to load (sabotage-and-revert; win/mac — Linux sets the
# fuse but does not enforce it). Packages itself (~3 min: build + electron-builder
# --dir), same never-trust-what's-there law as PRODARTIFACT.
run_static FUSES node scripts/check-fuses.mjs
# BYTECODE: ADR 0015 §hardening — the shipped main process is V8 bytecode (friction
# against casual reading, NEVER security — docs/18), the sandboxed preload is NOT
# (preload bytecode forces sandbox:false, a trade we refuse), and the pinned
# entitlement constants do not grep in plain text (protectedStrings; V8 keeps string
# literals readable in bytecode). Builds itself (same law as PRODARTIFACT), validates
# every .jsc through the shipped loader's own accept path, and EXECUTES a
# risky-constructs fixture through the same compiler — per-arch by construction.
run_static BYTECODE node scripts/check-bytecode.mjs
# The grammar catalog (ADR 0018.g): artifacts present + hash-pinned, extensions
# uniquely routed, licences stated, ADR roster prose matching, size under cap.
# OFFLINE by design — downloading/verifying new grammars is the operator-run
# update script's job (scripts/update-grammar-catalog.mjs), never the sweep's.
run_static GRAMMARCAT node scripts/check-grammar-catalog.mjs

run_smoke SMOKE       MOGGING_SMOKE     1 180 smoke
run_smoke MULTIPANE   MOGGING_MULTIPANE 1 180 multipane
run_smoke ATTENTION   MOGGING_ATTENTION 1 120 attention
run_smoke BLOCKS      MOGGING_BLOCKS    1 150 blocks
run_smoke CLIPBOARD   MOGGING_CLIPBOARD 1 150 clipboard
run_smoke CWD         MOGGING_CWD       DAEMON 240 cwd
run_smoke CWD_INPROC  MOGGING_CWD       INPROC 180 cwd-inproc
run_smoke GIT         MOGGING_GIT       1 240 git
run_smoke NOTIFY      MOGGING_NOTIFY    1 180 notify
run_smoke NOTIFYHOOK  MOGGING_NOTIFYHOOK 1 120 notifyhook
# NOTIFYPARITY: the two SHIPPED notify artifacts — bin/mogging.mjs (hand-wired per hooks/README)
# and the generated notify-hook script (session overlay + global wiring) — produce identical wire
# events over the whole corpus (Claude notification types incl. unknown, Codex blobs incl.
# malformed, argv events). They drifted once (the 2026-07-15 unknown-type→notice fix landed in
# the generated script only); this is what keeps two copies of one mapping honest.
run_smoke NOTIFYPARITY MOGGING_NOTIFYPARITY 1 120 notifyparity
run_smoke GLOBALHOOKS MOGGING_GLOBALHOOKS 1 150 globalhooks
run_smoke STATE       MOGGING_STATE     1 150 state-smoke
run_smoke RELOAD      MOGGING_RELOAD    1 150 reload-smoke
run_smoke MIGRATE     MOGGING_MIGRATE   1 120 migrate
run_smoke SURVIVE_A   MOGGING_SURVIVE   A 120 survive SURVIVE
run_smoke SURVIVE_B   MOGGING_SURVIVE   B 120 survive SURVIVE
run_smoke MILESTONE   MOGGING_MILESTONE 1 300 milestone
run_smoke FLICKER     MOGGING_FLICKER   1 240 flicker
run_smoke PANESCROLL  MOGGING_PANESCROLL 1 300 panescroll
run_smoke APPSCROLL   MOGGING_APPSCROLL 1 180 appscroll
run_smoke CONPTY      MOGGING_CONPTY    1 180 conpty
run_smoke PERCEPTION  MOGGING_PERCEPTION 1 240 perception
run_smoke PANEOPS     MOGGING_PANEOPS   1 180 paneops
run_smoke CONTROL     MOGGING_CONTROL   1 240 control
run_smoke CONTROL2    MOGGING_CONTROL2  1 180 control2
# RUNTIMESPLIT (ADR 0016): daemon/house-MCP/`mogging` all hosted by the standalone Node
# helper, shims env-free, runAsNode:false declared. Release blocks on SURVIVE + CONTROL +
# this (release.yml); the FUSES gate proves the same flip on the packaged artifact.
run_smoke RUNTIMESPLIT MOGGING_RUNTIMESPLIT 1 240 runtimesplit
run_smoke WORKTREE    MOGGING_WORKTREE  1 240 worktree
run_smoke REVIEW      MOGGING_REVIEW    1 240 review
run_smoke REVIEWSNAP  MOGGING_REVIEWSNAP 1 180 reviewsnap
run_smoke BOARD       MOGGING_BOARD     1 240 board
run_smoke BOARDV2     MOGGING_BOARDV2   1 240 boardv2
run_smoke BOARDMCP    MOGGING_BOARDMCP  1 300 boardmcp
run_smoke BOARDGH     MOGGING_BOARDGH   1 240 boardgh
run_smoke BOARDQUEUE  MOGGING_BOARDQUEUE 1 300 boardqueue
run_smoke BOARDFAIL   MOGGING_BOARDFAIL 1 120 boardfail
run_smoke BRAINCORE   MOGGING_BRAINCORE 1 120 braincore
run_smoke BRAINPARSE  MOGGING_BRAINPARSE 1 180 brainparse
run_smoke BRAINGRAPH  MOGGING_BRAINGRAPH 1 180 braingraph
run_smoke BRAINFRESH  MOGGING_BRAINFRESH 1 300 brainfresh
run_smoke BRAINMCP    MOGGING_BRAINMCP  1 300 brainmcp
run_smoke BRAINMAP    MOGGING_BRAINMAP  1 300 brainmap
run_smoke BRAINWRITE  MOGGING_BRAINWRITE 1 300 brainwrite
run_smoke BRAINDOCS   MOGGING_BRAINDOCS 1 300 braindocs
run_smoke MEMGRAPH    MOGGING_MEMGRAPH  1 300 memgraph
run_smoke BRAINSEM    MOGGING_BRAINSEM  1 300 brainsem
run_smoke BRAINPROPS  MOGGING_BRAINPROPS 1 300 brainprops
run_smoke BRAINCAP    MOGGING_BRAINCAP  1 300 braincap
run_smoke BRAINRECALL MOGGING_BRAINRECALL 1 300 brainrecall
run_smoke BRAINUX     MOGGING_BRAINUX   1 300 brainux
run_smoke BRAINMILESTONE MOGGING_BRAINMILESTONE 1 480 brainmilestone
run_smoke PERSISTHEALTH MOGGING_PERSISTHEALTH 1 120 persisthealth
run_smoke ROLERACE    MOGGING_ROLERACE 1 120 rolerace
run_smoke AGENTREGISTRY MOGGING_AGENTREGISTRY 1 120 agentregistry
run_smoke PLAINMENU   MOGGING_PLAINMENU 1 150 plainmenu
run_smoke UPDATEFAIL  MOGGING_UPDATEFAIL 1 120 updatefail
run_smoke UPDATEOFFLINE MOGGING_UPDATEOFFLINE 1 150 updateoffline
run_smoke A11YMODAL   MOGGING_A11YMODAL 1 180 a11ymodal
run_smoke BROWSERZERO MOGGING_BROWSERZERO 1 180 browserzero
run_smoke SECRETFORMS MOGGING_SECRETFORMS 1 240 secretforms
run_smoke BOARDRENDER MOGGING_BOARDRENDER 1 240 boardrender
run_smoke KBAPG       MOGGING_KBAPG     1 240 kbapg
run_smoke EQUALIZE    MOGGING_EQUALIZE  1 240 equalize
run_smoke ASYNCSTATE  MOGGING_ASYNCSTATE 1 360 asyncstate
run_smoke ORCHESTRATION MOGGING_ORCHESTRATION 1 300 orchestration
run_smoke SWARM       MOGGING_SWARM     1 240 swarm
run_smoke LEDGER      MOGGING_LEDGER    1 240 ledger
run_smoke GATE        MOGGING_GATE      1 240 gate
run_smoke PROFILES    MOGGING_PROFILES  1 240 profiles
run_smoke LOGINTRUTH  MOGGING_LOGINTRUTH 1 240 logintruth
run_smoke REMOTE      MOGGING_REMOTE    1 240 remote
run_smoke SWARMMILESTONE MOGGING_SWARMMILESTONE 1 300 swarmmilestone
run_smoke TEMPLATE_A  MOGGING_TEMPLATE  A 180 template TEMPLATE
run_smoke TEMPLATE_B  MOGGING_TEMPLATE  B 180 template TEMPLATE
run_smoke PROFPERSIST_A MOGGING_PROFPERSIST A 180 profpersist PROFPERSIST
run_smoke PROFPERSIST_B MOGGING_PROFPERSIST B 180 profpersist PROFPERSIST
run_smoke BROWSER      MOGGING_BROWSER   1 180 browser
run_smoke BROWSERCTL   MOGGING_BROWSERCTL 1 180 browserctl
run_smoke BROWSERUX    MOGGING_BROWSERUX 1 180 browserux
run_smoke BROWSERTABS  MOGGING_BROWSERTABS 1 180 browsertabs
run_smoke BROWSERRACE  MOGGING_BROWSERRACE 1 180 browserrace
# LOCKDOWN: ADR 0015 §hardening — the trusted renderer's CSP ships as meta AND header
# (connect-src 'none'; byte-equal, drift fails), scripted location=/window.open on the
# main renderer are DENIED at the source (fixture counts zero hits), the webview dock
# still browses (its own partition/guards), and browser:openExternal still reaches
# shell.openExternal (captured at the seam — no real browser opens under a gate).
run_smoke LOCKDOWN     MOGGING_LOCKDOWN  1 180 lockdown
run_smoke FIRSTRUN     MOGGING_FIRSTRUN  1 150 firstrun
run_smoke PRODUCT      MOGGING_PRODUCT   1 300 product
run_smoke USAGE        MOGGING_USAGE     1 150 usage
run_smoke USAGEUI      MOGGING_USAGEUI   1 180 usageui
run_smoke USAGEGLANCE  MOGGING_USAGEGLANCE 1 180 usageglance
run_smoke WEBUSAGE     MOGGING_WEBUSAGE  1 150 webusage
run_smoke USAGECLI     MOGGING_USAGECLI  1 180 usagecli
run_smoke USAGESET     MOGGING_USAGESET  1 180 usageset
run_smoke MCP          MOGGING_MCP       1 240 mcp
run_smoke MCPWRITE     MOGGING_MCPWRITE  1 240 mcpwrite
run_smoke AGENTWEB     MOGGING_AGENTWEB  1 240 agentweb
run_smoke AGENTLAUNCH  MOGGING_AGENTLAUNCH 1 240 agentlaunch
# LAUNCHNOW: the instant-launch contract (2026-07), both halves — fresh lineup commands
# ride the SPAWN (SpawnRequest.run; zero renderer writes, proven by the ptyWrites spy,
# bookkeeping intact), the custom row rides the same seam, and the typed FALLBACK still
# delivers exactly once, ordered after first output, when the build misses the claim
# window (setSpawnRunHold seam). Bites: reintroduced delays, lost fallbacks, double
# delivery, and bookkeeping that only one delivery path performs.
run_smoke LAUNCHNOW    MOGGING_LAUNCHNOW 1 240 launchnow
run_smoke PERWS        MOGGING_PERWS     1 240 perws
run_smoke PERWSAGENT   MOGGING_PERWSAGENT 1 240 perwsagent
run_smoke VAULTKEYS    MOGGING_VAULTKEYS 1 240 vaultkeys
run_smoke WSCLOSE      MOGGING_WSCLOSE   1 240 wsclose
# KILLFLASH: pane teardown stays windowless (2026-07-18) — the console-less daemon
# (detached: libuv job-escape, measured survival-load-bearing) must force windowsHide on
# every child it spawns, or node-pty's per-pane kill fork flashes one visible terminal
# window per pane at undo-grace lapse. Bites: AttachConsole proves the daemon console-less,
# an EnumWindows watcher over a real 16-pane close proves zero console-class windows
# ever turn visible (red-proven 11+ CASCADIA sightings on the unfixed daemon).
run_smoke KILLFLASH    MOGGING_KILLFLASH 1 240 killflash
# RAILFOLD: the rail fold/unfold choreography (2026-07-18) — in flight the rail clips to
# its animating edge and keeps the expanded layout at full width, so the pane count is
# revealed/hidden AT its resting position and never overlaps the icon; the collapsed
# end-state re-layout lands only after the fold. Bites: a dropped rail-anim stamp, a
# lost :not(.rail-anim) guard, and any mid-fold layout squeeze.
run_smoke RAILFOLD     MOGGING_RAILFOLD  1 240 railfold
# CHROMEPRESS: presses on native chrome dismiss popovers (2026-07-18) — the drag strip
# eats the pointer before the DOM, so main forwards WM_NC*BUTTONDOWN / will-move as
# shell:chromePress and app-shell replays a body-target pointerdown. Bites: a dropped
# wireChromePress in boot, a removed channel, a lost replay, a lost NC hook, the debounce.
run_smoke CHROMEPRESS  MOGGING_CHROMEPRESS 1 240 chromepress
run_smoke KBSHORTCUTS  MOGGING_KBSHORTCUTS 1 240 kbshortcuts
run_smoke KBGLOBAL     MOGGING_KBGLOBAL  1 240 kbglobal
run_smoke DAEMONCUSTODY MOGGING_DAEMONCUSTODY 1 240 daemoncustody
# The daemon-lifecycle trio (2026-07 pane-freeze diagnosis): STAMPWAR is the retire-war
# guard (a mismatched daemon with a live client is NOT retired), HEARTBEAT the wedge
# detector (silent-but-open sockets get cut; busy daemons never do), DAEMONHEAL the relay's
# crash → reconnect → quiesce → un-quiesce lifecycle on the real startDaemonBackend.
run_smoke STAMPWAR     MOGGING_STAMPWAR  1 240 stampwar
run_smoke HEARTBEAT    MOGGING_HEARTBEAT 1 240 heartbeat
run_smoke DAEMONHEAL   MOGGING_DAEMONHEAL 1 240 daemonheal
run_smoke MOVEPANE     MOGGING_MOVEPANE  1 240 movepane
run_smoke SESSIONPOOL  MOGGING_SESSIONPOOL 1 240 sessionpool
run_smoke VERDICTLIVE  MOGGING_VERDICTLIVE 1 240 verdictlive
run_smoke TOOLPLAN     MOGGING_TOOLPLAN  1 240 toolplan
run_smoke EVBRIDGE     MOGGING_EVBRIDGE  1 240 evbridge
# ACCOUNT: ADR 0015 — the token holder on a FAKE in-process IdP (zero network). Login
# lands authed claims; the refresh token rests as vault ciphertext and NO channel
# returns it; refresh rotates + persists; DPoP binds the tokens to a key pair (a
# foreign-key refresh is rejected); logout + a server-side revoke both drop to anon.
run_smoke ACCOUNT      MOGGING_ACCOUNT   1 180 account
# ENTITLE: phase-accounts/05 — the entitlement engine on a FAKE IdP + FAKE issuer
# (zero network). A signed claim verifies LOCALLY against an Ed25519 key; tampered /
# wrong-key / expired tokens are treated as absent (→ Free); the cache rests as vault
# ciphertext; the offline-grace law holds Pro past exp then degrades to Free without
# bricking; the ONE port gates a capped feature with a visible upgrade reason.
run_smoke ENTITLE      MOGGING_ENTITLE   1 180 entitle
# DEVICEKEY: phase-accounts/06 — the account's DPoP key on the REAL platform key store
# (TPM / CNG / Secure Enclave; smoke-named keys, deleted at teardown). The private key
# is non-exportable (the OS refuses its own export API); a copied vault on different
# hardware cannot refresh (foreign-key proof rejected, no re-license, degrades to
# Free); entitlement issuance is device-attested; the Linux/hardware-less software
# fallback reports custody 'software', never a hardware claim.
run_smoke DEVICEKEY    MOGGING_DEVICEKEY 1 240 devicekey
# WATERMARK: phase-accounts/07 — forensic leak attribution + a runtime tamper self-check
# on a FAKE IdP + FAKE issuer + FIXTURE integrity manifest (zero network). A watermarked
# activation traces back to its EXACT account via scripts/trace-watermark.mjs (primary
# carrier, and the redundant ordering carrier when the primary is stripped); a modified
# bin/ shim flips `tampered` so PAID is withheld while the FREE app still boots and
# `mogging list` still works; the piracy telemetry (build.modified, device_mismatch) is
# BOOLEANS ONLY; and a `revoked` entitlement degrades to Free on refresh.
run_smoke WATERMARK    MOGGING_WATERMARK 1 300 watermark
# PRODMILESTONE: phase-accounts/10 — THE authority on "phase-accounts done". One composed
# run on FAKE services (FAKE IdP + FAKE MoR/issuer + fixture manifest; loopback only, zero
# network, zero vendor CLIs): the anon FREE app opens offline and `mogging list/send/capture`
# work → PKCE login (authed ≠ paid) → an HMAC-signed MoR webhook (forged one refused)
# activates the subscription server-side → a device-bound, watermarked Pro claim lands and a
# previously-capped feature unlocks → network pulled: Pro holds through grace (session
# survives the outage), then degrades to Free — never bricks → the same vault as a DIFFERENT
# device reads Free and cannot re-license → a tampered build withholds Pro while the free
# app runs → logout returns to anon-free with the wedge untouched; both budgets measured ON
# this composed surface (16 panes + the machinery live).
run_smoke PRODMILESTONE MOGGING_PRODMILESTONE 1 420 prodmilestone
run_smoke MCPSTATUS    MOGGING_MCPSTATUS 1 240 mcpstatus
run_smoke MCPLOOP      MOGGING_MCPLOOP   1 120 mcploop
run_smoke INTEG        MOGGING_INTEG     1 240 integ
run_smoke WEBTRAIL     MOGGING_WEBTRAIL  1 240 webtrail
run_smoke MCPMGR       MOGGING_MCPMGR    1 180 mcpmgr
run_smoke MCPCAT       MOGGING_MCPCAT    1 180 mcpcat
run_smoke INTEGUX      MOGGING_INTEGUX   1 240 integux
run_smoke SETINTEG     MOGGING_SETINTEG  1 240 setinteg
run_smoke CONNLIVE     MOGGING_CONNLIVE  1 180 connlive
# The store/inventory split (2026-07-18): the Library overlay is the store, the
# settings page is the inventory — this gate bites the door, the honesty, the
# chip->plan mutation, the in-place key vaulting, and the route badges.
run_smoke LIBRARYUX    MOGGING_LIBRARYUX 1 240 libraryux
run_smoke INTEGMILESTONE MOGGING_INTEGMILESTONE 1 300 integmilestone
run_smoke WIZARDUX     MOGGING_WIZARDUX  1 180 wizardux
run_smoke WIZARDFAIL   MOGGING_WIZARDFAIL 1 180 wizardfail
run_smoke WIZARDISO    MOGGING_WIZARDISO 1 240 wizardiso
# The wizard revamp pair (2026-07-16): the cd line (home default, cd-only, Tab
# completion) and the layout section (honest capacity, lattice drag-commit, >16
# panes opening as painted, minima physically enforced).
run_smoke WIZCD        MOGGING_WIZCD     1 240 wizcd
run_smoke WIZLAYOUT    MOGGING_WIZLAYOUT 1 300 wizlayout
run_smoke MUTATIONRACE MOGGING_MUTATIONRACE 1 180 mutationrace
run_smoke AUTHRUNNER   MOGGING_AUTHRUNNER 1 180 authrunner
run_smoke FOLDERPICK   MOGGING_FOLDERPICK 1 240 folderpick
run_smoke SETSHELL     MOGGING_SETSHELL  1 240 setshell
run_smoke SETAGENTCFG  MOGGING_SETAGENTCFG 1 240 setagentcfg
run_smoke SETUSAGE     MOGGING_SETUSAGE  1 240 setusage
run_smoke HOMEUX       MOGGING_HOMEUX    1 240 homeux
run_smoke RESUME       MOGGING_RESUME    1 240 resume
run_smoke BOARDUX      MOGGING_BOARDUX   1 240 boardux
run_smoke FEEDBACKUX   MOGGING_FEEDBACKUX 1 240 feedbackux
run_smoke CHROMEUX     MOGGING_CHROMEUX  1 300 chromeux
run_smoke DOCKUX       MOGGING_DOCKUX    1 240 dockux
run_smoke RESPONSIVE   MOGGING_RESPONSIVE 1 180 responsive
run_smoke UXMILESTONE  MOGGING_UXMILESTONE 1 360 uxmilestone
run_smoke TYPED        MOGGING_TYPED     1 300 typed
run_smoke TYPEDCOST    MOGGING_TYPEDCOST 1 120 typedcost
run_smoke CTXACCURACY  MOGGING_CTXACCURACY 1 120 ctxaccuracy
run_smoke AGENTCFG     MOGGING_AGENTCFG 1 180 agentsettings
run_smoke FSLIST       MOGGING_FSLIST    1 120 fslist
run_smoke FILETREE     MOGGING_FILETREE  1 300 filetree
run_smoke EXPLORER     MOGGING_EXPLORER  1 240 explorer
run_smoke EXPLORERRACE MOGGING_EXPLORERRACE 1 180 explorerrace
run_smoke TREELIVE     MOGGING_TREELIVE  1 300 treelive
run_smoke TREEGIT      MOGGING_TREEGIT   1 360 treegit
run_smoke FILEACT      MOGGING_FILEACT   1 300 fileact
run_smoke FILESMILESTONE MOGGING_FILESMILESTONE 1 420 filesmilestone

echo ""
echo "══ SWEEP RESULTS ══"
printf '%s\n' "${RESULTS[@]}"
BAD=$(printf '%s\n' "${RESULTS[@]}" | grep -cv ' PASS$' || true)
echo ""
if [ "$BAD" -eq 0 ]; then
  echo "ALL ${#RESULTS[@]} GATES PASS"
else
  echo "$BAD of ${#RESULTS[@]} gates did not pass:"
  printf '%s\n' "${RESULTS[@]}" | grep -v ' PASS$' | sed 's/^/  /'
  exit 1
fi
