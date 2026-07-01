# 02 — Persistent PTY-host process

**Prereq:** `01` green. **Shared context:** `README.md` + `docs/adr/0003-persistent-pty-host-process.md`.

## Goal
Move `@backend` into a dedicated, persistent **`utilityProcess`** so agents survive not
just a renderer reload (already true) but a **main-process reload/crash** too — the UI
reconnects. This is the full realization of ADR 0003.

## Steps
1. **`src/pty-host/index.ts`** — a utilityProcess entry that boots `startBackend(ctx)` with
   a **MessagePort-based** `BackendContext` (instead of the ipcMain one). `@backend` code is
   unchanged — it only knows `BackendContext`.
2. **`src/main`** — `utilityProcess.fork('pty-host')`; relay `MessagePort`s between the
   renderer and the host; keep `createElectronContext` (in-main) as a dev/fallback path.
3. **Reconnect** — on renderer reload, re-attach to the host's existing panes and resume
   streaming; on **main** reload, the host keeps running and the UI reconnects to it.
4. **Lifecycle** — host restart policy, graceful shutdown, and process-tree kill on pane
   close (Windows job objects / `taskkill /T`; Unix process-group kill).

## Files
- `src/pty-host/index.ts` (+ the README there), `src/main/index.ts`,
  `src/main/electron-context.ts` (MessagePort context), `src/backend/core/ipc/registry.ts`
  (interface unchanged — the point), `electron.vite.config.ts` (build the pty-host entry).

## Definition of Done
- Agents run inside the pty-host; a **main** reload does not kill them; the UI reconnects.
- No duplicate panes/PTYs on reconnect (id-guard still holds across the boundary).

## Checks that must be green
- Extend the reload smoke (`MOGGING_RELOAD`) to also reload/replace main and assert
  survival + single PTY -> green.
- `npm run typecheck` -> 0; `npm run build` -> ok (three bundles + pty-host); boundaries clean.

## Guardrails
- `@backend` stays Electron-free — only the port implementation changes.
- Never broker auth. Keep the PTY strictly out of the renderer.
