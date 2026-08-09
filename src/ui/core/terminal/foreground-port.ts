import type { PaneForegroundEvent, PaneId } from '@contracts'

/**
 * FOREGROUND WORK — does this pane's shell have a child process running in it?
 *
 * Its own port, on purpose. Three questions about a pane, three answers, three owners:
 *   core/terminal/liveness-port  — has this PTY ever produced output?
 *   core/attention/attention-port — what did the AGENT say it was doing?
 *   here                          — is a program running in the shell right now?
 *
 * Routing this through the attention port would have been shorter and wrong twice over.
 * That port drops verdicts for untracked panes (the tracked gate), so a plain shell — the
 * only case this exists for — could never speak through it. And its verdicts light dots,
 * outlines, rail counts and toasts: a red dot for `vim` is exactly the cross-surface lie
 * the gate was built to forbid. This feeds the destructive confirms and the layout
 * popover's live count, and nothing else.
 *
 * READER: `src/ui/features/workspace/live-panes.ts`, through the controller's inspectLive.
 */

export interface PaneForeground {
  /** The shell is waiting on a child process. THE fact the confirms read. */
  readonly active: boolean
  readonly pid?: number
  /** The executable's basename, when the process table could name it. */
  readonly command?: string
}

interface StoredForeground {
  value: PaneForeground
  generation: string
  retiredGenerations: Set<string>
}

/** Same bound, same reason, as pane-cwd's: pane ids are REUSED, and a straggler queued in
 *  the IPC pipe from before a reconnect must never re-open a successor's verdict. */
const MAX_RETIRED_GENERATIONS = 8

const entries = new Map<PaneId, StoredForeground>()
const subscribers = new Set<(paneId: PaneId, foreground: PaneForeground | null) => void>()

const same = (a: PaneForeground | undefined, b: PaneForeground): boolean =>
  !!a && a.active === b.active && a.pid === b.pid && a.command === b.command

/** Apply a backend event. Returns false when it was dropped as stale. */
export function applyPaneForegroundEvent(event: PaneForegroundEvent): boolean {
  const stored = entries.get(event.id)
  if (stored?.retiredGenerations.has(event.generation)) return false

  const retiredGenerations = new Set(stored?.retiredGenerations)
  if (stored && stored.generation !== event.generation) retiredGenerations.add(stored.generation)
  while (retiredGenerations.size > MAX_RETIRED_GENERATIONS) {
    const oldest = retiredGenerations.values().next().value
    if (oldest === undefined) break
    retiredGenerations.delete(oldest)
  }

  const next: PaneForeground = { active: event.active, pid: event.pid, command: event.command }
  entries.set(event.id, { value: next, generation: event.generation, retiredGenerations })
  if (!same(stored?.value, next)) for (const cb of subscribers) cb(event.id, next)
  return true
}

/** Pane disposal: drop the entry before the id can be handed out again. */
export function clearPaneForeground(paneId: PaneId): void {
  if (!entries.delete(paneId)) return
  for (const cb of subscribers) cb(paneId, null)
}

export function getPaneForeground(paneId: PaneId): PaneForeground | undefined {
  return entries.get(paneId)?.value
}

/** THE predicate every destructive door asks. */
export function paneHasForegroundWork(paneId: PaneId): boolean {
  return entries.get(paneId)?.value.active === true
}

/** Subscribe; current values are replayed immediately, so a late-mounted consumer does not
 *  wait for the next Enter to learn a pane has been running something for an hour. */
export function onPaneForeground(
  cb: (paneId: PaneId, foreground: PaneForeground | null) => void
): () => void {
  subscribers.add(cb)
  for (const [id, state] of entries) cb(id, state.value)
  return () => subscribers.delete(cb)
}
