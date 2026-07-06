# Phase 6 — Product-ready: every platform, every differentiator

Sequenced task prompts for Phase 6 of **MoggingLabs Workspace**: the swarm works — now
make the PRODUCT undeniable. True three-platform parity (the full gate sweep on Linux
and macOS, not just boot), the built-in browser dock, real distribution (signing
hooks, winget/homebrew manifests, first-run experience), and a v0.4.0 milestone that
proves it end to end. Same format
as `prompts/phase-1..5/` (each step self-contained + pasteable as a `/goal`). Execute
in order; each step file is < 4000 chars.

> Scope per `docs/02-mvp-and-roadmap.md`: the **built-in browser** leftover + the
> cross-cutting day-one commitments (signing, CI on three platforms). **Voice input
> is deliberately OUT of this pack** (not yet decided — its own pack if/when it is).
> New protocol/daemon work is NOT expected here — Phase 6 is surface, parity, and
> polish on the frozen v3 substrate.

## Where Phase 4 left us
- The swarm substrate: mailbox + roles, ownership ledger, reviewer gate, profiles +
  usage-limit failover, remote (SSH) panes — all daemon protocol v3, all smoke-gated.
- Management UI shipped (Settings § Profiles & Hosts), board ✓-chips, wizard pickers.
- 24/24 gates green on Windows (`bash scripts/qa-smokes.sh`); Linux BUILDS AND BOOTS
  in CI (headless SMOKE + AppImage/deb); macOS compiles but has NEVER run the sweep.
