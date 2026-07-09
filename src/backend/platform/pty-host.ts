import { release } from 'node:os'
import * as pty from 'node-pty'
import type { PtyEmulation } from '@contracts'

// THE ONLY MODULE THAT MAY SPAWN A PTY. Enforced by scripts/check-pty-seam.mjs.
//
// WHY A CHOKEPOINT AND NOT A SHARED HELPER. A pty's emulation semantics (does growing the
// viewport pull scrollback down, or append empty rows at the bottom?) must be known by xterm,
// which lives on the other side of an IPC boundary. Before this module the fact was INFERRED
// three times: node-pty picked its backend implicitly (`useConpty ??= build >= 18309`), twice —
// once per spawn site — and the renderer hardcoded `backend: 'conpty'` and hoped. Three
// inferences of one fact. When they disagree by a single row, ConPTY's repaint-on-resize writes
// conhost's stale rows into the middle of a live agent frame: the "text going crazy" bug.
//
// A helper two call sites remember to call would not have fixed that — it is the same convention
// that failed. So: `spawnPty` is the only door, and it returns the emulation ALONGSIDE the pty,
// out of the same expression that configured it. The descriptor cannot be absent, stale, or
// disagree with the process it describes, because there is no way to make one without the other.
//
// WHY CONPTY IS A CONSTANT, NOT DATA. node-pty falls back to winpty below build 18309. We pass
// `useConpty: true` explicitly and refuse to run below that build (assertPtyHostSupported), so
// this app has exactly one Windows backend. A backend that cannot vary cannot disagree — the
// winpty resize path, which nothing here ever tested, does not exist. `buildNumber` still travels
// because xterm needs it for a DIFFERENT threshold: reflow is only correct at >= 21376.

/** node-pty uses ConPTY at or above this build, winpty below it. We require ConPTY. */
export const CONPTY_MIN_BUILD = 18309

/** `os.release()` is "10.0.26200" on Windows — the third field is the build. 0 if unparsable. */
export function windowsBuild(): number {
  if (process.platform !== 'win32') return 0
  const build = Number(release().split('.')[2])
  return Number.isFinite(build) ? build : 0
}

/**
 * Windows below 18309 would silently get a winpty. Refuse instead: the UI models ConPTY, and a
 * pty whose semantics the UI does not model is a smeared frame, not a working terminal.
 * Throws — main turns this into a fatal at boot (src/main/fatal.ts).
 */
export function assertPtyHostSupported(): void {
  if (process.platform !== 'win32') return
  const build = windowsBuild()
  if (build >= CONPTY_MIN_BUILD) return
  throw new Error(
    `Unsupported Windows build ${build || '(unknown)'}: MoggingLabs Workspace requires ` +
      `${CONPTY_MIN_BUILD}+ (Windows 10 1903) for ConPTY. Older builds fall back to winpty, ` +
      `whose resize semantics this app does not implement.`
  )
}

/** How the pty this process spawns behaves. Constant per host, carried per pane (see PtyEmulation). */
export function ptyEmulation(): PtyEmulation {
  return process.platform === 'win32' ? { backend: 'conpty', buildNumber: windowsBuild() } : { backend: 'posix' }
}

export type PtySpawnOptions = Omit<pty.IPtyForkOptions, 'useConpty'> & { cols: number; rows: number }

/**
 * Spawn a pty and report, in the same breath, how it behaves. `useConpty` is passed explicitly:
 * we decide, node-pty does not. The returned `emulation` therefore DESCRIBES this process rather
 * than predicting it.
 */
export function spawnPty(
  file: string,
  args: string[] | string,
  opts: PtySpawnOptions
): { proc: pty.IPty; emulation: PtyEmulation } {
  assertPtyHostSupported()
  const proc = pty.spawn(file, args, {
    ...opts,
    // Windows only; node-pty ignores it elsewhere. Explicit = we own the decision.
    ...(process.platform === 'win32' ? { useConpty: true } : {})
  })
  return { proc, emulation: ptyEmulation() }
}

export type { IPty } from 'node-pty'
