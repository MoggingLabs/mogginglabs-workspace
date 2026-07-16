import { EntitlementsChannels, FREE_ENTITLEMENTS, freeSnapshot, type EntitlementsSnapshot } from '@contracts'
import { getBridge } from '../ipc/bridge'

// The renderer's read-only mirror of the Entitlements snapshot (phase-accounts/05).
// CLAIMS ONLY — plan, features, effective limits, graceState — pulled once on first
// use and kept live by the `entitlements:changed` push. Until (or unless) the pull
// lands, every answer is the generous Free baseline, which is exactly what an
// account-less install is entitled to — so no gate here can ever block harder than
// main would, and nothing waits on IPC to paint.
//
// Renderer gate points (pane cap, swarm roles) read THIS to decide and to phrase the
// visible upgrade reason; main-side handlers enforce the same engine through the
// port, so the two can never disagree about the numbers.

let snap: EntitlementsSnapshot = freeSnapshot()
let started = false

function isSnapshot(p: unknown): p is EntitlementsSnapshot {
  const s = p as EntitlementsSnapshot | null
  return !!s && typeof s === 'object' && typeof s.plan === 'string' && Array.isArray(s.features) && !!s.limits && typeof s.limits === 'object'
}

function ensureStarted(): void {
  if (started) return
  started = true
  try {
    const bridge = getBridge()
    // App-lifetime subscription — the unsubscriber is deliberately unused (bridge.ts).
    bridge.on(EntitlementsChannels.changed, (payload) => {
      if (isSnapshot(payload)) snap = payload
    })
    void bridge
      .invoke(EntitlementsChannels.snapshot)
      .then((payload) => {
        if (isSnapshot(payload)) snap = payload
      })
      .catch(() => undefined) // no bridge answer = Free defaults stand
  } catch {
    /* non-Electron host (tests): Free defaults stand */
  }
}

/** The effective numeric limit by name. Unknown names fail OPEN (Infinity) — a gate
 *  must never break a feature over a missing config row. */
export function entitlementLimit(name: string): number {
  ensureStarted()
  return snap.limits[name] ?? FREE_ENTITLEMENTS.limits[name] ?? Number.POSITIVE_INFINITY
}

/** The plan name, for phrasing refusals ("Your free plan…"). */
export function entitlementPlan(): string {
  ensureStarted()
  return snap.plan
}

/** The whole claims-only snapshot (Settings copy, future plan UI). */
export function entitlementsSnapshot(): EntitlementsSnapshot {
  ensureStarted()
  return { ...snap, features: [...snap.features], limits: { ...snap.limits } }
}
