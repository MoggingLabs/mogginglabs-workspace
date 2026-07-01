# 01 — OSC hardening + workspace attention rings/badges

**Prereq:** Phase 1 green. **Shared context:** `README.md` +
`src/backend/features/agent-state/osc-parser.ts` (the Phase-0 parser this hardens).

## Goal
Make "which agent needs me" answerable at a glance across a whole workspace of panes. Harden
the OSC parser to full coverage and aggregate per-pane state up to **workspace-tab rings/badges**
— a tab shows attention when ANY of its panes needs you, without opening it.

## Steps
1. **Harden the OSC parser** — cover 9 (progress/notify), 777 (notify), 133 (prompt/command/exit
   marks), 7 (cwd), 99 where emitted. Robust to split writes (the parser already buffers). Map to
   `AgentState` (idle/busy/attention); also surface cwd + 133 marks for steps 02/03.
2. **Per-pane state** (exists — verify) — each pane's chip reflects its OWN OSC state.
3. **Workspace-tab aggregation** — a ui-core "attention" port: each workspace aggregates its
   panes' states (max severity) -> a ring/badge on its tab. Attention on a background tab is
   visible; it clears when you focus/act on that pane.
4. **App-level (optional)** — an Electron taskbar/dock badge when any workspace needs attention.

## Files
- `src/backend/features/agent-state/osc-parser.ts` (full sequence coverage),
  `src/contracts/ipc/terminal.ipc.ts` (extend `StateEvent` with cwd/marks if needed),
  `src/ui/core/**` (attention port), `src/ui/features/workspace/**` (tab rings),
  `src/main/**` (dock/taskbar badge).

## Definition of Done
- OSC 9/99/777/133/7 detected reliably (split-write safe).
- A background workspace tab rings/badges when one of its panes flips to attention/busy; it
  clears on focus/act.
- No terminal content in any state event — primitives only (ADR 0002/0005).

## Checks that must be green
- OSC smoke: feed crafted sequences (incl. split across writes), assert state transitions + cwd/marks.
- Tab-attention smoke: N panes, one flips attention -> its tab rings.
- `npm run typecheck` -> 0; `npm run build` -> ok; boundaries clean.

## Guardrails
- OSC over hooks (works for any CLI). State events carry primitives only, never PTY output.
- Keep `@backend` Electron-free; the dock/taskbar badge lives in `src/main`. Decoupled via ports.
