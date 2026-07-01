# 04 — Agent-state detection (OSC)

**Prereq:** `03` green. **Shared context:** see `README.md`.

## Goal
The titlebar agent-state chip reflects what the hosted CLI is doing —
idle -> busy -> attention — driven by OSC escape codes on the PTY stream.

## Steps
1. While the agent runs, watch the chip in the titlebar; it should change with activity.
2. Verify by hand (paste into the pane's shell):
   - Attention: `printf '\033]9;hi\007'` -> chip goes **attention**.
   - Command marks (busy/idle): emit `OSC 133` — start `printf '\033]133;C\007'` -> **busy**;
     end `printf '\033]133;D;0\007'` -> **idle**.
   - CWD (no visible chip change, but should not error): `printf '\033]7;file://host/tmp\007'`.
3. Note the known Phase-0 limitations (do not "fix" here):
   - OSC sequences split exactly across a data-chunk boundary are dropped
     (Phase 2 adds a carry buffer).
   - Not every CLI emits OSC; a quiescence heuristic is a Phase-2 fallback.

## Files
- `src/backend/features/agent-state/osc-parser.ts` (OSC 9/99/777/133/7)
- `src/ui/features/agent-state/index.ts` (the chip; listens to the state channel)
- `src/contracts/ipc/terminal.ipc.ts` (`StateEvent`) and `channels.ts` (`state` channel)

## Definition of Done
- The chip transitions idle <-> busy <-> attention on the manual OSC tests above.

## Checks that must be green
- Each manual OSC test flips the chip as specified.
- `npm run typecheck` -> exit 0 *(if any wiring was touched)*
