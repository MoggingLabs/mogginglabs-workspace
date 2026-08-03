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

/**
 * The reattached pane's spawn-time agent is GONE — the process-table detector said so.
 * The mark describes "an agent was already living here when we asked"; once that agent
 * exits, a resume launch typed into the pane is a real launch again, not words into a
 * running CLI's stdin. Only this mark is cleared: the shell itself is the same live,
 * spawn-settled process, so the other signals still tell the truth. Without this, the
 * mark held for the pane's whole life (only restart/dispose retire it) and every
 * post-restart resume — the usage-limit failover above all — adopted a phantom session
 * and typed nothing (audit F1).
 */
export function clearPaneReattached(id: number): void {
  reattached.delete(id)
}

/**
 * Retire this pane id's SESSION LIFE — drop every mark so the next shell starts clean.
 *
 * Every signal here describes a SHELL, not an id: "produced output", "settled its spawn",
 * "authenticated past SSH", "was already running when we asked". A pane id outlives its
 * shells — `restart()` respawns a dead pane under the same id, and the daemon's `ensure()`
 * respawns a removed one on reconnect — so a mark that survives into the next life is a
 * statement about a process that no longer exists.
 *
 * Called from BOTH ends of a life: dispose() (the pane is gone) and restart() (a new shell
 * under the same id). It was called only from dispose(), which is why a restarted remote pane
 * read as remote-READY before its new SSH connection had authenticated.
 */
export function retirePaneLife(id: number): void {
  drop(live, id)
  drop(spawnSettled, id)
  drop(remoteReady, id)
  agentReady.get(id)?.(false)
  reattached.delete(id)
  liveAtMs.delete(id)
}

// ── The agent's TUI is up and taking keystrokes ────────────────────────────────
//
// Unlike every signal above, this one is NOT a fact about the shell — a pane can launch
// an agent, exit it, and launch another, and each launch has to wait on its OWN answer.
// So it is a one-shot WAITER rather than a latch: whoever is about to type a launch
// command registers first, and a mark with nobody waiting means nothing. That ordering is
// what makes it re-armable without a generation counter, and it is why a marker emitted
// by something else in the pane (the user's own vim, an earlier agent) cannot dismiss a
// later launch's overlay.
//
// WHAT MARKS IT is measured, not assumed: scripts/measure-agent-readiness.mjs types probe
// tokens into a booting claude every 250ms and reports which ones SURVIVE into its input
// box. Across five runs, alternate-screen entry (`?1049h`) landed at 2.0–2.6s and always
// AFTER the last keystroke claude dropped (1.79–2.36s), while the earlier protocol markers
// this repo also knows — bracketed paste, mouse tracking (1.3–1.8s), cursor-shape query
// (1.4–1.9s) — consistently fired while keystrokes were still being eaten. Alt-screen is
// therefore the only one of them that can honestly mean "the pane accepts input".
//
// The mark is raised on alt-screen AND the first painted frame (terminal-pane.ts scans for
// both). Input-readiness alone would be enough to not LOSE anything, but claude takes the
// screen a beat before it draws, and lifting there hands over a blank terminal for a
// fraction of a second — an intermediate step, which is the one thing the cover exists to
// hide. The AGENTLAUNCH gate asserts the same pair against the real CLI, so the signal
// this port ships on stays proven rather than remembered.

const agentReady = new Map<number, (ready: boolean) => void>()

/**
 * Wait for THIS launch's agent to become usable: true when the TUI takes over, false at
 * `ceilingMs`. The ceiling is a safety net, not a schedule — a real signal always resolves
 * first, and a launch that never signals must still hand the pane back rather than trap it.
 *
 * Registering supersedes any earlier waiter for the pane (resolving it false): one pane has
 * one launch in flight, and the newer one is the truthful subject.
 */
export function whenPaneAgentReady(id: number, ceilingMs: number): Promise<boolean> {
  agentReady.get(id)?.(false)
  return new Promise((resolve) => {
    let settled = false
    const done = (ready: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (agentReady.get(id) === done) agentReady.delete(id)
      resolve(ready)
    }
    const timer = setTimeout(() => done(false), ceilingMs)
    agentReady.set(id, done)
  })
}

/** The pane's stream carried the TUI-takeover marker. No waiter ⇒ nothing to tell. */
export function markPaneAgentReady(id: number): void {
  agentReady.get(id)?.(true)
}

/** True while a launch is waiting on this pane — lets the stream scanner skip the scan
 *  when nobody is listening. */
export function isPaneAgentReadyPending(id: number): boolean {
  return agentReady.has(id)
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
