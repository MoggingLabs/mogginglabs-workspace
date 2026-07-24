/**
 * Main-side FAILURE injection for the update-prefs write (MOGGING_UPDATEFAIL).
 *
 * The `update:prefsSet` handler persists through `getSettingsStore()?.setSetting()`, which
 * fails silently two ways no timing trick can reach: a null store (open failed — the app
 * boots anyway, PERSISTHEALTH proves it) drops the write on the optional chain, and
 * `setSetting` can throw (SQLITE_FULL / READONLY). The handler used to return nothing and the
 * renderer fired-and-forgot, so the toggle showed a value that was never persisted and next
 * launch silently reverted it — installing on quit from under the user. A gate that cannot
 * produce the failure cannot prove the recovery.
 *
 * Env-gated like every other injector (browserzero-audit-faults.ts, mutation-audit-faults.ts):
 * armed only under the gate's own env var, so a production build carries a pair of dead
 * branches and nothing that could ever refuse a real user's update-prefs write.
 */

let pendingPrefsSetFailures = 0

/** Arm the NEXT `count` update:prefsSet handler calls to fail (the store "drops" the write). */
export function failNextUpdatePrefsSet(count: number): void {
  if (!process.env.MOGGING_UPDATEFAIL) return
  pendingPrefsSetFailures = Math.max(0, Math.min(10, Math.floor(count)))
}

/** Consumed inside the prefsSet handler: true -> this call must report `{ ok: false }` and
 *  persist NOTHING (the renderer reverts the toggle and says so). */
export function consumeUpdatePrefsSetFailure(): boolean {
  if (!process.env.MOGGING_UPDATEFAIL || pendingPrefsSetFailures <= 0) return false
  pendingPrefsSetFailures--
  return true
}
