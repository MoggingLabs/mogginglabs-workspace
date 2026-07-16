import { ipcMain } from 'electron'
import { resumeSessionIdFromFile } from '@backend/features/agents'
import {
  WorkspaceChannels,
  type LastSessionInfo,
  type WorkspaceState,
  type WorkspaceStateMeta
} from '@contracts'
import { getSettingsStore } from './app-settings'
import { paneSessionLog } from './context'
import { maybeFault } from './fault-port'

// App-wiring: the LAST WORKING SESSION snapshot behind Home's "Restore last working
// session" card.
//
// WHAT: a durable copy of the most recent non-empty workspace set — every workspace's
// restore manifest (the exact WorkspaceStateMeta shape the boot restore consumes) plus,
// per slot, the agent session log the context monitor had locked while that pane was
// alive. The ordinary auto-restore (workspace/index.ts restore()) already survives a
// crash or a quit-with-workspaces-open; THIS survives the one thing it cannot: the user
// closing every workspace (which disposes the PTYs and empties app_workspaces) and
// coming back later. One click rebuilds the workspaces and relaunches each lineup with
// resume — by EXACT session id where the CLI takes one.
//
// WHEN: on every workspace:saveState, with SHRINK-HOLD semantics. A save that keeps or
// grows the workspace count mirrors the new state into the snapshot; a save that
// REMOVES workspaces does not touch it. Closing five workspaces one by one is five
// shrinking saves, so the snapshot still holds all five at the end of the teardown —
// while a workspace closed mid-day ages out at the first ordinary save that follows
// (any persist: a cwd note, an agent launch, a workspace switch). The capture must ride
// the saves BEFORE the teardown one because by the teardown save the panes are already
// disposed and the monitor's locks are gone. Otherwise browser semantics: starting a
// NEW session replaces the previous snapshot.
//
// CUSTODY: metadata + the CLIs' own session-log paths/ids — never credentials
// (ADR 0002), and the log paths never ride an IPC channel (context.ts's rule).
// workspace:restoreSession strips them from its payload and instead ARMS a main-side
// intent map; the launch path (src/main/agents.ts) consumes an intent exactly once when
// the relaunched lineup asks for its resume command (ADR 0013's exact-session resume,
// extended to a cold app boot).

const KEY = 'lastSession'

/** One slot's recorded agent session: provider + the locked log + the uuid-shaped
 *  resume id derived from the log's NAME (session-pool.ts) — ids and paths only. */
interface SnapshotPaneSession {
  provider: string
  file: string
  sessionId?: string
}

type SnapshotWorkspace = WorkspaceStateMeta & { paneSessions?: (SnapshotPaneSession | null)[] }

interface StoredSnapshot {
  savedAt: number
  activeId: string | null
  workspaces: SnapshotWorkspace[]
}

/** RESUME-gate seam (the setAgentDetectOverrideForSmoke pattern): lets the gate hand a
 *  pane a locked session log without running a real CLI. Inert until called — nothing
 *  in production ever calls it. */
let sessionLogOverrides: Map<number, { provider: string; file: string }> | null = null
export function setPaneSessionLogOverrideForSmoke(
  paneId: number,
  log: { provider: string; file: string } | null
): void {
  if (!sessionLogOverrides) sessionLogOverrides = new Map()
  if (log) sessionLogOverrides.set(paneId, log)
  else sessionLogOverrides.delete(paneId)
}

function lockedSessionLog(paneId: number): { provider: string; file: string } | undefined {
  return sessionLogOverrides?.get(paneId) ?? paneSessionLog(paneId)
}

/** The pane id a workspace slot restores to — the same resolution the renderer's
 *  paneIdForSlot applies (ui/features/workspace/model.ts): a pane MOVED here keeps its
 *  own id (it IS the daemon session key); everything else follows ordinal*100+slot. */
function paneIdForSlot(meta: WorkspaceStateMeta, slot: number): number {
  const moved = meta.paneIds?.[slot - 1]
  return typeof moved === 'number' && moved >= 1 ? moved : meta.ordinal * 100 + slot
}

/** Per-slot session capture for one workspace, while its panes are alive. Slots whose
 *  pane has no locked log (a plain shell, a CLI the monitor can't read) record null. */
function paneSessionsFor(meta: WorkspaceStateMeta): (SnapshotPaneSession | null)[] | undefined {
  const slots = Math.max(meta.paneCount, meta.assignments?.length ?? 0, meta.paneIds?.length ?? 0)
  const sessions: (SnapshotPaneSession | null)[] = []
  let any = false
  for (let slot = 1; slot <= slots; slot++) {
    const log = lockedSessionLog(paneIdForSlot(meta, slot))
    if (!log) {
      sessions.push(null)
      continue
    }
    any = true
    sessions.push({
      provider: log.provider,
      file: log.file,
      sessionId: resumeSessionIdFromFile(log.provider, log.file) ?? undefined
    })
  }
  return any ? sessions : undefined
}

