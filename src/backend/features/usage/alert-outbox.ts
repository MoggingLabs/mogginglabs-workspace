import type { UsageAlert } from '@contracts'

// The alert outbox's rules, extracted from main/usage.ts so they can be tested
// at all (src/main is Electron-bound; this is not).
//
// The outbox is a guaranteed-delivery queue: the engine spends its single-fire
// state the moment it decides to alert, so the decision and the delivery must
// not share a fate. That is right for NEWS. What went wrong is that a `capped`
// alert is not only news — it was also the trigger for persistent,
// input-blocking UI — and the queue's TTL was 24 hours. A 5-hour window's
// "limit reached" therefore outlived its own subject by nineteen hours and
// replayed into a pane offer after an update restart.
//
// The offer no longer rides this queue at all (it is derived from live lane
// state). These rules fix the queue on its own terms: news about a window that
// has already rolled is OVER, however recently it was queued.

export interface QueuedAlert extends UsageAlert {
  alertId: string
  queuedAt: number
  /** How many times this entry has been offered to a renderer without an ack. */
  drains?: number
}

export const OUTBOX_CAP = 20
/** The outer bound, unchanged: nothing survives a day. */
export const OUTBOX_TTL_MS = 24 * 3_600_000
/** A `capped` claim with no boundary to check is unverifiable news; an hour is
 *  its ceiling. (Every lane the engine meters publishes a boundary; this is the
 *  floor for a provider that stops.) */
export const CAPPED_BOUNDLESS_TTL_MS = 60 * 60_000
/** Three unacked offers is a dead letter. `alertAck` is fire-and-forget, so a
 *  rejected ack (window torn down mid-quit, handler not yet installed) silently
 *  leaves the entry queued — correct at-least-once ONCE, but with nothing
 *  bounding the retries it becomes at-least-once-forever. */
export const MAX_DRAINS = 3

/** Is this entry still worth delivering? */
export function outboxLive(a: QueuedAlert, now: number): boolean {
  if (now - a.queuedAt >= OUTBOX_TTL_MS) return false
  // THE CORRECTED RULE. The window this alert describes is over, so the alert is
  // too — this one line is what stops a 5-hour cap from replaying tomorrow. It
  // applies to every kind, not just `capped`: a `reset` alert about a window that
  // has since rolled again is equally spent.
  if (a.resetsAt) {
    const at = Date.parse(a.resetsAt)
    if (Number.isFinite(at) && at <= now) return false
  } else if (a.level === 'capped' && now - a.queuedAt >= CAPPED_BOUNDLESS_TTL_MS) {
    return false
  }
  if ((a.drains ?? 0) >= MAX_DRAINS) return false
  return true
}

/** Add new alerts, compacting dead ones on the way in, newest-wins at the cap. */
export function enqueueAlerts(queue: readonly QueuedAlert[], next: readonly QueuedAlert[], now: number): QueuedAlert[] {
  return [...queue.filter((a) => outboxLive(a, now)), ...next].slice(-OUTBOX_CAP)
}

/** Take everything deliverable, counting the attempt. Drain does NOT clear —
 *  only an ack does, because "the invoke resolved" and "a toast reached the DOM"
 *  are different facts — but an entry offered MAX_DRAINS times is delivered that
 *  last time and then dropped, never a further one. */
export function drainOutbox(queue: readonly QueuedAlert[], now: number): { deliver: QueuedAlert[]; keep: QueuedAlert[] } {
  const deliver: QueuedAlert[] = []
  const keep: QueuedAlert[] = []
  for (const a of queue) {
    if (!outboxLive(a, now)) continue
    const bumped: QueuedAlert = { ...a, drains: (a.drains ?? 0) + 1 }
    deliver.push(bumped)
    if (outboxLive(bumped, now)) keep.push(bumped)
  }
  return { deliver, keep }
}

export function ackOutbox(queue: readonly QueuedAlert[], alertId: string): QueuedAlert[] {
  return queue.filter((a) => a.alertId !== alertId)
}
