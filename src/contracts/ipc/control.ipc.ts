// Layout control verbs (Phase-3/02). Pane I/O rides the daemon socket (Phase-3/01);
// LAYOUT is renderer state, so these verbs ride the mogging:// deep-link relay through
// MAIN, which validates against this closed union before anything reaches the UI — the
// renderer never parses raw CLI input.

export const CONTROL_VERBS = ['open', 'layout', 'focus', 'expand', 'close-pane'] as const
export type ControlVerb = (typeof CONTROL_VERBS)[number]

export const CONTROL_EXPAND_MODES = ['full', 'col', 'row'] as const
export type ControlExpandMode = (typeof CONTROL_EXPAND_MODES)[number]

/**
 * How long a COLD-START control command waits after the renderer's first paint before
 * it is sent, so `open`/`focus`/`expand` land AFTER the restored workspaces re-attach
 * rather than racing them. One constant because two call sites wait for the same reason
 * (src/main/boot.ts for a cold-start argv command, src/main/deep-link.ts for a command
 * that had to create the window) — a beat-by-timer is admittedly ordering-by-delay, but
 * the restore has no completion signal to ack against today, and the two copies of the
 * number had already been maintained by cross-reference comment alone.
 */
export const CONTROL_COLD_START_DELAY_MS = 800

/** A validated layout command (main -> renderer over ControlChannels.command). */
export interface ControlCommand {
  verb: ControlVerb
  /** open: the project directory (normalized by the same openCwd path `mogging .` uses). */
  cwd?: string
  /** open/layout: grid size 1..16. */
  panes?: number
  /** focus/expand/close-pane: the target pane id. */
  paneId?: number
  /** expand: which way (defaults to 'full'). */
  mode?: ControlExpandMode
}
