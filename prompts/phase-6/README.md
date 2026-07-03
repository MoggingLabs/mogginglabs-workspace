# Phase 6 — Product-ready: every platform, every differentiator

Sequenced task prompts for Phase 6 of **MoggingLabs Workspace**: the swarm works — now
make the PRODUCT undeniable. True three-platform parity (the full gate sweep on Linux
and macOS, not just boot), the built-in browser pane, real distribution (signing
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
| 02 | `02-macos-parity-and-manifests.md` | Sweep green on macos CI; winget + homebrew-cask manifests; signing hooks verified end-to-end (dry run) |
| 03 | `03-windows-sweep-ci.md` | The ENTIRE 24-gate sweep green on windows-latest CI (nightly + dispatchable) — regression coverage off the dev machine; same script, same gates, soft-GPU honesty |
| 04 | `04-profile-persistence.md` | Per-slot profile choices survive restarts (persisted manifest + failover follow-through); two subscriptions in parallel stay TRUE across relaunch (smoke green) |
| 05 | `05-browser-pane.md` | A browser is a first-class pane type (WebContentsView): URL bar, per-workspace, preview-what-the-agent-built (smoke green) |
| 06 | `06-first-run-and-updates.md` | First-run checklist on Home (CLIs detected → profile → first workspace); auto-update toast → one-click restart (smoke green) |
| 07 | `07-product-milestone.md` | Scripted fresh-machine install→swarm demo asserted; v0.4.0 released on all three platforms; full sweep recorded per-OS |

## Overall Definition of Done
- `bash scripts/qa-smokes.sh` is green on Windows, Linux, AND macOS CI — one gate
  list, zero platform forks in features.
- A browser pane exists, budget-clean (both perf gates unchanged).
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
- The browser pane brokers NOTHING (ADR 0002): no injected sessions, no stored
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
