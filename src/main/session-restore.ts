import { ipcMain } from 'electron'
// Subpath, not the barrel: the agents barrel re-exports install.ts, which reaches the
// terminal feature and so node-pty — and on POSIX node-pty loads its native binding AT
// IMPORT (unixTerminal.ts), so any unit test that imports app-settings (-> here) dies on
// a runner with no compiled addon (ed9bc80's precedent: the barrel reaches node-pty).
import { resumeSessionIdFromFile } from '@backend/features/agents/session-pool'
import {
  WorkspaceChannels,
  type LastSessionInfo,
  type WorkspaceState,
  type WorkspaceStateMeta
} from '@contracts'
import { getSettingsStore } from './app-settings'
import { assignedSessionFor } from './assigned-sessions'
import { paneSessionLog } from './context'
import { maybeFault } from './fault-port'
import { bootIntentsFor, paneIdForSlot, type SnapshotPaneSession, type StoredSnapshot } from './session-restore-rules'

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

/** How many slots a workspace's manifest describes: paneCount is the count, but a per-slot
 *  array that runs longer still names a slot, so the widest one wins. */
function slotCount(meta: WorkspaceStateMeta): number {
  return Math.max(meta.paneCount, meta.assignments?.length ?? 0, meta.paneIds?.length ?? 0)
}

/**
 * Per-slot session capture for one workspace, while its panes are alive. Slots whose pane
 * has no session at all (a plain shell, a CLI the monitor can't read) record null.
 *
 * TWO sources, because a locked log is not the only way to know a session. The monitor's
 * lock is the DISCOVERED identity — it needs a transcript on disk, so it cannot exist
 * until the user has actually prompted the agent. The pane's ASSIGNED id is the identity
 * the app chose at launch (`claude --session-id`), and it is knowable from the first
 * millisecond. Without the second source, a snapshot taken between "claude launched" and
 * "user typed something" recorded null and the pane came back from a restart into a bare
 * `--resume` picker — precisely the gap assigning ids exists to close. The lock still
 * wins where both answer: it is the one that tracks claude's own `/clear`.
 */
function paneSessionsFor(meta: WorkspaceStateMeta): (SnapshotPaneSession | null)[] | undefined {
  const sessions: (SnapshotPaneSession | null)[] = []
  let any = false
  for (let slot = 1; slot <= slotCount(meta); slot++) {
    const paneId = paneIdForSlot(meta, slot)
    const log = lockedSessionLog(paneId)
    // Assigned ids are claude's alone (agents.ts assigns nowhere else); the slot's own
    // assignment is the check that keeps a recycled pane id from lending one to another
    // provider — bootIntentsFor would drop the mismatch anyway, but not recording it is
    // better than recording it and relying on the reader to disbelieve it.
    const assigned = meta.assignments?.[slot - 1] === 'claude' ? assignedSessionFor(paneId) : undefined
    if (!log && !assigned) {
      sessions.push(null)
      continue
    }
    any = true
    sessions.push(
      log
        ? { provider: log.provider, file: log.file, sessionId: resumeSessionIdFromFile(log.provider, log.file) ?? assigned }
        : { provider: 'claude', sessionId: assigned }
    )
  }
  return any ? sessions : undefined
}

/** The sessions an EARLIER save recorded for this workspace, re-read through the panes they
 *  were recorded AGAINST and re-placed on the slots those panes hold now.
 *
 *  A slot index is not an identity. `paneIds` re-lets a slot to a pane dragged in from another
 *  workspace (contracts/domain/pane.ts), and both readers of a stored array — armResumeIntents
 *  and bootIntentsFor — resolve it through the meta that array RIDES. So a held array grafted
 *  by POSITION is silently re-keyed onto the new occupants: a session recorded for slot 3 while
 *  that slot was still the formula's pane 103 arms on the pane 205 that has moved in since, and
 *  the user's conversation reopens inside somebody else's terminal while the pane that owns it
 *  resumes nothing. The hold therefore travels by PANE ID, resolved through the meta that
 *  recorded it, and lands only where that same pane still sits. A pane that left takes its
 *  session with it and the slot holds nothing — the pre-hold answer, a bare relaunch, which is
 *  far the cheaper wrong. */
