/**
 * Pane liveness (Phase-6/01): a pane is LIVE once its PTY has produced any output.
 * The terminal feature marks it; the agents feature gates lineup launches on it —
 * a write raced into a still-spawning PTY is silently dropped by the daemon, which
 * lost template launches on slow machines (found by the Linux CI sweep). Same
 * decoupling pattern as the other core ports: no feature imports a feature.
 *
 * Three one-way signals per pane, each with the same mark/when semantics:
 *  - live:          first PTY output arrived — typed input will not be dropped.
 *  - spawn-settled: the spawn round trip RESOLVED (or failed) — the reattach verdict
 *    (`wasPaneReattached`) exists. Liveness alone cannot stand in for this: a daemon
 *    reattach replays scrollback BEFORE the spawn reply lands, so a pane can be live
 *    while its reattach status is still unknown. The lineup used to paper over that
 *    ordering with a fixed 900ms delay; resume launches now wait on THIS instead.
 *  - remote-ready:  the far-side shell reported cwd past SSH auth (4/05).
 */

interface Signal {
  on: Set<number>
  waiters: Map<number, Set<(ready: boolean) => void>>
}

const makeSignal = (): Signal => ({ on: new Set(), waiters: new Map() })

const live = makeSignal()
const spawnSettled = makeSignal()
const remoteReady = makeSignal()
const reattached = new Set<number>()
/** When each pane went live (performance.now()) — the LAUNCHNOW gate's evidence
 *  that lineup commands land immediately after the first output, never on a timer. */
const liveAtMs = new Map<number, number>()

function mark(signal: Signal, id: number): void {
  if (signal.on.has(id)) return
  signal.on.add(id)
  const w = signal.waiters.get(id)
  if (w) {
    signal.waiters.delete(id)
    for (const fn of w) fn(true)
  }
}

/** Resolve true once the signal is marked, false after `timeoutMs` (callers proceed
 *  either way — the old fixed-delay behavior is the fallback, never worse). */
function when(signal: Signal, id: number, timeoutMs?: number): Promise<boolean> {
  if (signal.on.has(id)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const set = signal.waiters.get(id) ?? new Set<(ready: boolean) => void>()
    signal.waiters.set(id, set)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (ready: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      set.delete(done)
      resolve(ready)
    }
    if (timeoutMs !== undefined) timer = setTimeout(() => done(false), timeoutMs)
    set.add(done)
  })
}

function drop(signal: Signal, id: number): void {
  const waiting = signal.waiters.get(id)
  if (waiting) for (const done of waiting) done(false)
  signal.on.delete(id)
  signal.waiters.delete(id)
}

/**
 * The pane's PTY was ALREADY running when we asked for it — the daemon is detached
 * (ADR 0006) and outlived the app, so it handed us the live session instead of starting
 * a shell. Whatever was in that pane (an agent, mid-conversation) is still in it.
 *
 * The restore path reads this before typing: a launch command written into a reattached
 * pane does not relaunch anything, it lands in the running agent's stdin.
 */
export function markPaneReattached(id: number): void {
  reattached.add(id)
}

export function wasPaneReattached(id: number): boolean {
  return reattached.has(id)
}

/** Pane closed for good — drop every mark so a recycled pane id starts clean. */
export function forgetPane(id: number): void {
  drop(live, id)
  drop(spawnSettled, id)
  drop(remoteReady, id)
  reattached.delete(id)
  liveAtMs.delete(id)
}

export function markPaneLive(id: number): void {
  if (!live.on.has(id)) liveAtMs.set(id, performance.now())
  mark(live, id)
}

export function isPaneLive(id: number): boolean {
  return live.on.has(id)
}

/** performance.now() of the pane's first PTY output, or null before it. Gate evidence. */
export function paneLiveAt(id: number): number | null {
  return liveAtMs.get(id) ?? null
}

/** The spawn invoke settled (reply OR failure) — `wasPaneReattached` is now decided.
 *  Marked by the terminal pane in BOTH spawn outcomes, so a resume lineup can never
 *  hang on a pane whose spawn died. */
export function markPaneSpawnSettled(id: number): void {
  mark(spawnSettled, id)
}

export function isPaneSpawnSettled(id: number): boolean {
  return spawnSettled.on.has(id)
}

/** Resolve true once the spawn settled, false after `timeoutMs` (proceed either way —
 *  matching the pre-existing timeout posture of `whenPaneLive`). */
export function whenPaneSpawnSettled(id: number, timeoutMs: number): Promise<boolean> {
  return when(spawnSettled, id, timeoutMs)
}

/**
 * A remote shell reported cwd after SSH authentication and login initialization —
 * the bootstrap reached the target command past any host-key/password prompt.
 */
export function markPaneRemoteReady(id: number): void {
  mark(remoteReady, id)
}

export function isPaneRemoteReady(id: number): boolean {
  return remoteReady.on.has(id)
}

/** Auth prompts and SSH banners do not satisfy this waiter. */
export function whenPaneRemoteReady(id: number, timeoutMs?: number): Promise<boolean> {
  return when(remoteReady, id, timeoutMs)
}

/** Resolve true once the pane is live, false after `timeoutMs` (callers proceed
 *  either way — the old fixed-delay behavior is the fallback, never worse). */
export function whenPaneLive(id: number, timeoutMs: number): Promise<boolean> {
  return when(live, id, timeoutMs)
}
