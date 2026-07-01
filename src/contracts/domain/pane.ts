/** Stable identifier for a terminal pane within a workspace. */
export type PaneId = number

/** Everything needed to (re)create a pane's hosted process. */
export interface PaneSpec {
  id: PaneId
  cwd: string
  cols: number
  rows: number
}
