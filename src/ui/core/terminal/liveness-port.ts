/**
 * Pane liveness (Phase-6/01): a pane is LIVE once its PTY has produced any output.
 * The terminal feature marks it; the agents feature gates lineup launches on it —
 * a write raced into a still-spawning PTY is silently dropped by the daemon, which
 * lost template launches on slow machines (found by the Linux CI sweep). Same
 * decoupling pattern as the other core ports: no feature imports a feature.
 */

const live = new Set<number>()
const waiters = new Map<number, Set<(ready: boolean) => void>>()
const reattached = new Set<number>()
const remoteReady = new Set<number>()
const remoteWaiters = new Map<number, Set<(ready: boolean) => void>>()

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

/** Pane closed for good — drop both marks so a recycled pane id starts clean. */
export function forgetPane(id: number): void {
  const waiting = waiters.get(id)
  const waitingRemote = remoteWaiters.get(id)
  if (waiting) for (const done of waiting) done(false)
  if (waitingRemote) for (const done of waitingRemote) done(false)
  live.delete(id)
  reattached.delete(id)
  waiters.delete(id)
  remoteReady.delete(id)
  remoteWaiters.delete(id)
}

export function markPaneLive(id: number): void {
  if (live.has(id)) return
  live.add(id)
  const w = waiters.get(id)
  if (w) {
    waiters.delete(id)
    for (const fn of w) fn(true)
  }
}

export function isPaneLive(id: number): boolean {
  return live.has(id)
}

/**
 * A remote shell reported cwd after SSH authentication and login initialization —
 * the bootstrap reached the target command past any host-key/password prompt.
 */
export function markPaneRemoteReady(id: number): void {
  if (remoteReady.has(id)) return
  remoteReady.add(id)
  const w = remoteWaiters.get(id)
  if (w) {
    remoteWaiters.delete(id)
    for (const fn of w) fn(true)
  }
}

export function isPaneRemoteReady(id: number): boolean {
  return remoteReady.has(id)
}

/** Auth prompts and SSH banners do not satisfy this waiter. */
export function whenPaneRemoteReady(id: number, timeoutMs?: number): Promise<boolean> {
  if (remoteReady.has(id)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const set = remoteWaiters.get(id) ?? new Set<(ready: boolean) => void>()
    remoteWaiters.set(id, set)
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

/** Resolve true once the pane is live, false after `timeoutMs` (callers proceed
 *  either way — the old fixed-delay behavior is the fallback, never worse). */
export function whenPaneLive(id: number, timeoutMs: number): Promise<boolean> {
  if (live.has(id)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const set = waiters.get(id) ?? new Set<(ready: boolean) => void>()
    waiters.set(id, set)
    let settled = false
    const done = (ready: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      set.delete(done)
      resolve(ready)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    set.add(done)
  })
}
