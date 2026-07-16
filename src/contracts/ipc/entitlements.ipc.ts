/**
 * Entitlements over IPC (ADR 0016). CLAIMS ONLY, like account.ipc.ts: the snapshot
 * carries the plan name, feature flags, effective limits and the grace state — never
 * the entitlement JWT, never a token, never the fetch machinery. The renderer reads
 * this to phrase refusals and paint plan UI; enforcement decisions main-side read the
 * SAME engine through the Entitlements port, so the two can never disagree.
 */

/** Where the honored claims sit relative to the offline-grace law (ADR 0016 §4):
 *  `fresh`  = the signed entitlement is unexpired;
 *  `grace`  = it expired, but we are within the grace window past its last successful
 *             fetch, so the plan is still honored;
 *  `expired`= past the window (or no valid entitlement at all) — the app runs as Free.
 *             Degrading is quiet and the app NEVER bricks. */
export type EntitlementGraceState = 'fresh' | 'grace' | 'expired'

/** WHY a held claim is not being honored — the one honest line the account panel
 *  shows (ADR 0016 §4: degradation is quiet, one sentence, never a nag ladder).
 *  Absent whenever the snapshot simply IS the plan (no claim at all, or honored).
 *  An enum of causes, never free text — nothing here can carry a path or an id. */
export type EntitlementDegradedReason = 'grace_expired' | 'device_mismatch' | 'revoked' | 'tampered'

/** The whole outward shape of "what may this install do". EFFECTIVE values: limits
 *  are already merged over the Free defaults, so a consumer never re-derives tiers. */
export interface EntitlementsSnapshot {
  /** Plan name claim (e.g. 'free' | 'pro'). LOCAL UX ONLY — real teeth are hardware
   *  binding + server-side value (ADR 0016 §5), never this string. */
  plan: string
  /** Feature flags the plan grants (additive to the Free set). */
  features: string[]
  /** Effective numeric limits by name (e.g. maxPanes, maxConnections). */
  limits: Record<string, number>
  graceState: EntitlementGraceState
  /** Set when a held claim is degraded to Free (or the build failed its integrity
   *  self-check), naming the cause. Absent when the snapshot simply IS the plan. */
  reason?: EntitlementDegradedReason
}
