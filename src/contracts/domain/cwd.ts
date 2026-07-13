/** Where a pane's effective working directory came from. The distinction is behavioral:
 * an explicit agent declaration outranks passive shell/process observations until that agent
 * exits, while a shell prompt releases the declaration back to the shell. */
export type PaneCwdSource = 'spawn' | 'shell' | 'process' | 'agent'

/** Remote cwd values are display/session metadata only. They must never be probed by local Git. */
export type PaneCwdLocality = 'local' | 'remote'

/** Long-path aware, but still bounded before a path can cross IPC or an OSC fallback. */
export const PANE_CWD_MAX = 32_768
