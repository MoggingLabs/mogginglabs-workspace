/**
 * Main-side FAILURE injection for the zero-workspace browser gate (MOGGING_BROWSERZERO).
 *
 * Separate from browser-race-audit-faults.ts on purpose: that file only ever DELAYS and
 * OBSERVES (it proves a late reply can't repaint the wrong workspace). This one makes a
 * write actually fail, which is the only way to test the half of finding 33b that no
 * timing trick can reach — a consent toggle that reported "saved" while main dropped the
 * write on the floor. A gate that cannot produce the failure cannot prove the recovery.
 *
 * Env-gated like every other injector (mutation-audit-faults.ts): armed only under the
 * gate's own env var, so a production build carries a pair of dead branches and nothing
 * that could ever refuse a real user's consent write.
 */

let pendingConsentSetFailures = 0

/** Arm the NEXT `count` browser:consentSet handler calls to fail (the store "drops" the write). */
export function failNextConsentSet(count: number): void {
  if (!process.env.MOGGING_BROWSERZERO) return
  pendingConsentSetFailures = Math.max(0, Math.min(10, Math.floor(count)))
}

/** Consumed inside the consentSet handler: true -> this call must report `{ ok: false }`
 *  and persist NOTHING (the renderer has to revert the checkbox and say so). */
export function consumeConsentSetFailure(): boolean {
  if (!process.env.MOGGING_BROWSERZERO || pendingConsentSetFailures <= 0) return false
  pendingConsentSetFailures--
  return true
}
