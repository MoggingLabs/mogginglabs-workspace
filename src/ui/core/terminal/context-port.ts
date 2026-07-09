import type { ContextUsage, PaneId } from '@contracts'

/**
 * Per-pane agent context usage. WRITER: the `context` feature (which tails each pane's
 * agent session log via the backend). READER: each `TerminalPane`, which renders the
 * header context bar. Exactly the git-port pattern one file over, and for the same
 * reason: `terminal` knows nothing about context IPC, `context` knows nothing about
 * the DOM.
 *
 *   ContextUsage   a real reading — the bar/disc shows the percent.
 *   'pending'      an agent session is WATCHED but has not produced a reading yet
 *                  (the log gains its usage line only after the first response).
 *                  The pane shows the gauge EMPTY with a "–" — an icon that exists
 *                  from the moment the agent does, without inventing a number.
 *   null           nothing to show (no agent, unsupported provider) — bar hidden.
 */
export type PaneContext = ContextUsage | 'pending' | null

const usages = new Map<PaneId, PaneContext>()
const subscribers = new Set<(paneId: PaneId, usage: PaneContext) => void>()

export function setPaneContext(paneId: PaneId, usage: PaneContext): void {
  usages.set(paneId, usage)
  for (const cb of subscribers) cb(paneId, usage)
}

export function clearPaneContext(paneId: PaneId): void {
  if (!usages.delete(paneId)) return
  for (const cb of subscribers) cb(paneId, null)
}

export function getPaneContext(paneId: PaneId): PaneContext {
  return usages.get(paneId) ?? null
}

/** Subscribe to context-usage changes. Current values are replayed immediately. */
export function onPaneContext(cb: (paneId: PaneId, usage: PaneContext) => void): () => void {
  subscribers.add(cb)
  for (const [id, u] of usages) cb(id, u)
  return () => subscribers.delete(cb)
}
