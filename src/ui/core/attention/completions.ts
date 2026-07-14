import type { PaneId } from '@contracts'

/**
 * Per-pane completion history — what this agent finished, and when.
 *
 * A green is designed to be spent: you click the pane (or land on it, which counts) and the
 * halo, the outline and the rail's count all go. That is correct — an alert you cannot dismiss
 * stops being an alert — but it leaves nothing behind, and "what did my agents actually get
 * done while I was away" had no answer at all once the greens were cleared.
 *
 * So every `done` verdict is written down here as it passes through the attention port. Per pane
 * and only per pane (explicit direction: no global feed — the chrome stays clean, and the
 * question is always asked ABOUT a pane anyway). It surfaces in that pane's ⋯ menu.
 *
 * Timestamps only, never content: this is the attention layer, and it may not hold PTY bytes
 * (ADR 0002/0005). Session-scoped by design — it is a record of what happened while you were in
 * the room, not a durable log, and a completion whose pane no longer exists is a completion with
 * nothing to point at.
 */

/** Enough to answer "did it finish, and roughly when" several turns back, without letting a
 *  chatty agent grow this without bound. Newest first. */
const MAX_PER_PANE = 20

const log = new Map<PaneId, number[]>()

/** A `done` verdict landed. Called from the attention port's ONE state gate, on the transition
 *  INTO `done` — so a state-sync pull that re-reads the same done (a renderer reload against a
 *  surviving daemon) cannot record it twice. */
export function recordCompletion(paneId: PaneId, at: number = Date.now()): void {
  const entries = log.get(paneId) ?? []
  entries.unshift(at)
  if (entries.length > MAX_PER_PANE) entries.length = MAX_PER_PANE
  log.set(paneId, entries)
}

/** Newest first. */
export function completionsFor(paneId: PaneId): readonly number[] {
  return log.get(paneId) ?? []
}

/** Pane ids are ordinal-derived and REUSED after a workspace closes. A history that outlived
 *  its pane would be read as the successor's — someone else's work, under your agent's name. */
export function clearCompletions(paneId: PaneId): void {
  log.delete(paneId)
}
