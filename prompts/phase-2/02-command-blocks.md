# 02 — Warp-style command blocks

**Prereq:** `01` green (OSC 133 marks). **Shared context:** `README.md`.

## Goal
Segment each terminal into collapsible **command blocks** (Warp-style): one block per command
with its command line, output, exit-code color, timestamp, and duration — searchable and
collapsible. Makes long agent sessions navigable.

## Concept
Use OSC 133 shell-integration marks (A = prompt start, B = command start, C = pre-exec,
D = exit code) to bracket blocks. Where a CLI doesn't emit 133, fall back to prompt-heuristic
bracketing; blocks degrade gracefully (still a normal scrollable terminal). Blocks are an
OVERLAY/model on top of xterm — never a reimplementation of the terminal renderer.

## Steps
1. **Block model** — `src/ui/features/blocks/`: parse 133 marks from the pane's stream into
   `{ id, command, startedAt, durationMs, exitCode, lineRange }`.
2. **Rendering** — a gutter/overlay per block: exit-code color (green 0 / red non-zero),
   timestamp + duration, a collapse toggle folding the output rows. Keep xterm as the renderer;
   the overlay maps to buffer line ranges + reflows on resize.
3. **Search + nav** — filter/jump blocks by command text or exit code; keyboard nav between blocks.
4. **Perf** — blocks must not regress the N-pane budget: cap tracked blocks (ring buffer), lazy
   overlays for offscreen blocks.

## Files
- `src/ui/features/blocks/**` (model + overlay + search), `src/ui/features/terminal/**`
  (expose buffer marks/ranges), `src/backend/features/agent-state/osc-parser.ts` (133 marks).

## Definition of Done
- Commands segment into blocks with correct exit-code color, timestamp, duration.
- Collapse/expand a block; search/jump by command or exit code.
- Graceful fallback when 133 is absent; no terminal-rendering regression.

## Checks that must be green
- Block smoke: run commands (exit 0 + non-zero), assert block count + exit colors + collapse.
- Perf: blocks on 8+ panes stay within the budget.
- `npm run typecheck` -> 0; `npm run build` -> ok; boundaries clean.

## Guardrails
- Blocks OVERLAY xterm; don't fork the renderer. Degrade gracefully without OSC 133.
- No terminal content leaves the renderer; decoupled feature (slots/ports + `@contracts`).
