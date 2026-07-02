// Layout control verbs (Phase-3/02). Pane I/O rides the daemon socket (Phase-3/01);
// LAYOUT is renderer state, so these verbs ride the mogging:// deep-link relay through
// MAIN, which validates against this closed union before anything reaches the UI — the
// renderer never parses raw CLI input.

export const CONTROL_VERBS = ['open', 'layout', 'focus', 'expand', 'close-pane'] as const
export type ControlVerb = (typeof CONTROL_VERBS)[number]

export const CONTROL_EXPAND_MODES = ['full', 'col', 'row'] as const
export type ControlExpandMode = (typeof CONTROL_EXPAND_MODES)[number]

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
