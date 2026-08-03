// A rising-edge latch. PURE — no DOM, no state beyond one boolean.
//
// The second time this codebase confused a LEVEL for a TRANSITION. The bridge fired
// `needs-you` by comparing a pane's previous state (and inherited a dead pane's, which is
// PaneStateHistory's story); the settings card auto-opened "the first time attention is
// raised" with nothing recording whether it already had.
//
// Both read the same on the page — `if (attention) …` — and both are wrong in the same
// way: the caller is invoked on every push, so "is raised" fires continuously while
// "has just been raised" fires once. Given how often a poll tick re-delivers an unchanged
// state, the difference is the whole behaviour.
export interface RaiseLatch {
  /** Feed the current level; true only on the transition from low to high. */
  (high: boolean): boolean
}

export function createRaiseLatch(): RaiseLatch {
  let high = false
  return (next: boolean): boolean => {
    const rising = next && !high
    high = next
    return rising
  }
}
