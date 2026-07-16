import { FREE_ENTITLEMENTS, freeSnapshot, type Entitlements } from '@contracts'

// The Entitlements port holder — the telemetry pattern (core/telemetry), applied to
// plan gating. A process-wide singleton defaulting to the FREE baseline: with no
// engine installed (production before login, every test, a torn-down smoke) each
// answer is the generous Free tier, so nothing gated can crash or brick. The app
// composition root (src/main/entitlements.ts) installs the real engine; features
// import getEntitlements() and never see a token, a JWT, or the issuer.

class FreeEntitlements implements Entitlements {
  allows(feature: string): boolean {
    return FREE_ENTITLEMENTS.features.includes(feature)
  }

  limit(name: string): number {
    // Unknown names fail OPEN: a gate point naming a row the table lacks must never
    // break a shipped feature (the config table is UX policy, not security).
    return FREE_ENTITLEMENTS.limits[name] ?? Number.POSITIVE_INFINITY
  }

  snapshot(): ReturnType<Entitlements['snapshot']> {
    return freeSnapshot()
  }
}

let current: Entitlements = new FreeEntitlements()

export function setEntitlements(entitlements: Entitlements): void {
  current = entitlements
}

export function getEntitlements(): Entitlements {
  return current
}

export { FreeEntitlements }
export type { Entitlements } from '@contracts'
