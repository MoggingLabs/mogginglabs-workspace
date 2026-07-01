# `@backend/features/workspace` — session & workspace persistence

SQLite-backed persistence (Phase-1/03). Electron-free, so it runs inside the detached daemon
(ADR 0006, which owns the sessions) and could equally back the in-proc path.

- `session-store.ts` — `SessionStore(dbPath)`: `loadPanes()` / `savePanes()` / `close()` over
  `better-sqlite3` (WAL). Tables: `panes` (id, cwd, command, scrollback, updated_at) and
  `workspaces` (id, name, layout, updated_at — populated by steps 04/05).
- Shape contract lives in `@contracts` (`workspace.ipc.ts`: `PersistedPane`, `PersistedWorkspace`).

**Where it's used:** the daemon's `SessionManager` owns a `SessionStore` — it persists panes
(debounced + on shutdown) and `restore()`s them on a cold start (fresh shell at cwd + seeded
scrollback repaint). Workspace/layout metadata + IPC channels arrive with steps 04/05.

**Security (ADR 0002):** stores ONLY layout / cwd / command-label / scrollback — the user's own
local terminal state. NEVER provider credentials (the app doesn't handle those; agent CLIs
self-authenticate). `command` is a launch label like `claude`, not a token.

`better-sqlite3` is native; the postinstall (`electron-builder install-app-deps`) rebuilds it for
Electron's ABI via a prebuild (no toolchain needed), and it's `asarUnpack`ed for packaging.
