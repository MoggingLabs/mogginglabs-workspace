# 05 — Kanban board → agent-in-pane

**Prereq:** `01`+`03` green (04 recommended). **Shared context:**
`prompts/phase-3/README.md` + `src/ui/core/shell/view-port.ts` + the wizard/launcher.

## Goal
Make "what should the fleet do next" a first-class surface: a local Kanban board whose
cards LAUNCH agents — a card becomes an isolated worktree pane with the task as context,
and the card follows the pane's live state (working / needs you / done).

## Steps
1. **Model + persistence**: `BoardCard { id, title, notes, lane: 'todo'|'doing'|'review'|
   'done', paneId?, workspaceId?, createdAt, updatedAt }`. Persist via the app-settings
   store (new `app_board` table, main-owned, same better-sqlite3 mechanism).
   `BoardChannels = { list, save, remove }` in `@contracts`. Card text is USER CONTENT:
   it never leaves the local db (no telemetry, no notify payloads).
2. **View**: extend the view port union `'home'|'grid'|'board'`; rail footer gains
   **Board** (icon layout-grid) + `Ctrl+Shift+K`? — no: reuse palette (`board:open`) +
   rail button; keyboard `Ctrl+Shift+G`. `src/ui/features/board/`: four lanes, JetBrains
   Mono type system, drag between lanes (reuse the rail's drag pattern), card editor
   (title + notes), empty states.
3. **Start agent on a card**: card menu → "Start <agent> here…" (installed roster via
   the command port, like the pane menu): opens the wizard PRE-FILLED (repo cwd, 1 pane,
   that agent, worktree isolation ON when repo) OR launches into the current workspace's
   focused pane. On launch: write the task as the agent's FIRST PROMPT — send
   `title + "\n\n" + notes` via the existing `terminal:write` path AFTER the launch
   command (single write; the CLI receives it as its prompt). Bind `card.paneId`.
4. **Live card state** (event-driven, no polling): subscribe the attention port + the
   workspace info port: bound pane `busy` → lane stays `doing` with a working glyph;
   `attention` → card shows the orange count treatment + a "needs you" chip (click →
   switch workspace + focus pane); pane closed → card unbinds. Lane moves stay manual
   (the human decides `review`/`done` — 04's review is one click away when a worktree
   is bound).
5. **Smoke** (`MOGGING_BOARD`): isolated boot → create cards via a dev handle → assert
   persistence across a reload (`board.list` round-trip), start-on-card binds a pane and
   the first prompt reaches the PTY (pane text contains the task marker), flipping the
   pane to attention (dev handle) flags the card, closing the pane unbinds it.

## Files
- `src/contracts/ipc/board.ipc.ts` + channels · `src/backend/features/workspace/
  settings-store.ts` (board table) · `src/main/board.ts` + `src/main/index.ts`
- `src/ui/core/shell/view-port.ts` (union) · `src/ui/features/board/` · rail button
- `src/main/board-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- Cards persist locally; a card starts a (worktree-isolated) agent with its task as the
  first prompt; the card visibly follows the pane's attention; find-the-card-that-needs-
  you obeys the same <1s glanceability bar as the rail.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_BOARD` green isolated; `MOGGING_ATTENTION` + `MOGGING_MILESTONE` still green.

## Guardrails
- Card text = user content: local db only — NEVER telemetry/notify/logs (ADR 0005).
- Attention flows through the existing ports — no new polling anywhere.
- The board is a VIEW: it launches through the wizard/launch ports, never spawns PTYs.
