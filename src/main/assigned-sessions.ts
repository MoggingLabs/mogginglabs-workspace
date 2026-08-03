import { randomUUID } from 'node:crypto'

// The session ids this app ASSIGNED to panes (`claude --session-id`), main-side.
//
// This is the record that makes identity a fact instead of a deduction: the app chose
// the id, so it knows which conversation a pane is in without recognising a transcript
// afterwards. It replaces the retained-lock guesswork the switch flow needed (the live
// lock is released the moment the interrupt kills the CLI, which is exactly when a
// relaunch needs the id).
//
// UNIQUENESS IS LOAD-BEARING. Two panes carrying one session id means two live claude
// processes appending to ONE transcript — a corruption the old world could not produce,
// because ids were discovered from distinct files. A generated id is therefore checked
// against every id this run has handed out and not yet released.
//
// Lifetime is the pane's: a launch claims, a re-launch replaces, pane disposal releases
// (daemon-relay's onExit — the SHELL dying, not the agent, which is what keeps a
// failover's id alive across the interrupt that kills the capped CLI).
//
// DURABILITY is the restore manifest's (session-restore.ts): its per-slot paneSessions
// already persist exactly this fact for the boot restore, so an assigned id is written
// there rather than into a second store of the same truth.
//
// NOT recovered from the process table, deliberately. A live `claude --session-id <uuid>`
// wears its id in argv, and agent-proc.ts already reads every pane's command lines — but
// that module's standing invariant is that argv is "read, matched, and DROPPED" (ADR
// 0002/0005), and the only case an argv fallback would add is an app crash before the
// first save with the daemon still holding the pane. That pane REATTACHES to its living
// agent instead of relaunching, so the monitor locks its transcript the ordinary way and
// the id gets banked at the next unwatch. Amending a privacy invariant to cover a case
// the reattach path already covers is a bad trade.

const assigned = new Map<number, string>()

/** claude session ids are UUIDs, and its transcripts are named `<id>.jsonl` — so this
 *  both validates an id we were handed and recognises one in a file name. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A fresh session id for a pane, guaranteed not to collide with a live one. */
export function newClaudeSessionId(paneId: number): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = randomUUID()
    if (![...assigned.entries()].some(([pane, held]) => pane !== paneId && held === id)) return id
  }
  // randomUUID collided eight times: impossible in practice, and a wrong answer here
  // would be a shared transcript — so refuse rather than hand back a duplicate.
  throw new Error('could not mint a unique session id')
}

/** Record the id a pane's launch was built with (called when the launch really happens). */
export function rememberAssignedSession(paneId: number, sessionId: string): void {
  assigned.set(paneId, sessionId)
}

/** The id this app assigned to the pane, if any. */
export function assignedSessionFor(paneId: number): string | undefined {
  return assigned.get(paneId)
}

/** Seed from durable storage (the workspace manifest) on restore — the app forgot what
 *  it assigned, but the pane and its agent are still there. Never overwrites a live
 *  assignment made this run. */
export function adoptAssignedSession(paneId: number, sessionId: string): void {
  if (!assigned.has(paneId)) assigned.set(paneId, sessionId)
}

/** The pane is gone (or its session is): release the id so it can never be re-served. */
export function forgetAssignedSession(paneId: number): void {
  assigned.delete(paneId)
}

/** Gate/test seam: the whole live map, ids only. */
export function assignedSessionsForSmoke(): Array<{ paneId: number; sessionId: string }> {
  return [...assigned.entries()].map(([paneId, sessionId]) => ({ paneId, sessionId }))
}
