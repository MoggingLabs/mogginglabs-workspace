// Local Kanban board (Phase-3/05): cards that LAUNCH agents. Card text is USER
// CONTENT — it lives in the local app db and NOTHING else: never telemetry, never
// notify payloads, never logs (ADR 0005).

export const BOARD_LANES = ['todo', 'doing', 'review', 'done'] as const
export type BoardLane = (typeof BOARD_LANES)[number]

export interface BoardCard {
  id: string
  title: string
  notes: string
  lane: BoardLane
  /** Bound pane once "Start agent" launched one (cleared when the pane closes). */
  paneId?: number | null
  workspaceId?: string | null
  createdAt: number
  updatedAt: number
}