function heldSessionsFor(
  held: StoredSnapshot | null,
  next: WorkspaceStateMeta
): (SnapshotPaneSession | null)[] | undefined {
  const prior = held?.workspaces.find((p) => p.id === next.id)
  const priorSessions = prior?.paneSessions
  if (!prior || !priorSessions) return undefined
  const byPane = new Map<number, SnapshotPaneSession>()
  priorSessions.forEach((session, i) => {
    if (session) byPane.set(paneIdForSlot(prior, i + 1), session)
  })
  const sessions: (SnapshotPaneSession | null)[] = []
  let any = false
  for (let slot = 1; slot <= slotCount(next); slot++) {
    const session = byPane.get(paneIdForSlot(next, slot))
    if (session) any = true
    sessions.push(session ?? null)
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
    // Read past that return, never before it: closing a five-workspace day is five saves,
    // and each was paying for a settings read and a parse it then threw away.
    const held = loadSnapshot()
    const snapshot: StoredSnapshot = {
      savedAt: Date.now(),
      activeId: next.activeId ?? null,
      workspaces: next.workspaces.map((w) => {
        // HOLD what this save cannot re-derive, the same stance as the shrink-hold above.
        // The boot restore fires a debounced mirror save ~400ms after launch, when the context
        // monitor has locked NO session logs yet and no launch has assigned an id either — so
        // paneSessionsFor answers undefined for every workspace and this rewrite ERASED the
        // exact-session ids the card exists to carry. A later teardown save is held, so a user
        // who boots, works, and closes without an intervening lock-bearing save restored with a
        // bare `--resume`: the CLI's session PICKER instead of their conversation.
        const paneSessions = paneSessionsFor(w) ?? heldSessionsFor(held, w)
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
 * Arm resume intents for the ordinary APP-BOOT restore — once per app run, at the first
 * workspace:loadState (app-settings.ts calls this with the state it is about to return).
 * The boot lineup has always relaunched with `resume: true`, but its exact ids lived
 * only in the snapshot and nothing armed them — so every cold-daemon restart (normal
 * quit AND crash) typed the bare `--resume` and dropped the user into the CLI's session
 * picker, while Home's card (the zero-workspace path) resumed exactly (audit
 * 2026-08-02). Intersected with the state being restored (bootIntentsFor): shrink-hold
 * keeps OLD workspace sets in the snapshot on purpose, and a stale intent must never
 * name a session for a pane id that now belongs to something else. Best-effort: the
 * restore proceeds bare without it.
 */
let bootIntentsArmed = false
export function armBootResumeIntentsOnce(current: WorkspaceState | null): void {
  if (bootIntentsArmed) return
  bootIntentsArmed = true
  try {
    if (!current?.workspaces?.length) return
    const snapshot = loadSnapshot()
    if (!snapshot) return
    const intents = bootIntentsFor(snapshot, current)
    if (!intents.length) return
    resumeIntents.clear()
    resumeIntentsArmedAt = Date.now()
    for (const { paneId, session } of intents) resumeIntents.set(paneId, session)
  } catch {
    /* arming is a courtesy — the restore proceeds with the bare flag without it */
  }
}

/**
 * The exact-session id a restored launch should resume, or undefined. Consumed once.
 * Read by src/main/agents.ts AFTER the context monitor's live lock (the live lock is
 * fresher — it exists whenever the pane already ran this provider in this app run).
 */
export function peekRestoreResumeSessionId(paneId: number, provider: string): string | undefined {
  return readRestoreResumeSessionId(paneId, provider, false)
}

/** The consuming read (the launch really happening) and the PEEK (a prefetch build that
 *  may yet be discarded) differ by exactly one thing: whether the shelf is cleared. A
 *  prefetch must be able to name the same session without spending the intent, because
 *  a pane that turns out to be daemon-reattached types nothing at all. */
function readRestoreResumeSessionId(paneId: number, provider: string, consume: boolean): string | undefined {
  if (resumeIntents.size && Date.now() - resumeIntentsArmedAt > RESUME_INTENT_TTL_MS) {
    resumeIntents.clear()
    return undefined
  }
  const intent = resumeIntents.get(paneId)
  if (!intent) return undefined
  if (intent.provider !== provider) return undefined
  if (consume) resumeIntents.delete(paneId)
  // An assigned id is recorded WITHOUT a file (its transcript may not exist yet), so the
  // derive-from-name fallback only applies where a locked log was captured.
  return intent.sessionId ?? (intent.file ? (resumeSessionIdFromFile(intent.provider, intent.file) ?? undefined) : undefined)
}

export function consumeRestoreResumeSessionId(paneId: number, provider: string): string | undefined {
  return readRestoreResumeSessionId(paneId, provider, true)
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
