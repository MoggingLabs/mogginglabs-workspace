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

## As built (2026-07-01) — adapted to the daemon architecture
The daemon (ADR 0006) now owns the sessions + scrollback and survives restarts, so persistence
was implemented **in the daemon**, and two deps were avoided:
- **Store:** `src/pty-daemon/store.ts` — a small **atomic JSON** store (tmp + rename) in the
  per-user runtime dir. *Not* `better-sqlite3` (native; needs a C++ toolchain we don't have) —
  behind a simple interface, swappable for SQLite once CI/packaging provides toolchains. Fields:
  `id, cwd, command, scrollback, updatedAt` (**no secrets** — verified).
- **Persist:** `SessionManager` snapshots panes debounced (2s on output churn) + on shutdown.
- **Restore:** on cold start, `restore()` re-creates persisted panes (fresh shell at `cwd` +
  **seeded scrollback** for repaint; agents are *not* auto-relaunched — `--resume` ties to 06).
- **Scrollback:** uses the daemon's raw PTY scrollback (replayed on attach), so no
  `@xterm/addon-serialize` round-trip is needed.
- **Proven:** `scratchpad/persisttest.cjs` — force-kill the daemon (crash) -> relaunch -> a
  different daemon restores the pane and repaints the marker; secret-audit clean.
- **Deferred to 04/05:** workspace/layout metadata (tabs, split tree) persistence — extends the
  same store once those features exist. Also closes the ADR-0006 version-migration carry-over.
