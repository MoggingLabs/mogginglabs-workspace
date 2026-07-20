// The connect ORCHESTRATION (ADR 0014) — the two-phase sequence that runs the instant
// an OAuth grant lands, lifted out of Electron so it is hermetically testable.
//
// The bug this shape exists to prevent: deriving "connected" from a follow-up probe.
// That held the card on "connecting…" for two extra round trips, demoted a valid grant
// to "error" when the probe merely gated or timed out, and kept the flow "pending" long
// enough for a Cancel to be overwritten by the late probe. Here, connectedness is a
// property of the GRANT and nothing else; the probe only ever DECORATES it (or, in the
// one case where the resource actively refuses the grant, downgrades to `expired`).
//
// src/main/connections.ts wires the REAL effects (setState/vault/http/electron); the
// CONNPURE gate wires recording fakes and asserts the ORDER — that is the whole point of
// the injected-effects seam: the sequence is the fix, so the sequence is what gets bitten.

import { connectionEnrichmentPatch, enrichmentTargetsSameGrant, grantLandedPatch, type Connection } from '@contracts'
import type { ConnectionProbe } from './oauth'

/** What `probeConnection` answers — the two fields the orchestrator reads from it. */
export type ProbeOutcome = { ok: true; probe: ConnectionProbe } | { ok: false; reason: string; unauthorized?: boolean }

/**
 * The effects a landed-grant commit performs, injected so the sequencing is testable away
 * from Electron/http/vault. Every method is a thin do-this; the ORDER the orchestrator
 * calls them in is the behaviour under test.
 */
export interface CommitEffects {
  /** Merge a patch onto the connection's stored state (and push it to the renderer). */
  setState(patch: Partial<Connection>): void
  /** Re-read the connection as it stands NOW — the phase-2 guard's window onto reality. */
  readState(): Connection | null
  /** Register the connection as a bridge server the CLIs can reach. */
  registerServer(): void
  /** Tear down the loopback flow (close the port, clear the timer, drop `pending`). */
  closeFlow(): void
  /** Answer the browser tab the consent came back on. */
  showPage(title: string, body: string): void
  /** Best-effort: whose account this grant is for (OIDC/userinfo), or null. */
  discoverAccount(): Promise<string | null>
  /** Best-effort: initialize + tools/list, for the tool list and a fallback account. */
  probe(): Promise<ProbeOutcome>
  /** The connect stamp source (Date.now in production) — the phase-2 generation token. */
  now(): number
}

/** The facts a landed grant proves about itself — everything phase 1 needs. */
export interface LandedGrant {
  label: string
  scopes?: string[]
  expiresAt?: number
  authServer: string
  userClient: boolean
}

/**
 * Commit a landed OAuth grant as CONNECTED, then enrich.
 *
 * PHASE 1 runs to `closeFlow()` with NO await: the card reads connected, the bridge is
 * registered, and the browser tab is answered before control returns to the event loop —
 * so a Cancel that lands after this is a no-op on a live connection (a landed grant
 * stands). PHASE 2 is best-effort and guarded by the connect stamp, so a disconnect or a
 * fresh connect during the round trips is never clobbered by a stale answer. The ONLY
 * failure that un-connects is an unauthorized resource (the grant itself refused) → expired.
 */
export async function commitLandedGrant(fx: CommitEffects, g: LandedGrant): Promise<void> {
  const stamp = fx.now()
  fx.setState(
    grantLandedPatch({
      scopes: g.scopes,
      expiresAt: g.expiresAt,
      connectedAt: stamp,
      authServer: g.authServer,
      userClient: g.userClient
    })
  )
  fx.registerServer()
  fx.showPage(`Connected to ${g.label}`, 'You can close this tab and go back to MoggingLabs Workspace.')
  fx.closeFlow()

  try {
    const account = await fx.discoverAccount()
    const probe = await fx.probe()
    // The card may have moved on (Disconnect, or a fresh connect) while we were away —
    // a stale answer must not resurrect or overwrite it.
    if (!enrichmentTargetsSameGrant(fx.readState(), stamp)) return
    if (!probe.ok && probe.unauthorized) {
      fx.setState({ state: 'expired', lastError: 'The service did not accept the new sign-in — reconnect it.' })
      return
    }
    fx.setState(
      connectionEnrichmentPatch({
        account: account ?? (probe.ok ? probe.probe.account : undefined),
        serverName: probe.ok ? probe.probe.serverName : undefined,
        toolCount: probe.ok ? probe.probe.toolCount : undefined,
        tools: probe.ok ? probe.probe.tools : undefined
      })
    )
  } catch {
    // Enrichment is decoration on a connection that is ALREADY committed. A thrown
    // discover/probe (a socket reset mid-request) must never become an unhandled
    // rejection — the card stays connected; "Check" re-runs the probe on demand.
  }
}
