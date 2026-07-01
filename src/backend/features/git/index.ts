// Read-only per-pane git (Phase-2/03). Given a pane's cwd, resolve its repo's branch + dirty
// state and stream changes. Strictly observe-only (see probe.ts). Electron-free — the app layer
// (src/main/git.ts) wires the monitor's sink to IPC.
export * from './repo'
export * from './probe'
export * from './monitor'
