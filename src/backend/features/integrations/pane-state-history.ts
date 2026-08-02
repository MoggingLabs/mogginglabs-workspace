// Per-pane state history for the outbound event bridge. PURE — no I/O, no Electron.
//
// The bridge fires `needs-you` on a TRANSITION into attention, so it must remember each
// pane's previous state. It kept that in a Map keyed by pane id — and pane ids are REUSED
// (a split takes the lowest free slot). An entry left behind by a closed pane therefore
// became the "previous state" of whatever opened at that id next: a successor whose very
// first state is `attention` found prev === 'attention', the transition was swallowed, and
// the user's automations never heard about the one pane that opened already needing them.
//
// Same id-reuse rule the daemon states for roles and claims, and the renderer for liveness
// marks — a mark belongs to a session life, not to an id. This is that rule, enforced by a
// type rather than remembered at each call site.
export class PaneStateHistory {
  private readonly last = new Map<number, string>()

  /** Record `state` for `paneId` and answer: is this a transition INTO `into`? */
  enters(paneId: number, state: string, into: string): boolean {
    const prev = this.last.get(paneId)
    this.last.set(paneId, state)
    return state === into && prev !== into
  }

  /** The pane is gone for good. Forget it, so a reused id starts with no history. */
  forget(paneId: number): void {
    this.last.delete(paneId)
  }

  /** Test/diagnostic view. */
  size(): number {
    return this.last.size
  }
}
