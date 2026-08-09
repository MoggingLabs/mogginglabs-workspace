import type { PaneId } from '@contracts'

/**
 * The pane's profile-switch OFFER (usage-limit failover + manual switch, Phase-4/04
 * recut). OWNER: the `agents` feature — it decides when a pane is capped, which
 * profile is next, and what accepting means. RENDERER: the `terminal` feature — it
 * owns the pane DOM and paints the blurred overlay (pane-offer.ts, the pane-drop
 * idiom). A port so neither imports the other, same as pane-meta next door.
 *
 * The value carries CALLBACKS, not just ids — command-port precedent (`run()`):
 * renderer-local, never over IPC. Content rules still hold: profile NAMES only,
 * never env values (ADR 0002); nothing here enters telemetry (ADR 0005).
 */
export interface PaneFailoverOffer {
  /** offered = ask the human · switching = a profile switch in flight (no buttons but
   *  dismissable copy) · launching = an agent is starting in this pane, covered until it
   *  can actually be used · failed = the interrupt didn't take; the pane was untouched.
   *
   *  Every state COVERS the pane, and covering means the human cannot type into it
   *  (terminal-pane.ts gates onData on this port). That is the point in all four: a
   *  capped agent has nothing useful to receive, an interrupted one is being killed, and
   *  a booting CLI silently EATS keystrokes until its TUI mounts — measured at ~2s for
   *  claude, which is exactly long enough for a fast user to lose a sentence. */
  state: 'offered' | 'switching' | 'launching' | 'failed'
  /** Why the offer is up ("Work hit its Weekly limit") — composed by the owner,
   *  which NAMES the window that is spent. A bare "hit its usage limit" let a
   *  weekly cap read as a claim about whichever window the user then checked. */
  title: string
  /** The target profile's display name — the button/label text builds on it. For
   *  `launching` it is the agent being started ("Claude"). */
  nextName: string
  /** offered/launching/failed: the line under the title, rendered VERBATIM.
   *  Falls back to the state's own default sentence when absent. */
  message?: string
  /** offered only: the human clicked Continue. */
  onAccept?: () => void
  /** offered/failed: the human declined or acknowledged. `switching` has no
   *  dismiss — the flow settles itself to cleared or failed. */
  onDismiss?: () => void
}

const offers = new Map<PaneId, PaneFailoverOffer>()
const subscribers = new Set<(paneId: PaneId, offer: PaneFailoverOffer | null) => void>()

/** Set (or clear with null) a pane's offer. A newer offer supersedes in place. */
export function setPaneFailoverOffer(paneId: PaneId, offer: PaneFailoverOffer | null): void {
  if (offer) offers.set(paneId, offer)
  else if (!offers.delete(paneId)) return
  for (const cb of subscribers) cb(paneId, offer)
}

export function getPaneFailoverOffer(paneId: PaneId): PaneFailoverOffer | undefined {
  return offers.get(paneId)
}

/** Subscribe to offer changes. Current offers are replayed immediately, so a pane
 *  mounted after the offer was raised still paints it. */
export function onPaneFailoverOffer(cb: (paneId: PaneId, offer: PaneFailoverOffer | null) => void): () => void {
  subscribers.add(cb)
  for (const [id, offer] of offers) cb(id, offer)
  return () => subscribers.delete(cb)
}

/**
 * Resolve once nothing is covering this pane — true if it uncovered (or never was),
 * false at the ceiling.
 *
 * "Not covered" is the same fact the input gate reads, which is what makes this the
 * right question for anything that wants to TYPE into a pane the way a human would.
 * The board's card hand-off is the case in point: it used to type its prompt a fixed
 * beat after the process appeared, which now lands squarely inside a launch cover — the
 * window where the CLI discards what it is sent. Asking the cover instead of guessing at
 * it means the prose arrives when a person could have typed it.
 */
export function whenPaneUncovered(paneId: PaneId, ceilingMs: number): Promise<boolean> {
  if (!offers.has(paneId)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const done = (uncovered: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      subscribers.delete(watch)
      resolve(uncovered)
    }
    const watch = (id: PaneId, offer: PaneFailoverOffer | null): void => {
      if (id === paneId && !offer) done(true)
    }
    const timer = setTimeout(() => done(false), ceilingMs)
    subscribers.add(watch)
  })
}
