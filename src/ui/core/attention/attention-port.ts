import type { AgentState, PaneId } from '@contracts'

/**
 * Per-pane agent state, aggregated for "which agent needs me" indicators. Each `TerminalPane`
 * publishes its OSC state here; the `workspace` feature aggregates per workspace into a tab
 * outline/badge, and the app raises a dock/taskbar badge. A ui-core port so those features stay
 * decoupled from `terminal`. Primitives only — never PTY content (ADR 0002/0005).
 *
 * Also owns the STICKY FINISHED flag (explicit direction: "green can only go to idle
 * after I click that pane"). Derived HERE, at the single gate every state transition
 * passes through, so every consumer — the pane dot, the rail badge/outline, the grid
 * pulses — reads one truth and can never disagree:
 *   set      on the finished edge: the pane WAS WORKING (busy) and went idle — it
 *            stopped, and you haven't looked at it yet. An attention→idle edge is
 *            deliberately NOT finished: a blocked pane going idle means its latch was
 *            torn down (the user answered it, a state replay after a daemon restart,
 *            an explicit notify) — nothing completed, so it must never tell the green
 *            "done" story (a permission-blocked pane once pulsed green through this
 *            edge — found live 2026-07-10).
 *   cleared  by `acknowledgeFinished` (a real click on the pane — grid-layout wires
 *            it), by NEW work (busy/attention reclaims the pane), or with the pane
 *            itself (`clearPaneState` on dispose — pane ids are reused, and a flag
 *            that outlived its pane would mark the successor as finished).
 */
/** A non-idle episode must OUTLIVE repaint noise to count as finished work. Real
 *  shells emit short output bursts with no work behind them — prompt repaints on
 *  reveal/resize, xterm auto-replies (CPR/DA/focus) — and each one is a busy→idle
 *  round of exactly burst + the tracker's 1.5s quiet window ≈ 1.6s. Without this
 *  floor, every workspace switch would stamp every pane "finished". 2.5s clears
 *  the noise band with margin; genuinely quick commands (an instant `ls`) fall
 *  under it by design — there is nothing to come back for. An ADOPTED episode is timed
 *  from the pane's MOUNT rather than from the event we happened to hear (adoptPaneState)
 *  — the floor itself never bends. */
const MIN_WORK_MS = 2500

const states = new Map<PaneId, AgentState>()
const finished = new Set<PaneId>()
const episodeStart = new Map<PaneId, number>()
const subscribers = new Set<() => void>()

const notify = (): void => {
  for (const cb of subscribers) cb()
}

export function setPaneState(paneId: PaneId, state: AgentState): void {
  const prev = states.get(paneId) ?? 'idle'
  if (prev === state) return
  states.set(paneId, state)
  if (state === 'idle') {
    // The episode ends. Finished ONLY from the busy edge (see the header): a blocked
    // pane going idle answered/replayed its latch away — it completed nothing.
    const start = episodeStart.get(paneId)
    episodeStart.delete(paneId)
    if (prev === 'busy' && start !== undefined && Date.now() - start >= MIN_WORK_MS) finished.add(paneId)
  } else {
    // The work clock starts when work STARTS: from idle, or from attention→busy (the
    // prompt was answered — what follows is a new working stretch, so a 1.6s repaint
    // blip right after an answer stays under the noise floor instead of inheriting
    // the whole blocked episode's duration).
    if (prev === 'idle' || state === 'busy') episodeStart.set(paneId, Date.now())
    finished.delete(paneId)
  }
  notify()
}

/**
 * Adopt the state of a session the daemon was ALREADY running (the daemon outlives the
 * app — ADR 0006 — so a relaunch inherits its agents mid-task). `since` is when the pane
 * began watching: its mount.
 *
 * The work clock is BACKDATED to it, because an adopted episode did not start when we
 * heard about it. The pane only adopts its session ~1s in (the restore lineup's delay +
 * whenPaneLive), and stamping the episode there timed a task that had been running for
 * MINUTES as if it began at adoption: an agent landing its work inside the next 2.5s
 * failed the floor and got no finished flag at all — no green dot, no rail alert, for the
 * whole job. Backdating gives the episode the time it visibly ran on our watch.
 *
 * Not an exemption, deliberately. The pane's own arrival makes noise — the mount fit
 * resizes the pty, and ConPTY answers a resize by repainting its entire viewport (see
 * terminal-pane's refit note), which reads as output, i.e. BUSY, for the tracker's quiet
 * window — and that burst is still in flight at adoption. Exempting adopted episodes from
 * the floor would stamp "finished working" on every reattached pane at every relaunch,
 * agent idle or not. Timed from mount, that repaint dies inside the noise band exactly as
 * it does everywhere else, while genuine work — still running when the band lapses —
 * keeps its green.
 */
export function adoptPaneState(paneId: PaneId, state: AgentState, since: number): void {
  setPaneState(paneId, state)
  const start = episodeStart.get(paneId)
  if (state === 'busy' && start !== undefined) episodeStart.set(paneId, Math.min(start, since))
}

/** The pane was clicked: its sticky finished (green) dot is dismissed. */
export function acknowledgeFinished(paneId: PaneId): void {
  if (finished.delete(paneId)) notify()
}

export function paneFinished(paneId: PaneId): boolean {
  return finished.has(paneId)
}

export function clearPaneState(paneId: PaneId): void {
  const hadFlag = finished.delete(paneId)
  episodeStart.delete(paneId)
  if (states.delete(paneId) || hadFlag) notify()
}

export function paneState(paneId: PaneId): AgentState {
  return states.get(paneId) ?? 'idle'
}

export function onAttentionChange(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
