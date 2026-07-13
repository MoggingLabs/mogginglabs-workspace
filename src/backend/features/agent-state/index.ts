// The agent-state feature is a library consumed by both PTY backends (daemon +
// in-proc) rather than an IPC module — not every feature owns channels. The
// OscParser decodes explicit signals; the ActivityTracker (the long-promised
// quiescence heuristic) fuses them with output activity + the terminal bell into
// the pane state the dot renders.
export * from './osc-parser'
export * from './activity'
export * from './replies'
export * from './agent-proc'
export * from './cwd-state'
export * from './git-context'
