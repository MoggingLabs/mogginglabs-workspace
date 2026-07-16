import type { EntitlementDegradedReason, EntitlementGraceState, EntitlementsSnapshot } from '../ipc/entitlements.ipc'

// The Entitlements port (ADR 0016, phase-accounts/05). Gated features depend on THIS
// interface — never on the entitlement JWT, the vault cache, the issuer, or any
// vendor. The concrete engine is constructed only at the composition root
// (src/main/entitlements.ts) and injected through the backend holder
// (src/backend/core/entitlements.ts), exactly like the Telemetry port.
//
// The honesty stance, restated where the checks live: local gates are UX, not
// security (ADR 0016 §5). A cracked build can flip any local boolean; the port
// exists so refusals are consistent, visible, and phrased once — not to pretend a
// process can police itself. Real teeth are hardware binding + server-side value.

/** The claims inside a verified entitlement JWT. Verified LOCALLY (Ed25519, pinned
 *  public key) before anything reads them; a tampered or wrong-signature token is
 *  treated as ABSENT, never trusted. */
export interface EntitlementClaims {
  plan: string
  features: string[]
  limits: Record<string, number>
  /** Which device this entitlement was issued to: the RFC 7638 thumbprint of the
   *  machine's device key (hardware binding, step 06). ENFORCED — the engine honors a
   *  claim only when this matches the local key; see the device-mismatch fixture. */
  deviceId: string
  /** Epoch seconds, standard JWT semantics. TTL is short (24–72h). */
  iat: number
  exp: number
  /** The account this activation was issued to — a stable opaque handle (the IdP
   *  `sub`), the subject of the forensic watermark (phase-accounts/07). ID ONLY, never a
   *  credential (invariant I6). Absent on pre-07 / anonymous claims. */
  accountId?: string
  /** The forensic activation watermark carriers the issuer bound into this claim, so a
   *  leaked activation record attributes back to `accountId`
   *  (src/backend/features/account/watermark.ts). Signed-in-place: the JWT signature is
   *  the anti-forgery. */
  watermark?: EntitlementWatermark
  /** Server-side revocation (phase-accounts/07 §revocation). A validly-signed claim the
   *  issuer marks `revoked` is honored AS revoked — the engine degrades it to Free on the
   *  next refresh. No remote detonation: a running app is never killed, it degrades. */
  revoked?: boolean
}

/** The watermark carriers riding inside a signed entitlement claim (mirrors
 *  WatermarkCarriers in src/backend/features/account/watermark.ts — kept here so the
 *  claim shape is fully typed without a backend import). */
export interface EntitlementWatermark {
  /** Primary carrier: a recoverable, checksummed encoding of the account id. */
  wm: string
  /** Redundant carrier: a permutation of a benign token vocabulary whose ORDER encodes a
   *  fingerprint of the account id. */
  wmk: string[]
}

/** The capability a gated feature consumes. Answers are EFFECTIVE (already merged
 *  over the Free defaults) and total: they never throw, and with no account, no
 *  network, or an expired grace they answer as Free — the app never bricks. */
export interface Entitlements {
  /** Does the current plan include this feature flag? */
  allows(feature: string): boolean
  /** The numeric limit by name (e.g. 'maxPanes'). Unknown names fail OPEN
   *  (Infinity): a missing config row must never break a shipped feature. */
  limit(name: string): number
  /** The claims-only projection the IPC snapshot mirrors. */
  snapshot(): EntitlementsSnapshot
}

// ── The tier CONFIG TABLE (mechanism vs policy) ─────────────────────────────────────
// WHICH tier gets what is data here, not hard-coded at gate points. Gate points ask
// `limit('maxPanes')`; paid tiers arrive as limits{} inside the SIGNED claim; this
// table is the Free baseline every answer merges over. The Free row is deliberately
// GENEROUS: the free local core stays fully usable (ADR 0016 §2) and today's numbers
// change nothing — maxPanes matches the WebGL budget cap the layout already enforces.

/** Limit names the first gate points read. A name, not an enum — new gates add rows,
 *  not types. */
export const ENTITLEMENT_LIMIT_NAMES = ['maxPanes', 'maxConnections', 'maxSwarmRoles', 'maxRemotes'] as const

/** The Free baseline: what an install with NO valid entitlement may do. */
export const FREE_ENTITLEMENTS: Readonly<{ plan: string; features: readonly string[]; limits: Readonly<Record<string, number>> }> =
  Object.freeze({
    plan: 'free',
    features: Object.freeze([]) as readonly string[],
    limits: Object.freeze({
      /** Panes per workspace — the existing 16-pane WebGL budget; Free keeps all of it. */
      maxPanes: 16,
      /** App-held service connections (ADR 0014 cards). */
      maxConnections: 25,
      /** Panes that may hold a swarm role at once. */
      maxSwarmRoles: 16,
      /** Saved SSH remote hosts. */
      maxRemotes: 10
    })
  })

/** The Free snapshot — the shape every consumer degrades to. `reason` names WHY a
 *  held claim is not honored (claims-only enum); absent when there is nothing held. */
export const freeSnapshot = (graceState: EntitlementGraceState = 'expired', reason?: EntitlementDegradedReason): EntitlementsSnapshot => ({
  plan: FREE_ENTITLEMENTS.plan,
  features: [...FREE_ENTITLEMENTS.features],
  limits: { ...FREE_ENTITLEMENTS.limits },
  graceState,
  ...(reason ? { reason } : {})
})