/**
 * Called by the workspace:saveState handler (app-settings.ts) with the state it just
 * replaced and the state it wrote. Mirrors non-shrinking, non-empty saves into the
 * snapshot; holds through teardown saves. Best-effort by contract: a snapshot failure
 * must never fail the save that carried it.
 */
export function noteWorkspaceSave(previous: WorkspaceState | null, next: WorkspaceState): void {
  try {
    const store = getSettingsStore()
    if (!store) return
    const prevCount = previous?.workspaces?.length ?? 0
    const nextCount = next.workspaces.length
    // Teardown/hold: an empty or shrinking save keeps the pre-shrink snapshot —
    // that snapshot IS the "last working session" the empty Home will offer back.
    if (nextCount === 0 || nextCount < prevCount) return
    const snapshot: StoredSnapshot = {
      savedAt: Date.now(),
      activeId: next.activeId ?? null,
      workspaces: next.workspaces.map((w) => {
        const paneSessions = paneSessionsFor(w)
        return paneSessions ? { ...w, paneSessions } : { ...w }
      })
    }
    store.setSetting(KEY, JSON.stringify(snapshot))
  } catch {
    /* the save itself already succeeded — a snapshot miss surfaces as "nothing to restore" */
  }
}

function loadSnapshot(): StoredSnapshot | null {
  try {
    const raw = getSettingsStore()?.getSetting(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredSnapshot
    if (!Array.isArray(parsed?.workspaces) || parsed.workspaces.length === 0) return null
    return parsed
  } catch {
    return null
  }
}

/** The IPC payload: the snapshot MINUS the session-log paths (those stay main-side —
 *  restoring arms them as intents instead of shipping them to the renderer). */
function publicInfo(snapshot: StoredSnapshot | null): LastSessionInfo | null {
  if (!snapshot) return null
  return {
    savedAt: snapshot.savedAt,
    activeId: snapshot.activeId,
    workspaces: snapshot.workspaces.map(({ paneSessions: _paneSessions, ...meta }) => meta)
  }
}

/** paneId -> the session its relaunch should resume. Armed by workspace:restoreSession,
 *  consumed AT MOST ONCE per pane by the launch path — a stale intent must never name a
 *  session for some later, unrelated launch into a recycled pane id. TTL for the tail
 *  case: a launch REFUSED before its command was built (a deleted profile, a failed
 *  settings reconcile) never consumes, and pane ids recycle — after the window every
 *  survivor is dead, not waiting. A real restore consumes within seconds. */
const RESUME_INTENT_TTL_MS = 5 * 60_000
const resumeIntents = new Map<number, SnapshotPaneSession>()
let resumeIntentsArmedAt = 0

function armResumeIntents(snapshot: StoredSnapshot): void {
  resumeIntents.clear()
  resumeIntentsArmedAt = Date.now()
  for (const w of snapshot.workspaces) {
    w.paneSessions?.forEach((session, i) => {
      if (session?.provider) resumeIntents.set(paneIdForSlot(w, i + 1), session)
    })
  }
}

/**
 * The exact-session id a restored launch should resume, or undefined. Consumed once.
 * Read by src/main/agents.ts AFTER the context monitor's live lock (the live lock is
 * fresher — it exists whenever the pane already ran this provider in this app run).
 */
export function consumeRestoreResumeSessionId(paneId: number, provider: string): string | undefined {
  if (resumeIntents.size && Date.now() - resumeIntentsArmedAt > RESUME_INTENT_TTL_MS) {
    resumeIntents.clear()
    return undefined
  }
  const intent = resumeIntents.get(paneId)
  if (!intent) return undefined
  if (intent.provider !== provider) return undefined
  resumeIntents.delete(paneId)
  return intent.sessionId ?? (resumeSessionIdFromFile(intent.provider, intent.file) ?? undefined)
}

/** RESUME-gate peeks: the stored snapshot verbatim, and the armed intent set. */
export function lastSessionSnapshotForSmoke(): StoredSnapshot | null {
  return loadSnapshot()
}
export function resumeIntentsForSmoke(): Array<{ paneId: number; provider: string; sessionId?: string }> {
  return [...resumeIntents.entries()].map(([paneId, s]) => ({
    paneId,
    provider: s.provider,
    sessionId: s.sessionId
  }))
}

export function registerSessionRestore(): void {
  ipcMain.handle(WorkspaceChannels.lastSession, async () => {
    // Finding 39's seam: Home's restore card reads from here — the ASYNCSTATE gate
    // rejects/hangs THIS handler, the one the launcher really calls.
    await maybeFault(WorkspaceChannels.lastSession)
    return publicInfo(loadSnapshot())
  })
  ipcMain.handle(WorkspaceChannels.restoreSession, async () => {
    await maybeFault(WorkspaceChannels.restoreSession)
    const snapshot = loadSnapshot()
    if (!snapshot) return null
    armResumeIntents(snapshot)
    return publicInfo(snapshot)
  })
}
