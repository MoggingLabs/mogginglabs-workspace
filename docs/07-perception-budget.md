# Perception budget — anchored in what humans notice

`docs/05-perf-budget.md` protects the machine (headroom under 16-agent load). THIS
budget protects the **experience**: every number below is anchored in established
human-perception research, and the app must sit comfortably under it so it *feels*
fast, smooth, and artifact-free — not merely benchmarks well.

## The anchors (why these numbers)

| Perception fact | Source/consensus | Threshold |
|---|---|---|
| An action feels **instantaneous** below ~100 ms; above it, people notice a hesitation | Card '91 / Nielsen '93 / Google RAIL "response" | **100 ms** |
| At 60 Hz, one frame = 16.7 ms; a **hitch** becomes visible at roughly two dropped frames | RAIL "animation", frame-timing practice | **~33 ms** sustained, **100 ms** = visible stutter |
| **Keystroke → glyph echo** in terminals is felt above ~50–60 ms end-to-end | terminal-latency studies (Luu et al.) | **60 ms** |
| A **wrong state on screen** (stale grid, mis-sized canvas, flash) reads as flicker when visible ≥ ~2–3 frames | flicker-fusion practice | **~50 ms** |
| **Flow breaks** beyond ~1 s (user starts context-switching) | Card/Nielsen | **1000 ms** |

## The budget (notice-threshold → our target, ~2× headroom)

| Interaction | Human notices at | **Budget (hard)** | **Target** |
|---|---|---|---|
| Workspace switch → correct grid painted | 100 ms | ≤ 100 ms | ≤ 50 ms |
| Home ⇄ grid view change | 100 ms | ≤ 100 ms | ≤ 50 ms |
| Pane zoom / expand / restore | 100 ms | ≤ 100 ms | ≤ 50 ms |
| Keystroke → terminal echo (local shell, daemon round-trip) | 60 ms | ≤ 60 ms | ≤ 40 ms |
| Frame gaps while the user interacts (switch/zoom churn) | 100 ms = visible hitch | **0 frames > 100 ms** | worst ≤ 50 ms |
| Frame gaps under 16-agent output torrent | 100 ms | 0 frames > 100 ms | worst ≤ 50 ms |
| Wrong-state visibility (stale size, mis-render) | ~50 ms | none beyond 1 frame after reveal | 0 |
| Cold start → interactive UI (packaged) | 1000 ms | ≤ 1000 ms | ≤ 500 ms |

Notes:
- The **machine budget** (05: worst gap ≤ 150 ms, ≥ 30 fps, ≤ 300 MB) remains the
  portable hard floor for weak hardware; the perception budget is the bar the product
  is *tuned* to on a developer-class machine.
- Terminal *content* latency beyond the local echo (an agent thinking) is not chrome
  latency and is out of scope; the chrome around it must never add perceptible delay.

## How it is held (mechanisms)

- **GL contexts stay warm through interaction**: attach/detach ride a one-job-per-frame
  queue; hidden panes release only after a **1.5 s** quiet period, so rapid workspace
  flips are pure show/hide (zero shader/atlas cost mid-interaction). Chromium's
  ~16-context cap is respected by the release path + context-loss self-heal.
- **Event-driven everything** (attention, git, blocks) — no polling on any hot path.
- **Fits are self-converging and cheap** (ResizeObserver-driven; no layout thrash
  cascades), and font metrics are re-measured exactly once, at face activation.
- **Command/palette republish is skipped** when the workspace set is unchanged
  (switching workspaces no longer rebuilds command lists).

## Enforcement (asserted, not eyeballed)

- **`MOGGING_PERCEPTION`** — measures the interactive latencies end to end (workspace
  switch, Home⇄grid, zoom, keystroke→echo) with double-rAF paint timing + samples
  frames during a 12-flip churn and a 2 s torrent: **fails on any budget line above**.
- **`MOGGING_FLICKER`** — churn/zoom integrity; its frame gate is the perception
  number (**100 ms**), not the machine number.
- **`MOGGING_MILESTONE`** — the machine floor (unchanged), plus content integrity.
- All run isolated via `scripts/qa-smokes.sh`.

Measured on the reference machine (2026-07-02, Win11 144 Hz): see
`out/perception-result.json` after a run — recorded values are kept well inside Target.
