import { app, type Session } from 'electron'

/**
 * Session-level policy for the dock's guest partitions (docs/13, ADR 0002). Two
 * things every guest session gets, exactly once:
 *
 *  1. A deny-all permission handler — nothing (camera, mic, geolocation,
 *     notifications, …) is granted to a page in the dock. The app's OWN session is
 *     never touched.
 *  2. A Chrome-honest user agent — the DEFAULT Electron UA carries `Electron/x`
 *     and the app's product token, and real sign-in walls (Google's "this browser
 *     may not be secure") refuse it, so the agent-web profile — the one built for
 *     signing in — could not sign in. We strip ONLY the Electron and product
 *     tokens; the platform and the real Chromium version stay honest. This is not
 *     masquerade beyond "we are the Chromium we are" — no spoofed OS, no invented
 *     version. It does NOT read or import any system-browser session (Branch B
 *     stays parked): the cookies still live only in our own partition.
 */

let cachedUA: string | null = null

/** The default UA minus the Electron + app product tokens — plain Chromium. Cached;
 *  `app.userAgentFallback` is stable for the process. */
export function chromeUserAgent(): string {
  if (cachedUA) return cachedUA
  const appToken = app.getName().replace(/[^a-zA-Z0-9]/g, '')
  cachedUA = app.userAgentFallback
    .replace(/\sElectron\/\S+/i, '')
    .replace(new RegExp(`\\s${appToken}\\/\\S+`, 'i'), '')
    // The product token may also appear verbatim (spaces stripped by Chromium) —
    // catch any leftover token mentioning the app name, then collapse the gap.
    .replace(/\smogginglabs\S*\/\S+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return cachedUA
}

/** Idempotent per session (the caller tracks a WeakSet). Deny-all permissions +
 *  the Chrome-honest UA — both operate on the guest's ACTUAL session, so they are
 *  correct no matter which partition name resolved to it. `onDenied` (optional) fires
 *  with the permission name each time one is refused, so the chrome can surface an
 *  HONEST "blocked: camera" chip instead of a silent nothing (the request still fails
 *  — deny-all stays absolute, we just stop hiding it). */
export function applyGuestSessionPolicy(ses: Session, onDenied?: (permission: string) => void): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    onDenied?.(String(permission))
    callback(false)
  })
  // A second, synchronous gate: permission CHECKS (the non-prompting kind, e.g. a
  // page probing navigator.permissions) also refuse, so nothing slips the async
  // handler above.
  ses.setPermissionCheckHandler(() => false)
  ses.setUserAgent(chromeUserAgent())
}
