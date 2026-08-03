import type { WorkspaceState, WorkspaceStateMeta } from '@contracts'

// The PURE half of session-restore.ts (the usage-prices.ts extraction pattern): the
// pane-id resolution and the boot-intent intersection are decision rules the unit tier
// must hold without Electron. session-restore.ts wires them to the store and the IPC.

/** One slot's recorded agent session — ids and main-side paths only.
 *
 *  `file` is the transcript the monitor had LOCKED, and it is optional because a session
 *  can be known without one: an ASSIGNED claude id (`--session-id`) names the conversation
 *  before its transcript exists. `sessionId` is therefore the authoritative field and the
 *  file is only the older way to derive it (session-pool.ts reads it off the name). */
export interface SnapshotPaneSession {
  provider: string
  file?: string
  sessionId?: string
}

export type SnapshotWorkspace = WorkspaceStateMeta & { paneSessions?: (SnapshotPaneSession | null)[] }

export interface StoredSnapshot {
  savedAt: number
  activeId: string | null
  workspaces: SnapshotWorkspace[]
}

/** The pane id a workspace slot restores to — the same resolution the renderer's
 *  paneIdForSlot applies (ui/features/workspace/model.ts): a pane MOVED here keeps its
 *  own id (it IS the daemon session key); everything else follows ordinal*100+slot. */
export function paneIdForSlot(meta: WorkspaceStateMeta, slot: number): number {
  const moved = meta.paneIds?.[slot - 1]
  return typeof moved === 'number' && moved >= 1 ? moved : meta.ordinal * 100 + slot
}

/**
 * The resume intents an APP-BOOT restore may arm: the snapshot's per-slot sessions,
 * INTERSECTED with the state actually being restored. The snapshot can be older than
 * app_workspaces (shrink-hold keeps closed sets alive on purpose), so an intent arms
 * only where the two agree that the slot still means the same thing:
 *   - same workspace ID (identity, not position),
 *   - the slot's assignment still names the session's provider,
 *   - the slot resolves to the same pane id on both sides (ordinal / moved-pane
 *     drift changes the id, and a stale intent must never name a session for a pane
 *     that now belongs to something else).
 * Ids and main-side paths only — the caller never ships these to the renderer.
 */
export function bootIntentsFor(
  snapshot: StoredSnapshot,
  current: WorkspaceState
): Array<{ paneId: number; session: SnapshotPaneSession }> {
  const byId = new Map(current.workspaces.map((w) => [w.id, w]))
  const intents: Array<{ paneId: number; session: SnapshotPaneSession }> = []
  for (const snap of snapshot.workspaces) {
    const live = byId.get(snap.id)
    if (!live || !snap.paneSessions) continue
    snap.paneSessions.forEach((session, i) => {
      if (!session?.provider) return
      if (live.assignments?.[i] !== session.provider) return
      const paneId = paneIdForSlot(live, i + 1)
      if (paneId !== paneIdForSlot(snap, i + 1)) return
      intents.push({ paneId, session })
    })
  }
  return intents
}
