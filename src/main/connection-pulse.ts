import type { BrowserWindow } from 'electron'
import { reportCliDrift, sweepConnections } from './connections'
import { mgrApply, scanCliDrift } from './mcp-manager'

// Trigger 1 of the status engine (phase-tools/03): the heartbeat. Every ~15 minutes,
// one budgeted, staggered beat re-verifies every `connected` connection — so
// "verified Xm ago" keeps being a sentence about THIS quarter-hour, not about the
// day the user clicked Connect (the validate-once-then-trust weakness the OSS
// survey names in Activepieces; continuous re-verify is OUR differentiator).
//
// Boot discipline (I7): armed strictly AFTER first paint, async, and the first beat
// waits a full interval — a fresh boot owes the user pixels, not probes. A beat the
// budget cuts short resumes at its cursor next beat; a beat that finds the machine
// offline stops immediately and flips nothing (the reachability law). A due token
// refresh inside a beat rides step 02's coordinator — lock + margin + cooldown —
// because the probe path goes through accessTokenFor like every other caller.

const num = (v: string | undefined): number | null => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

let started = false
let paused = false

/** TEST-ONLY (the TOOLPULSE gate): hold the background heartbeat still so the gate's
 *  direct sweep calls measure THEIR OWN concurrency, not an overlap with a beat. */
export function pauseConnectionPulseForSmoke(hold: boolean): void {
  paused = hold
}

export function startConnectionPulse(getWin: () => BrowserWindow | null): void {
  if (started) return
  started = true
  // The accelerated knob exists for the TOOLPULSE gate; production is ~15 min.
  const intervalMs = num(process.env.MOGGING_PULSE_INTERVAL_MS) ?? 15 * 60_000
  let cursor = 0
  let beating = false
  const beat = async (): Promise<void> => {
    if (beating || paused) return // a straggling beat is never stacked on
    beating = true
    try {
      const report = await sweepConnections('heartbeat', { cursor })
      cursor = report.nextCursor
      // The silent reconciler's beat half (phase-tools/06): a CHEAP config
      // stat/parse — no subprocess — classifying Claude Code drift; background
      // drift rides the same attention path as a failed verify. NO WRITE, EVER:
      // Fix is always a click. (`MOGGING_FIX_BREAK_CLICKGUARD` is TEST-ONLY, the
      // TOOLFIX mutation-red — an auto-applying reconciler is exactly the
      // regression the gate's mtime assert must catch.)
      const drifted = scanCliDrift()
      if (process.env.MOGGING_FIX_BREAK_CLICKGUARD) {
        for (const d of drifted) mgrApply(d.id, 'claude-code')
      }
      reportCliDrift(drifted.map((d) => d.id))
    } catch {
      /* a beat may fail whole (store not ready); the next tick tries again */
    } finally {
      beating = false
    }
  }
  const arm = (): void => {
    setInterval(() => void beat(), intervalMs)
  }
  const win = getWin()
  if (win && !win.isDestroyed() && win.webContents.isLoading()) win.webContents.once('did-finish-load', arm)
  else arm()
}
