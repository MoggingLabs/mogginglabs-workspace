/**
 * WHAT A CLOSE WOULD DESTROY — one definition of "live", shared by every destructive path
 * (close workspace / close pane / shrink layout / reorganize) so the predicate and the copy
 * cannot drift. They had: each counted `session || state !== idle` and then told the user
 * those panes had "an agent still working".
 *
 * THREE kinds of evidence, TWO spoken reasons:
 *   hasSession   an agent session is ASSIGNED. Not activity — an agent parked at its
 *                prompt still has one.
 *   working      the agent's own verdict (busy | attention). Under the verdict law that
 *                means the agent SAID so; output raises nothing.
 *   foreground   the pane's shell is waiting on a child process. Says nothing about
 *                agents, and it is the only evidence a plain shell can ever produce —
 *                `vim` in an untracked pane is permanently `unknown` on the attention port
 *                (its tracked gate drops the verdict and ActivityTracker refuses to author
 *                a never-spoken pane's first state), which is why this had to be its own
 *                signal rather than a looser reading of that one.
 *
 * `working` and `foreground` are the SAME SENTENCE in English — "still running" — so they
 * share one clause and one count. Speaking them apart would produce "2 panes are still
 * running, and 1 pane is still running", and would turn a three-way copy ladder into a
 * seven-way one. `LivePanes.running`'s original doc already promised "agent turn, or any
 * command"; this is the change that finally makes it true.
 */

export interface PaneLiveness {
  id: number
  hasSession: boolean
  working: boolean
  foreground: boolean
  /** The foreground executable's basename, when the backend could name it. */
  command?: string
}

export interface LivePanes {
  /** Live for ANY reason — the union. Empty ⇒ no confirmation is warranted. */
  panes: number[]
  sessions: number[]
  /** SPOKEN as "still running": working ∪ foreground. */
  running: number[]
  working: number[]
  foreground: number[]
  /** The one command worth quoting — see `inspectLiveness`. */
  command?: string
}

/** A basename comes from a process table, but it lands in a dialog a human reads. Bound it
 *  and refuse control characters rather than trust the wire. */
const MAX_COMMAND = 32
function nameable(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed.length > MAX_COMMAND) return undefined
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return undefined
  }
  return trimmed
}

export function inspectLiveness(rows: readonly PaneLiveness[]): LivePanes {
  const live: LivePanes = { panes: [], sessions: [], running: [], working: [], foreground: [] }
  for (const row of rows) {
    if (row.hasSession) live.sessions.push(row.id)
    if (row.working) live.working.push(row.id)
    if (row.foreground) live.foreground.push(row.id)
    if (row.working || row.foreground) live.running.push(row.id)
    if (row.hasSession || row.working || row.foreground) live.panes.push(row.id)
  }
  // Name a command only when there is exactly ONE live pane and no session to outrank it.
  // Ambiguity is silence: two names in one dialog is noise, not help.
  if (live.panes.length === 1 && live.sessions.length === 0) {
    live.command = nameable(rows.find((row) => row.id === live.panes[0])?.command)
  }
  return live
}

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The MULTI-pane clause. Never says "agent" about a pane we only know is busy; never says
 *  "working" about an agent we only know is assigned. */
export function describeLive(live: LivePanes): string {
  const parts: string[] = []
  if (live.sessions.length > 0) {
    parts.push(`${plural(live.sessions.length, 'pane has', 'panes have')} an agent session`)
  }
  if (live.running.length > 0) {
    parts.push(`${plural(live.running.length, 'pane is', 'panes are')} still running`)
  }
  return parts.join(', and ')
}

/** The SINGLE-pane sentence. The session OUTRANKS the name: "an agent session … is still
 *  running claude" is noise, and the pure-process branch is the one pinned to contain no
 *  mention of an agent at all. */
export function describePaneLive(live: LivePanes): string {
  if (live.sessions.length > 0) {
    return live.running.length > 0
      ? 'An agent session is assigned to this pane and is still running.'
      : 'An agent session is assigned to this pane.'
  }
  return live.command ? `This pane is still running ${live.command}.` : 'This pane is still running.'
}
