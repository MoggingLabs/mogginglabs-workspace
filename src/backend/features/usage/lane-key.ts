import type { UsageWindow } from '@contracts'

// The ONE place a lane's persistence identity is decided.
//
// Everything that survives a restart — the alert engine's single-fire latch,
// the history ring — used to key off the window's DISPLAY LABEL. Labels are
// provider-controlled prose: Anthropic renamed the model-scoped weekly twice
// (`seven_day_opus` -> `seven_day_fable`), and each rename made the stored
// lane unreachable. An unreachable lane reads as a lane with no history, which
// crosses every threshold at once, which at 100% is `capped` — a pane-covering
// offer with a failover suggestion, on a lane that never descended.
//
// So: identity is the provider's own key, and the label is prose again.

/** A display label -> a stable key slug ('Session (5h)' -> 'session-5h').
 *  Kept for adapters that mint no id of their own, and for the history ring's
 *  key shape. Deterministic, lossy on purpose, and never reversed. */
export const slugLabel = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** A lane's identity: the adapter's key when it has one, else a slug of the
 *  label. Total — every window has an identity, so no caller needs a fallback
 *  branch, and no caller may invent its own (that is how two identities for
 *  one lane happen). The seam backfills `id` from this, so by the time a window
 *  leaves the backend `w.id` is always set and `laneKey(w) === w.id`. */
export const laneKey = (w: Pick<UsageWindow, 'id' | 'label'>): string => w.id ?? slugLabel(w.label)