- Budgets enforced: machine (150 ms/30 fps/300 MB) + perception (≤100 ms, zero >100 ms
  frames). Releases: v0.3.0 feed (win NSIS; linux artifacts on tags); unsigned.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-linux-full-parity.md` | **DONE** (`42fce26`…`c14a2c9`): 24/24 on ubuntu CI (certification run 28645835737) AND Windows local, one script; smoke-shell.ts (zero bare cmd-isms); MOGGING_CI_GPU=soft (frame-timing only, loud); found+fixed 2 product bugs (POSIX profile-env `export` parity, pane-liveness launch gating); CI: direct-gyp rebuild (image hang bisected), gates filter, per-OS cache, uncancellable sweeps |
| 02 | `02-macos-parity-and-manifests.md` | **DONE** (`277b7d9`…`f86603f`): 24/24 on macos CI (certification run 28658947168, which also re-certified linux 24/24) AND Windows local; signing-dryrun READY (config-complete, secrets-pending) on win+mac; winget + homebrew-cask manifests validate in CI, regenerate with one command, pinned to official v0.3.0 artifacts; release green on all three OSes; FLICKER probe made reflow-honest (content, not line count); @electron/rebuild spawn hang bypassed on ALL 2026-07 images (win+mac+linux); runner deprecations cleared, macos-26 pinned |
| 03 | `03-windows-sweep-ci.md` | **DONE** (`f0e850e`…`d07199c`): 24/24 on windows-latest CI (certification run 28670553984), nightly 05:30 + dispatchable; direct-gyp install (spawn hang confirmed on this image too), shell:bash steps, per-OS cache; linux re-certified same campaign (run 28669886364); one probe fix — WORKTREE compares canonical paths (windows runners hand out 8.3 short TEMP) |
| 04 | `04-profile-persistence.md` | **DONE** (`1738ae1`): profileIds persisted in the manifest (paneCwds pattern, pane_profile_ids column); failover rewrites its slot via a launch-port event; pane ⋯ menu shows the profile NAME; stale ids degrade silently. PROFPERSIST_A/B two-phase smoke — sweep is 26 gates, green locally AND on the 3-OS probe (run 28741462996) |
| 05 | `05-browser-dock.md` | **DONE** (`6426729`): toggleable right dock (globe icon, Ctrl+Shift+U, palette), WebContentsView on its own partition (deny-all perms, sandbox, http(s)-only, window.open denied), dock/driver split ready for 05b, per-workspace last-URL chip (switch never navigates). BROWSER gate — sweep is 27; 27/27 local + BROWSER/MILESTONE/PERCEPTION/PANEOPS/FLICKER green on the 3-OS probe (run 28743502082) |
| 05b | `05b-agent-browser-control.md` | **DONE** (`621eb6f`…`d725451`): agents drive the dock via MCP end to end — `bin/mogging-mcp.mjs` (stdio JSON-RPC MCP server, 14 browser tools) → token-authed main socket (ADR-0006 class, no new TCP, daemon v3 untouched) → driver. Per-workspace consent default OFF (Settings § Browser), AGENT-DRIVING banner + instant Stop, verb+ref-only trail; ADR 0002 intact (no cookie/credential verbs, own empty session partition). BROWSERCTL drives the REAL MCP server as a client (mcpToolsOk/mcpRefusesOff/mcpOk) — sweep is 28; 28/28 local + 3-OS probe green (run 28745327773); docs/13-browser.md. Register today: `claude mcp add mogging-browser`; the automated fan-out is phase-8/06 |
| 06 | `06-first-run-and-updates.md` | **DONE** (`63e5de4`…`f9d9406`): live dismissible "Get set up" checklist on Home (real detect → copyable install hints, first-workspace flip, power-ups from real stores; persists dismissal); wizard Agents-step install hints + re-check; UpdateChannels lifecycle → titlebar dot + one "Restart now / Later" toast (MOGGING_FAKE_UPDATE drives it network-free). FIRSTRUN gate — sweep is 29; 29/29 local + 3-OS probe green (run 28753092185); one probe fix (row ① asserts detection HONESTLY, not "claude present"). README 5-min path + docs/10 update-feed story |
| 07 | `07-product-milestone.md` | **DONE** (`6441b6e`…`38461fe`): PRODUCT smoke asserts installer-fresh → guided setup → Swarm workspace (worktrees/roles/per-slot profile) → browser dock on localhost → ledger/mail/gate substrate → both branches land; Phase B budgets held with EVERYTHING on. Full 30-gate sweep green on Windows local + linux/macos/windows CI (run 28755553116); per-OS numbers below. **v0.4.0 shipped**: win x64 (NSIS), linux x64 (AppImage/deb), mac **arm64** (dmg/zip) + all three update feeds; Intel x64 mac deferred (2026-07 macos image `@electron/rebuild` hang — docs/10). winget + arm64 cask regenerated + CI-validated |

## Overall Definition of Done
- `bash scripts/qa-smokes.sh` is green on Windows, Linux, AND macOS CI — one gate
  list, zero platform forks in features.
- The browser dock exists, budget-clean (both perf gates unchanged) — terminals
  stay visible and interactive while previewing.
- Per-workspace profile choices (two subscriptions in parallel) survive restarts.
- A new user on a fresh machine reaches a working agent workspace in under five
  minutes, guided by the product itself.
- v0.4.0 live with win/mac/linux artifacts on the auto-update feed.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok.
- Boundary re-grep: backend no `@ui`/electron; ui no `@backend`/node-pty/electron/node.
- The step's env-gated smoke green **via `scripts/qa-smokes.sh` isolation**; both perf
  budgets (MILESTONE + PERCEPTION) re-run after any renderer-touching step.
- No URLs or update metadata in telemetry (counts/booleans only).

## Guardrails
- **Platform differences live in `@backend/platform`, smoke helpers, and builder/CI
  config ONLY** — never forked inside features.
- The browser dock brokers NOTHING (ADR 0002): no injected sessions, no stored
  cookies beyond Electron defaults, no auth automation. It is a window, not an agent.
- The daemon protocol stays at v3 — Phase 6 adds no wire surface.

## Parallelization
Lane A (platforms/CI): 01 → 02 → 03 (windows-sweep reuses 02's generalized job
shape). Lane B: 04 (profile persistence, small) → 05 (browser). Lane C: 06
(first-run/updates). All independent after the pack starts; 07 needs A complete
and at least B or C (recommended: all) — it freezes the sweep and cuts v0.4.0.

## Linux CI numbers (6/01 — certification run 28645835737, 2026-07-03)
ubuntu-latest under xvfb + SwiftShader, `MOGGING_CI_GPU=soft` (frame-TIMING budgets
relaxed ×4-6 and printed loudly; correctness, echo latency, and heap strict):

- **Sweep**: 24/24 PASS, full uncut run (~65 min; iteration rounds ~10-15 min via
  the `gates` filter + node_modules cache).
- **MILESTONE** (16-pane stress): 14.5 avg fps / worst gap 166.7 ms / heap 20 MB;
  idle 38.7 fps / 150 ms; 16/16 GL release on background, 12/16 re-acquire (polled).
- **PERCEPTION**: switch→painted max 210.9 ms (soft 400); **echo median 1.4 ms
  against the STRICT 60 ms budget** — the daemon round-trip is desktop-class on
  Linux; every relaxed number is SwiftShader raster physics, not app health.
  Churn 166.7 ms max / 0 over; size-churn 50.1 ms / 0; torrent 133.4 ms / 0.
- **SWARMMILESTONE** (phase B, 11 live panes): 23.4 avg fps / 150 ms worst gap /
  16 MB heap.
- Desktop baselines for comparison (Windows, Phase-5 freeze, strict budgets):
  MILESTONE 108.5 fps / 48.7 ms / 41 MB; PERCEPTION switch 49.6 ms, echo 2.4 ms.

## macOS CI numbers (6/02 — certification run 28658947168, 2026-07-03)
macos-26 arm64 runner, `MOGGING_CI_GPU=soft`. Soft mode here covers a DIFFERENT
physics than Linux: the VM can be desktop-class but its scheduling is bimodal —
across three identical-code runs MILESTONE scored 57 fps/gap 200.8 ms, then
19.8 fps/gap 149.8 ms (opposite budget members failing), and the certification
run below would have passed every STRICT budget. Frame timing is the host's
mood, not app health; echo latency, heap, and correctness stay strict.

- **Sweep**: 24/24 PASS, full uncut run — including TEMPLATE_A/B, PROFILES,
  ORCHESTRATION, REMOTE on zsh `-l` panes.
- **MILESTONE** (16-pane stress): 42.3 avg fps / worst gap 69.3 ms / heap 40 MB;
  idle 57.3 fps / 33.3 ms; 16/16 WebGL visible, 16/16 re-acquire.
- **PERCEPTION**: switch→painted max 32 ms; **echo median 2.4 ms against the
  STRICT 60 ms budget** — identical to the Windows desktop baseline; churn
  35 ms / size-churn 31.8 ms / torrent 34.1 ms, zero >100 ms frames.
- **SWARMMILESTONE** (phase B, 11 live panes): 58 avg fps / 40.7 ms / 20 MB.
- Platform finds along the way: macOS 26 image ships no GNU timeout (job
  installs coreutils); 104-byte `sun_path` cap forces the short `/tmp` sweep
  root; wrapped zsh prompts made FLICKER's line-count probe lie (now asserts
  buffer CONTENT survival — strictly stronger); the @electron/rebuild spawn
  hang is the whole 2026-07 image family, win + mac + linux.

## Windows CI numbers (6/03 — certification run 28670553984, 2026-07-03)
windows-latest (2-core, WARP software GL), `MOGGING_CI_GPU=soft`. The probe
run measured desktop-class capability (45.5 fps stress, echo 1.2 ms — run
28669538483) but, like macOS, run-to-run allocation varies; soft covers the
variance, correctness and echo stay strict.

- **Sweep**: 24/24 PASS, full uncut. One probe fix en route: the runner hands
  out TEMP as an 8.3 short path (`RUNNER~1`) while git prints long-form —
  WORKTREE now compares canonical (realpathed) paths, claim untouched.
- **MILESTONE** (16-pane stress): 25.8 avg fps / worst gap 359.3 ms / heap
  28 MB; idle 43.3 fps; 16/16 WebGL visible, 13/16 re-acquire (polled ≥12).
- **PERCEPTION**: switch→painted max 277 ms (soft 400); **echo median 1.6 ms
  against the STRICT 60 ms budget** — the daemon round-trip is desktop-class
  on every platform we run; churn 203.2 / size-churn 46.9 / torrent 78.1 ms.
- **SWARMMILESTONE** (phase B, 11 live panes): 32.1 avg fps / 250 ms / 17 MB.
- Coverage note: with 6/01–6/03 the SAME 24-gate list now certifies on four
  environments — local Windows, ubuntu CI, macos CI, windows CI — nightly at
  03:30/04:30/05:30 respectively.

## Phase-6 freeze — the 30-gate sweep, three platforms (6/07, run 28755553116, 2026-07-05)
The SAME 30-gate list (24 base + PROFPERSIST_A/B, BROWSER, BROWSERCTL, FIRSTRUN,
PRODUCT) green on Windows local AND linux/macos/windows CI. CI is `MOGGING_CI_GPU
=soft` (software GL / shared-vCPU frame timing relaxed, loud; echo latency, heap,
and correctness STRICT). Desktop (Windows local) runs strict, unrelaxed.

| metric | Windows (desktop, strict) | ubuntu CI (soft) | macos-26 CI (soft) | windows CI (soft) |
|---|---|---|---|---|
| MILESTONE stress fps | 139.5 | 21.3 | 58.8 | 26.8 |
| MILESTONE worst gap | 27.8 ms | 100 ms | 97.3 ms | 312.5 ms |
| MILESTONE heap | 38 MB | 24 MB | 40 MB | 25 MB |
| PERCEPTION switch | 30.6 ms | 265.5 ms | 36.1 ms | 255.4 ms |
| **PERCEPTION echo (STRICT 60 ms)** | **1.5 ms** | **1.3 ms** | **0.9 ms** | **1.3 ms** |
| PRODUCT phase-B (dock+19 panes) | 133.4 fps / 48.7 ms / 30 MB | 41.6 / 116.7 / 30 | 53.5 / 116.9 / 37 | 50.8 / 171.9 / 37 |

- **PRODUCT** (6/07): the installer→swarm proof — phase A asserts checklist →
  Swarm workspace (worktrees, roles, per-slot profile in the manifest) →
  browser dock on localhost → ledger/mailbox/gate substrate → both branches
  land; phase B holds the machine budget with the WHOLE surface on (board,
  dock open, 19 live panes). The browser dock cost zero budget — echo stays
  desktop-class on every platform (0.9–1.5 ms against the 60 ms strict floor).
- Every relaxed number on CI is software-GL raster physics, not app health:
  the strict echo round-trip and heap are flat across all four environments.

## Phase-wide telemetry grep (ADR 0005, recorded at freeze)
`grep -rnE "captureEvent|captureError" src/ui src/main` audited: every payload
carries ids/booleans/counts only — no URLs, card/mail text, file paths, env
values, or hostnames. The browser dock emits `browser.dock {open}` and
`update.*`/`firstrun.*` booleans; usage/agent verbs never ship content.
