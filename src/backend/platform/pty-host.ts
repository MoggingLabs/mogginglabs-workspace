import { release } from 'node:os'
import type * as PtyTypes from 'node-pty'
import type { PtyEmulation } from '@contracts'
import { requireNative } from './native-require'

// Value-required through the host-aware seam (ADR 0017): under the standalone helper the
// binary comes from the helper's own node_modules; under Electron, from the app's. The
// type namespace above is import-type only — types spawn nothing (check-pty-seam.mjs).
const pty = requireNative<typeof import('node-pty')>('node-pty')

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

export type PtySpawnOptions = Omit<PtyTypes.IPtyForkOptions, 'useConpty'> & { cols: number; rows: number }

/**
 * Spawn a pty and report, in the same breath, how it behaves. `useConpty` is passed explicitly:
 * we decide, node-pty does not. The returned `emulation` therefore DESCRIBES this process rather
 * than predicting it.
 */
export function spawnPty(
  file: string,
  args: string[] | string,
  opts: PtySpawnOptions
): { proc: PtyTypes.IPty; emulation: PtyEmulation } {
  assertPtyHostSupported()
  const proc = pty.spawn(file, args, {
    ...opts,
    // Windows only; node-pty ignores it elsewhere. Explicit = we own the decision.
    //
    // useConptyDll loads the BUNDLED ConPTY (Windows Terminal's rewritten backend —
    // conpty.dll + OpenConsole.exe) instead of the OS's kernel32 ConPTY v1. The pair is
    // PINNED to the newest Microsoft release, not to what stable node-pty happens to
    // repackage: build-node-helper.mjs CONPTY_PIN vendors it (build/conpty/<version>/)
    // and overlays it over every staged tree; check-conpty-pin.mjs byte-compares so a
    // silent npm restage of the older pair fails the sweep. This is the fix for width-resize DATA LOSS: v1's
    // buffer is viewport-sized, so a shrink that re-wraps long lines overflows it,
    // conhost discards the overflow, and its repaint erases those rows in xterm too (the
    // "blank band mid-pane" report). v2 removed that machinery — "we simply don't need
    // to do anything during a reflow anymore" — and the CONPTY gate's width phase
    // measures the difference: lost 18-27 of 120 wrapped markers on v1, lost 0 on v2.
    // Same road VS Code ships (terminal.integrated.windowsUseConptyDll). The env var is
    // the kill switch if a machine misbehaves — set MOGGING_CONPTY_V1=1 to fall back;
    // the width gate's bounded-band contract still passes on v1, so both paths stay
    // sweepable.
    //
    // KNOWN v2 RESIDUAL (characterized 2026-08-01 by screenshot matrix; upstream class:
    // microsoft/terminal#15976 "ConPTY buffer gets out-of-sync"): CONSOLE-API output
    // (cmd's dir, its prompt echo) typed AFTER a narrow-width crossing can paint at
    // OFFSET rows over preserved history — conhost pads console rows to buffer width,
    // so v2's internal rewrap counts padded width while every VT terminal wraps content
    // width, and their cursor-row accounting drifts. Proven independent of xterm config
    // (identical with reflow on, off, and no windowsPty). VT-native apps (claude, any
    // TUI) re-paint their own frames and self-heal — the agent path stays clean. v1 does
    // not have this drift because its destructive repaint ERASES the history the drift
    // would land on; we chose data preservation. Do not chase this as a renderer bug.
    ...(process.platform === 'win32'
      ? { useConpty: true, useConptyDll: process.env.MOGGING_CONPTY_V1 !== '1' }
      : {})
  })
  return { proc, emulation: ptyEmulation() }
}

export type { IPty } from 'node-pty'
