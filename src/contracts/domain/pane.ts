/** Stable identifier for a terminal pane within a workspace. */
export type PaneId = number

/** Everything needed to (re)create a pane's hosted process. */
export interface PaneSpec {
  id: PaneId
  cwd: string
  cols: number
  rows: number
}

// ── The pane-id ↔ workspace convention, stated ONCE ─────────────────────────
// A pane is BORN at `ordinal * PANE_SLOT_STRIDE + slot` (slots are 1-based), and for
// almost every pane that stays true for life — the id doubles as its daemon session
// key, which is why a pane that MOVES between workspaces keeps it: re-keying would
// mean killing the PTY and the agent inside it. The receiving workspace records the
// exception in its `paneIds` array, and an explicit claim always outranks the formula.
// This used to live as a bare `100` in eight files across main and the renderer, with
// main's copy missing the paneIds half entirely (a moved pane's grants and browser
// routing resolved to the workspace it LEFT).

/** Max panes a workspace's id-space holds — also the id gap between ordinals. */
export const PANE_SLOT_STRIDE = 100

/** Where a pane is born: the formula id for (workspace ordinal, 1-based slot). */
export const formulaPaneId = (ordinal: number, slot: number): number => ordinal * PANE_SLOT_STRIDE + slot

/** The formula's guess at a pane's birth ordinal. Only meaningful through locatePane —
 *  a moved pane's real workspace is whoever CLAIMS it. */
export const formulaOrdinalOf = (paneId: number): number => Math.floor(paneId / PANE_SLOT_STRIDE)

/** The short number a pane WEARS ("Terminal 3"): its birth slot, falling back to the
 *  raw id when the id predates (or sits outside) the formula. Display only — stable
 *  across moves, which is the point: a pane keeps its name wherever it lands. */
export const displayPaneNumber = (paneId: number): number => paneId % PANE_SLOT_STRIDE || paneId

/** What a resolver needs to know about one workspace to answer "whose pane is this?". */
export interface PaneOwnerWorkspace {
  ordinal: number
  /** Per-slot pane-id overrides for panes that moved in (index = slot - 1). */
  paneIds?: (number | null)[]
}

/**
 * Which workspace holds this pane, and in which SLOT (1-based). Explicit `paneIds`
 * claims are searched first; the formula answers only when no workspace claims the id
 * AND the formula slot has not been re-let to a pane from elsewhere. Undefined means
 * the pane belongs to no known workspace — callers fail CLOSED on it.
 */
export function locatePane<T extends PaneOwnerWorkspace>(
  workspaces: readonly T[],
  paneId: number
): { ws: T; slot: number } | undefined {
  for (const ws of workspaces) {
    const slot = ws.paneIds?.findIndex((id) => id === paneId) ?? -1
    if (slot >= 0) return { ws, slot: slot + 1 }
  }
  const ordinal = formulaOrdinalOf(paneId)
  const slot = paneId - ordinal * PANE_SLOT_STRIDE
  if (slot < 1) return undefined
  const ws = workspaces.find((w) => w.ordinal === ordinal)
  // ...but a slot that has been RE-let to a pane from elsewhere cannot also still be
  // answering for the one that moved out. That pane lives in whichever workspace claimed
  // it above; if none did, it is simply gone.
  if (!ws || (ws.paneIds?.[slot - 1] != null && ws.paneIds[slot - 1] !== paneId)) return undefined
  return { ws, slot }
}
