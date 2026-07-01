# `ui/features/blocks` — Warp-style command blocks (Phase-2/02)

Segments a terminal into collapsible **command blocks** — command line, output, exit-code color,
timestamp, duration — searchable + navigable. Makes long agent sessions legible.

## Approach (matches VS Code's xterm command decorations)
Command blocks over xterm.js is exactly the problem VS Code's integrated terminal solved, and we
use the same method (verified against their shell-integration docs):
- Register an **OSC 133** handler on the pane's `Terminal` (`parser.registerOscHandler`). xterm
  parses the marks in the data stream at the correct buffer position: `A` prompt start,
  `B` command start, `C` pre-exec, `D` exit code.
- Bracket each block with xterm **markers** (`registerMarker`) — they move with scrollback +
  reflow, so the overlay stays aligned with **no renderer changes**.
- Draw a gutter **decoration** (`registerDecoration`) per block (green/red/running); click toggles
  collapse. Keyboard nav (Alt+Up/Down) jumps between blocks; `find()` filters by command/exit.

Warp gets true block folding/reordering by **owning a GPU renderer** (a BlockList, not a char
grid) — not available to us without forking xterm, which the guardrail forbids. So **collapse is
an overlay** cover over the block's output rows (marker-positioned), not a fork.

- `block-tracker.ts` — `BlockTracker` (model + OSC handler + markers + gutter decoration + collapse
  cover + `find`/`jump`). Ring-buffered (cap 300) for perf; disposes markers/decorations.

Decoupled: the `terminal` feature attaches one `BlockTracker` per pane (composition — blocks never
import `terminal`). No terminal content leaves the renderer (ADR 0002).
