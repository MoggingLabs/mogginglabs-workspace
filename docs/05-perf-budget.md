# 05 · The Phase-2 perf budget — "16 agents, nothing freezes"

Rendering reliability at high pane counts is the product's core wedge (see
`03-research-synthesis.md` §8 — terminal freezes are the incumbent's clearest recurring failure
mode). Phase 2 gates on a **hard, asserted perf budget** at the 16-agent milestone: it is checked
by an automated smoke, not eyeballed, and **a regression fails the gate**.

## The budget (asserted by `MOGGING_MILESTONE`)

Source of truth: `BUDGET` in `src/main/milestone-smoke.ts`.

| Gate | Value | Meaning |
|---|---|---|
| `panes` | 16 | The milestone grid: 16 live PTY panes in one workspace |
| `maxFrameGapMs` | 150 | The renderer main thread is never blocked longer than this (worst rAF gap), during the stress torrent **and** idle |
| `minAvgFps` | 30 | Average fps floor across the 4s stress window (60fps target; the floor is display-rate-independent) |
| `maxHeapMB` | 300 | Renderer JS heap cap with 16 live panes + scrollback |
| `minWebglVisible` | 12 | Of 16 visible panes, at least this many must hold the WebGL renderer |

Thresholds were calibrated from the first measured baseline (below) with ~3–10× headroom, so a
slower machine passes but a real regression — a synchronous stall, a leak, a dead renderer — blows
straight through a gate.

## Measured baseline (2026-07-01, Windows 11, 144Hz display, daemon backend)

The stress: for 4s, every one of the 16 panes receives ~1KB of ANSI-colored, full-width,
scrolling output every 50ms (~1.15MB parsed + rendered total — full-viewport scroll in all 16
panes, the worst rendering case), while 4 panes are flipped to attention end-to-end through the
real PTY→OSC→daemon→badge path.

| Metric | Run 1 | Run 2 (repeat) | Budget |
|---|---|---|---|
| Panes mounted | 16 | 16 | = 16 |
| Stress: avg fps | 135.3 | 137.0 | ≥ 30 |
| Stress: worst frame gap | 48.6 ms | 34.8 ms | ≤ 150 ms |
| Stress: frames > 100ms | 0 | 0 | (reported) |
| Idle: worst frame gap | 7.2 ms | 7.3 ms | ≤ 150 ms |
| Renderer JS heap | 28 MB | 28 MB | ≤ 300 MB |
| Visible panes on WebGL | 16/16 | 16/16 | ≥ 12 |
| Hidden panes released GL | 16/16 | 16/16 | = 16 |
| Attention badges (4 flipped) | 4/4 | 4/4 | = 4 |
| Background tab ring / clear-on-focus | ✓ / ✓ | ✓ / ✓ | both |

## How the budget is met (the rendering strategy)

- **WebGL per pane, managed — not assumed.** Chromium caps live WebGL contexts at ~16 per page —
  exactly our largest grid. `TerminalPane` treats a GL context as a leased resource:
  - **Visibility-driven**: an `IntersectionObserver` on each pane's slot acquires WebGL when the
    pane is visible and **releases it when its workspace is hidden** (`display:none`), falling
    back to xterm's DOM renderer (fine for a pane nobody can see). Switching back re-acquires.
    N workspaces × 16 panes therefore never exceeds the context cap.
  - **Self-healing on context loss**: `WebglAddon.onContextLoss` (cap eviction / GPU reset) →
    dispose → DOM renderer → bounded re-acquire retries while visible. A pane can degrade,
    never die — the exact anti-goal of the incumbent's freeze bugs.
- **Idle repaints are capped**: `cursorBlink` is enabled only for the focused pane (Phase-1/04);
  scrollback is capped at 10k lines/pane.
- **Attention is event-driven, not polled**: OSC state changes fan out through ports; the tab
  ring recomputes only on a state change or workspace switch. The per-pane git probe (2/03)
  polls in the **main process** (single shared 2.5s poll, deduped per cwd, change-only emits) —
  zero renderer cost while quiet.
- **The PTY torrent never blocks the UI**: PTYs live in the detached daemon (ADR 0006); the
  renderer only parses + paints what arrives over IPC.

## Running the milestone

```
MOGGING_MILESTONE=1 npm run dev   # asserts the budget; writes out/milestone-result.json; exit 0 = pass
```

Run it against a **fresh daemon** for determinism (a surviving daemon from a previous app version
holds old panes with the same ids): either kill the daemon listed in
`%LOCALAPPDATA%\MoggingLabs\run\v1\endpoint.json`, or point `LOCALAPPDATA` at a temp dir for the
run (the smokes in CI/dev sessions do the latter; it leaves your real daemon untouched).

Note on methodology: the torrent is injected renderer-side (`term.write`) so the dose is exact and
repeatable; it exercises the same parse+render path as PTY output. The IPC/daemon path itself is
separately proven at scale by the Phase-1 multipane smoke (8 real PTYs streaming concurrently) and
by the 4 real end-to-end OSC attention flips inside this smoke.

## Regression policy

`MOGGING_MILESTONE` is part of the smoke battery (`MOGGING_SMOKE`, `MOGGING_MULTIPANE`,
`MOGGING_ATTENTION`, `MOGGING_BLOCKS`, `MOGGING_GIT`, `MOGGING_NOTIFY`, …). Any change that puts
work on the renderer main thread (new decorations, chips, parsers) must keep this smoke green —
if the budget can't be met, **throttle or virtualize before shipping the feature** (Phase-2
guardrail).
