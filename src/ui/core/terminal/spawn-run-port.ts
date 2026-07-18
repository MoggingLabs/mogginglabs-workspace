/**
 * Spawn-run launch delivery (the instant-launch mechanism, part 2). For a FRESH
 * template/wizard workspace, the launch command is handed to the pane's SPAWN
 * (SpawnRequest.run → the daemon's SpawnSpec.run) so the backend types it as the
 * shell's first act — no idle-prompt window, no renderer-typed command to watch land.
 *
 * The port is the decoupling seam between three parties that must not import each
 * other (same rule as the other core ports):
 *  - the `workspace` controller emits launch requests BEFORE the grid is built
 *    (panes spawn synchronously inside create(), so arming has to precede it);
 *  - the `agents` feature ARMS a pane's command build here (a promise — the build is
 *    a main round trip) and later needs the delivery VERDICT to decide between
 *    bookkeeping-only (delivered at spawn) and the typed fallback (write on live);
 *  - the `terminal` pane CLAIMS the armed build at spawn time, waits for it briefly,
 *    spawns with (or, on timeout/failure, without) the run line, and REPORTS what
 *    actually happened.
 *
 * Every path reports: delivered, fallback-needed, or — when the pane never claims
 * (disposed mid-open, layout mismatch) — the agents feature's bounded wait answers
 * null and it falls back to the typed path, whose own liveness timeout keeps the
 * old behavior as the floor. Nothing here can lose a launch; the worst outcome is
 * the pre-spawn-run behavior (typed on live).
 */

const armed = new Map<number, Promise<string | null>>()
const outcomes = new Map<number, boolean>()
const waiters = new Map<number, Set<(delivered: boolean | null) => void>>()

/** Arm a pane's launch command build. Must run BEFORE the pane constructs (the
 *  controller emits spawn-deliver requests pre-create; the agents feature arms
 *  synchronously inside the port callback). Resolves to null when the build failed. */
export function armSpawnRun(paneId: number, build: Promise<string | null>): void {
  armed.set(paneId, build)
}

/** One-shot claim by the spawning pane. Null = nothing armed (normal pane). */
export function claimSpawnRun(paneId: number): Promise<string | null> | null {
  const build = armed.get(paneId) ?? null
  armed.delete(paneId)
  return build
}

/** The pane's report: did the spawn actually carry the run line into a FRESH session?
 *  False on build-timeout, spawn failure, or a reattached session (run ignored there). */
export function reportSpawnRunOutcome(paneId: number, delivered: boolean): void {
  outcomes.set(paneId, delivered)
  const w = waiters.get(paneId)
  if (w) {
    waiters.delete(paneId)
    for (const fn of w) fn(delivered)
  }
}

/** Resolve with the pane's report, or null after `timeoutMs` (no pane ever claimed —
 *  the caller falls back to typed delivery, which fails as gracefully as it always has). */
export function whenSpawnRunOutcome(paneId: number, timeoutMs: number): Promise<boolean | null> {
  const known = outcomes.get(paneId)
  if (known !== undefined) return Promise.resolve(known)
  return new Promise((resolve) => {
    const set = waiters.get(paneId) ?? new Set<(delivered: boolean | null) => void>()
    waiters.set(paneId, set)
    let settled = false
    const done = (delivered: boolean | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      set.delete(done)
      resolve(delivered)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    set.add(done)
  })
}

/** Pane closed for good — a recycled pane id must start with no armed build, no stale
 *  outcome, and no waiter still hoping (they resolve null → the typed-fallback floor). */
export function forgetSpawnRun(paneId: number): void {
  armed.delete(paneId)
  outcomes.delete(paneId)
  const w = waiters.get(paneId)
  if (w) {
    waiters.delete(paneId)
    for (const fn of w) fn(null)
  }
}
