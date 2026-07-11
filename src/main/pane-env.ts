// The pane-runtime facts the DAEMON injects into every pane it spawns: WHICH pane this is
// (MOGGING_PANE_ID) and where its daemon lives (MOGGING_DAEMON_ENDPOINT / _BROWSER_ENDPOINT).
// They describe a PANE. The app is never a pane — but a process launched from inside one
// inherits them, and the app hands its whole environment to everything it spawns.
//
// So an app started from a MoggingLabs terminal — the dogfooding loop, `npm run dev` from a
// pane, a gate an agent runs from its own pane — used to tell its children they belonged to
// the HOST app's pane, and pointed them at the HOST's daemon.
//
// That is not cosmetic. `bin/mogging.mjs` prefers MOGGING_DAEMON_ENDPOINT over the
// LOCALAPPDATA-derived path — correctly, because inside a real pane that IS the answer — so
// every `mogging` call a smoke made went to the user's LIVE daemon instead of the isolated one
// the smoke had just spawned. Symptom: pane verbs answer `nopane` against a daemon full of
// someone else's panes, and no CLI-driven gate can pass. The danger is worse than the symptom:
// had a smoke's pane id collided with a real one, `role` / `approve` / `kill` would have
// mutated the USER'S LIVE SESSION. Only the id mismatch (smoke panes 1-3 vs a real 501+) kept
// that theoretical. MOGGING_USERDATA and LOCALAPPDATA isolation do not help — the endpoint var
// outranks both.
//
// Same rule as MOGGING_CHANNEL next door in index.ts, for the same reason: these are DERIVED,
// never trusted up. Scrubbing costs a pane nothing — the daemon re-injects the correct values
// into each pane it spawns (pty-daemon/index.ts + session.ts), which is the only place they
// are ever true.

/** Pane identity the app must never inherit, and must never pass on as its own. */
export const INHERITED_PANE_ENV = ['MOGGING_PANE_ID', 'MOGGING_DAEMON_ENDPOINT', 'MOGGING_BROWSER_ENDPOINT'] as const

/**
 * Delete the inherited pane identity from `env`. Returns the names that were actually present
 * — i.e. "this app was launched from inside a pane" — so a caller can say so out loud.
 * Mutates in place (process.env is the point) and is pure otherwise, so a gate can assert it.
 */
export function scrubInheritedPaneEnv(env: Record<string, string | undefined>): string[] {
  const found: string[] = []
  for (const name of INHERITED_PANE_ENV) {
    if (env[name] !== undefined) {
      found.push(name)
      delete env[name]
    }
  }
  return found
}
