// Per-pane agent-context usage (the pane header's context bar). Given a pane's launched
// provider + cwd (+ resolved config home), tail the session log the CLI already writes
// and report used/window token counts. Strictly read-only, strictly counts (ADR 0005) —
// see readers.ts for the dev-verified log shapes and monitor.ts for the session-locking
// rules. Electron-free — the app layer (src/main/context.ts) wires the sink to IPC.
export * from './readers'
export * from './window'
export * from './monitor'
export * from './relay'
