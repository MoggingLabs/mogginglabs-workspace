/**
 * Pane liveness (Phase-6/01): a pane is LIVE once its PTY has produced any output.
 * The terminal feature marks it; the agents feature gates lineup launches on it —
 * a write raced into a still-spawning PTY is silently dropped by the daemon, which
 * lost template launches on slow machines (found by the Linux CI sweep). Same
 * decoupling pattern as the other core ports: no feature imports a feature.
 */

const live = new Set<number>()
const waiters = new Map<number, Set<() => void>>()

export function markPaneLive(id: number): void {
  if (live.has(id)) return
  live.add(id)
  const w = waiters.get(id)
  if (w) {
    waiters.delete(id)
    for (const fn of w) fn()
  }
}

export function isPaneLive(id: number): boolean {
  return live.has(id)
}

/** Resolve true once the pane is live, false after `timeoutMs` (callers proceed
 *  either way — the old fixed-delay behavior is the fallback, never worse). */
export function whenPaneLive(id: number, timeoutMs: number): Promise<boolean> {
  if (live.has(id)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const set = waiters.get(id) ?? new Set()
    waiters.set(id, set)
    const timer = setTimeout(() => {
      set.delete(done)
      resolve(false)
    }, timeoutMs)
    const done = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    set.add(done)
  })
}
