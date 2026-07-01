# src/pty-host (Phase 1)

The future home of the **persistent PTY-host** — a dedicated Electron
`utilityProcess` that runs `@backend` so PTYs survive a main-process reload and the
UI reconnects (see docs/adr/0003).

Because `@backend` is already Electron-free and speaks only through a
`BackendContext`, moving it here is a wiring change, not a rewrite:

1. Add an entry (`index.ts`) that boots `startBackend(ctx)` with a `MessagePort`-based
   `BackendContext` instead of the ipcMain one.
2. In `src/main`, fork this via `utilityProcess.fork` and relay `MessagePort`s
   between it and the renderer.
3. Keep `src/main/electron-context.ts` as the fallback in-main context for dev.
