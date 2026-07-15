// The agent-state feature is a library consumed by both PTY backends (daemon +
// in-proc) rather than an IPC module — not every feature owns channels. The
// OscParser decodes explicit signals; the ActivityTracker turns them into the
// pane state the dot renders under THE VERDICT LAW (activity.ts): every state is
// raised by a signal that KNOWS — output activity raises nothing (the old
// quiescence heuristic guessed, and was deleted for it).
export * from './osc-parser'
export * from './activity'
export * from './replies'
export * from './agent-proc'
export * from './cwd-state'
export * from './git-context'
