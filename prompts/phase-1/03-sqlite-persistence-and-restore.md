# 03 — SQLite persistence + workspace/scrollback restore

**Prereq:** `02` green. **Shared context:** see `README.md`.

## Goal
Persist workspaces + pane layout + cwd + last-agent and restore them on relaunch; and
snapshot/restore **scrollback** so a reloaded/reconnected pane repaints prior output —
closing the Phase-0 "reloaded pane starts blank" gap.

## Steps
1. **Store** — add `better-sqlite3` (native; install via `electron-builder install-app-deps`
   or a prebuilt). Schema: `workspaces`, `panes` (workspace_id, layout node, cwd,
   agent_command, last_serialized_scrollback, timestamps). **No secrets, ever.**
2. **Workspace feature (backend)** — `src/backend/features/workspace/`: a persistence
   service + `FeatureModule`; save on change (debounced), load on start.
3. **Scrollback** — add `@xterm/addon-serialize`; snapshot each pane's buffer periodically
   + on unload; persist; **restore on reconnect/relaunch** by writing the snapshot back into
   the fresh xterm.
4. **Restore** — rebuild layout + cwd on launch; relaunch agents via their own
   `--resume`/`resume` where supported (never freeze processes).

## Files
- `src/backend/features/workspace/**`, `src/contracts/ipc/workspace.ipc.ts` (+ channels),
  `src/ui/features/terminal/terminal-pane.ts` (serialize/restore),
  `package.json` (`better-sqlite3`, `@xterm/addon-serialize`).

## Definition of Done
- Relaunch restores workspaces + layout + cwd.
- A reloaded/reconnected pane repaints its prior scrollback.
- The DB contains only layout/cwd/labels/snapshots — **no credentials** (verify schema).

## Checks that must be green
- Persistence smoke: write state -> relaunch -> restored (assert layout + a scrollback
  marker) -> green.
- `npm run typecheck` -> 0; `npm run build` -> ok; **secret-audit** of the schema/data.

## Guardrails
- ADR 0002: never store provider credentials (labels/status only). `@backend` Electron-free.
