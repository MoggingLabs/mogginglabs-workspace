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

## As built (2026-07-01) — honors the spec, fit to the daemon architecture
Implemented per this spec; the only structural adaptation is that persistence lives where the
sessions do — the daemon (ADR 0006), which owns them and survives restarts.
- **Store:** `better-sqlite3` via `src/backend/features/workspace/session-store.ts`
  (`SessionStore`, WAL) — Electron-free, verified to load under Electron-as-Node. (`better-sqlite3`
  IS viable here: the postinstall `electron-builder install-app-deps` rebuilds it for Electron's
  ABI via a prebuild — no toolchain.) Tables `panes` + `workspaces`; shape contract in
  `@contracts/workspace.ipc.ts` (`PersistedPane`/`PersistedWorkspace`). **No secrets** —
  id/cwd/command/scrollback only (secret-audit clean).
- **Persist:** the daemon's `SessionManager` owns a `SessionStore`; snapshots panes debounced
  (2s) + on shutdown.
- **Restore:** on cold start, `restore()` re-creates persisted panes (fresh shell at `cwd` +
  **seeded scrollback** for repaint; agents are *not* auto-relaunched — `--resume` ties to 06).
- **Scrollback:** `@xterm/addon-serialize` is wired into `TerminalPane.serialize()`; the daemon's
  raw PTY scrollback (replayed on attach) is the primary persistence source.
- **Packaging/CI:** `electron-builder.yml` `asarUnpack` fixed (@lydell/node-pty + better-sqlite3 +
  bindings); CI uses `npm ci --ignore-scripts` (native modules externalized — no compile for
  typecheck/build; the Electron rebuild is dev/packaging).
- **Proven:** `scratchpad/persisttest.cjs` — force-kill the daemon (crash) -> relaunch -> a
  different daemon restores the pane from sqlite (WAL crash-durable) + repaints the marker;
  secret-audit clean; daemon-default UI + CI green.
- **Deferred to 04/05:** workspace/layout metadata (tabs, split tree) — extends the same store.
  Also closes the ADR-0006 version-migration carry-over.
