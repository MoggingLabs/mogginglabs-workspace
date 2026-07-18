import { createRequire } from 'node:module'

// The daemon must stay WINDOWLESS — including every process it ever spawns.
//
// On Windows the daemon is console-less by construction: daemon-client spawns it
// `detached`, and DETACHED_PROCESS is load-bearing twice over — it keeps a daemon booted
// from inside a pane off that pane's ConPTY console (whose close would take the daemon
// with it), and it skips libuv's kill-on-job-close job object, the only reason the
// daemon outlives the app at all (libuv assigns every NON-detached child to that job,
// and Windows tears the job down, members included, the moment the parent exits —
// measured, not read: an un-detached daemon stand-in died the instant its spawner did,
// no signal, no exit event). The price: DETACHED_PROCESS forfeits the console, and
// CreateProcess documents CREATE_NO_WINDOW as IGNORED next to it — a detached daemon
// cannot own an invisible console either. It has none.
//
// Which arms a trap on every console-subsystem child: spawned from a console-less
// parent without CREATE_NO_WINDOW, Windows allocates it a brand-new VISIBLE console —
// under Win11's default-terminal handoff, a full Windows Terminal window. Our own call
// sites all pass `windowsHide: true` by convention; a dependency's cannot be audited
// into convention. node-pty's ConPTY kill() forks its conpty_console_list_agent — one
// fork per pane kill, no windowsHide (a separate process is mandatory there: a process
// can attach to at most one console) — so closing an N-pane workspace flashed N
// terminal windows across the user's desktop the moment the undo grace lapsed.
//
// So the invariant is enforced at the process boundary, not at call sites: every
// child_process entry point in THIS process forces windowsHide. Wrapping the exported
// entry points is sufficient — exec/execFile/fork hand their OPTIONS down internal
// lexical chains, and node-pty reads `child_process.fork` off the module object at
// call time, so the wrap reaches it without touching vendored bytes and survives
// node-pty upgrades. A hidden-console child keeps working stdio and a real (headless)
// console — nothing about it changes but the window. The KILLFLASH gate holds this
// line: watches a real 16-pane teardown for console-class windows.

type CpFn = (...args: never[]) => unknown

const PATCHED = ['spawn', 'fork', 'exec', 'execFile', 'spawnSync', 'execSync', 'execFileSync'] as const

/** Every wrapped signature is (target[, args][, options][, callback]): merge into the
 *  options bag where one was passed, or put one exactly where it belongs — over an
 *  explicit undefined/null, before a trailing callback, or appended. */
function forceWindowsHide<T extends CpFn>(fn: T): T {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const i = Array.isArray(args[1]) ? 2 : 1
    const at = args[i]
    if (at !== null && at !== undefined && typeof at === 'object') {
      args[i] = { ...at, windowsHide: true }
    } else if (typeof at === 'function') {
      args.splice(i, 0, { windowsHide: true })
    } else {
      args[i] = { windowsHide: true }
    }
    return fn.apply(this, args as never[])
  }
  return wrapped as unknown as T
}

let enforced = false

/** Idempotent; no-op off win32. Call before anything in the daemon can spawn — though
 *  order barely matters: callers (node-pty included) read the entry points off the
 *  live module object at call time. createRequire, not an import, so the wrap lands on
 *  the REAL mutable module exports — a bundler's interop namespace copy would absorb
 *  the assignment and silently protect nothing. */
export function enforceWindowlessChildren(): void {
  if (process.platform !== 'win32' || enforced) return
  enforced = true
  const cp = createRequire(__filename)('node:child_process') as Record<(typeof PATCHED)[number], CpFn>
  for (const name of PATCHED) cp[name] = forceWindowsHide(cp[name])
}
