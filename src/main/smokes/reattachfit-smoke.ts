// Env-gated REATTACH-SIZE smoke (MOGGING_REATTACHFIT=1) — windowless, the REAL daemon.
//
// Gates the attach-size reconciliation (the "pane renders half its width" root cause):
// the renderer only sends `resize` when xterm's own grid changes, so an existing daemon
// session reattached at new client dims used to keep its OLD pty size forever — the
// agent kept rendering at it. ensure() now resizes the session to the attaching spec
// (the tmux rule: the attaching client's viewport is authoritative).
//
//   A. COLD SPAWN at 84x30 — the in-pane probe prints its own process.stdout.columns,
//      proving the process (not just the daemon's bookkeeping) has the size.
//   B. DETACH, REATTACH at 132x40 — spawned.existing must be true, and the probe must
//      print RESIZED_132: the pty delivered the attach resize INTO the process. This is
//      the end-to-end bite: revert the ensure() reconciliation and no resize ever fires.
//   C. SAME-DIMS RESPAWN repaints ONCE and then stops. PaneSession.resize stays idempotent
//      by dimension for mid-session resizes, but an ATTACH at the session's own grid asks
//      conhost for one full-viewport repaint (repaintForAttach) — the only primitive that
//      realigns a client rebuilt from the ring with conhost's screen. ConPTY: a bounded
//      burst, then a silent window. POSIX: strictly zero (no renderer, nothing to realign).
//   D. DAEMON TRUTH — a fresh client's welcome lists the session at 132x40.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureDaemon, DaemonClient } from '../daemon-client'
import { helperRuntime } from '../node-helper'

const OUT_RESULT = path.join(app.getAppPath(), 'out', 'reattachfit-result.json')
// Re-entry guard (electron-vite dev respawns electron after app.exit): scoped to the
// gate's isolated userData, so a fresh sweep run never inherits a stale sentinel.
const SENTINEL = path.join(process.env.MOGGING_USERDATA || os.tmpdir(), 'reattachfit-ran')

// Prints its size at start and whenever it CHANGES (polling the columns getter — on
// Windows ConPTY node emits no 'resize' event and, observed live, may not refresh the
// getter either; the process-level RESIZED mark is therefore a POSIX-only assertion,
// while Windows still gets the daemon-truth + repaint-bytes assertions below).
// Quoting matches the survive smoke's COUNTER (works under cmd.exe and POSIX sh alike).
const PROBE =
  'node -e "var last=process.stdout.columns;console.log(\'COLS_\'+last);setInterval(function(){var c=process.stdout.columns;if(c!==last){last=c;console.log(\'RESIZED_\'+c)}},200)"'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function writeOut(o: unknown): void {
  try {
    fs.mkdirSync(path.dirname(OUT_RESULT), { recursive: true })
    fs.writeFileSync(OUT_RESULT, JSON.stringify(o, null, 2))
  } catch {
    /* best effort */
  }
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await delay(100)
  }
  return cond()
}

export async function runReattachFitSmoke(): Promise<void> {
  if (fs.existsSync(SENTINEL)) {
    app.exit(0) // respawn re-entry: the verdict is already on disk
    return
  }
  try {
    fs.writeFileSync(SENTINEL, String(Date.now()))
  } catch {
    /* tmpdir fallback may be read-only — the watchdog still bounds a re-run */
  }
  const watchdog = setTimeout(() => {
    writeOut({ pass: false, error: 'smoke timeout' })
    app.exit(1)
  }, 30000)
  const fail = (error: string, extra: Record<string, unknown> = {}): void => {
    clearTimeout(watchdog)
    writeOut({ pass: false, error, ...extra })
    app.exit(1)
  }
  try {
    const ep = await ensureDaemon(path.join(__dirname, 'daemon.js'), helperRuntime())

    // A. cold spawn at 84x30
    let capA = ''
    const clientA = new DaemonClient(ep, {
      onData: (id, d) => {
        if (id === 'rf1') capA += d
      }
    })
    await clientA.connect()
    const spawnedA = await clientA.spawn('rf1', { cols: 84, rows: 30, run: PROBE })
    if (spawnedA.existing) return fail('cold spawn reported existing=true (stale daemon state?)')
    const sawCols = await until(() => capA.includes('COLS_84'), 10000)
    if (!sawCols) return fail('probe never reported its spawn size', { capTail: capA.slice(-200) })
    clientA.dispose()

    // B. reattach at 132x40 — the pty must deliver the resize into the process
    let capB = ''
    const clientB = new DaemonClient(ep, {
      onData: (id, d) => {
        if (id === 'rf1') capB += d
      }
    })
    const welcomeB = await clientB.connect()
    const beforeInfo = welcomeB.find((p) => p.id === 'rf1')
    if (beforeInfo?.cols !== 84) return fail('daemon lost the spawn size', { beforeInfo })
    const replayLen = capB.length // the attach replay landed with connect/spawn
    const spawnedB = await clientB.spawn('rf1', { cols: 132, rows: 40 })
    if (!spawnedB.existing) return fail('reattach reported existing=false (session lost)')

    // The PRIMARY assert — daemon truth: a fresh client's welcome must carry the
    // reconciled size. This is the exact contract ensure() now implements; revert the
    // reconciliation and this stays 84x30.
    await delay(1000)
    const clientC = new DaemonClient(ep, {})
    const welcomeC = await clientC.connect()
    const afterInfo = welcomeC.find((p) => p.id === 'rf1')
    const daemonTruth = afterInfo?.cols === 132 && afterInfo?.rows === 40
    if (!daemonTruth)
      return fail('attach did NOT reconcile the session to the client viewport', { beforeInfo, afterInfo })

    // Process-level bite where the platform can express it: POSIX delivers SIGWINCH, so
    // the probe MUST report the new width there. Windows ConPTY gives node neither the
    // resize event nor (observed) a refreshed getter — the resize's repaint bytes after
    // the replay are recorded as diagnostics instead.
    const posix = process.platform !== 'win32'
    const resized = posix ? await until(() => capB.includes('RESIZED_132'), 10000) : true
    if (!resized) return fail('pty did not deliver the attach resize to the process', { capTail: capB.slice(-200) })

    // C. SAME-DIMS RESPAWN — rescoped, because what this pin was protecting turned out to
    // be two different claims and only one of them was ever true.
    //
    // The original assertion was byte-silence on clientB (a BYSTANDER's standing
    // subscription — clientC does the respawn, and every spawn's own reply legitimately
    // carries the scrollback replay). Its stated reason was that any bytes here "would be
    // ConPTY answering a SPURIOUS forwarded resize", and for a mid-session resize that is
    // exactly right: it splices conhost's screen over whatever the agent is drawing, which
    // is why PaneSession.resize dedupes by dimension and why REFIT_SETTLE_MS exists.
    //
    // But a repaint at ATTACH is not spurious — it is load-bearing. A reattaching client
    // rebuilds its terminal from the ring, which is a byte log and not a screen model, and
    // conhost's full-viewport repaint is the ONLY thing that restates its cursor, viewport
    // and stale rows in absolute coordinates so the two agree (PaneSession.repaintForAttach
    // carries the measured evidence). Under the old pin the one attach that cannot self-heal
    // — measured, equal to the session's grid, so no resize fires — was the one guaranteed
    // to stay misaligned. PROFPERSIST_B read the result: live output landing mid-buffer over
    // phase-A rows that nothing ever erased.
    //
    // So the pin keeps its real intent and drops the part that was collateral: what must
    // stay impossible is an UNBOUNDED or REPEATING repaint — a resize loop, or a burst that
    // never settles. One bounded burst per attach, then silence.
    await delay(500)
    const quietLen = capB.length
    await clientC.spawn('rf1', { cols: 132, rows: 40 })
    await delay(1500)
    const burstBytes = capB.length - quietLen
    // ...and then it must STOP. The probe prints nothing on its own, so every byte in this
    // second window would be a repaint nobody asked for — the loop this pin exists to forbid.
    const afterBurst = capB.length
    await delay(1500)
    const trailingBytes = capB.length - afterBurst
    if (trailingBytes !== 0)
      return fail('same-dims reattach kept repainting after its burst', { burstBytes, trailingBytes })
    if (posix) {
      // No renderer on the far side of a unix pty: nothing addresses rows on the terminal's
      // behalf, so there is no alignment to lose and repaintForAttach returns early. The
      // strict zero is still the truth HERE, and it is what keeps the ConPTY-only gating
      // honest — lose the platform guard and this goes red.
      if (burstBytes !== 0)
        return fail('a POSIX same-dims reattach forwarded a resize (platform guard lost?)', { burstBytes })
    } else {
      // The end-to-end bite for the realignment: revert repaintForAttach and conhost is
      // never asked to restate its screen, so this is 0 and the reattach smear comes back.
      // It read exactly 0 once already, when the method asked for the size conhost already
      // held — ResizePseudoConsole repaints on a real change, so the realignment JIGGLES
      // (grow one row, restore) and this is what proves the jiggle still lands.
      if (burstBytes <= 0)
        return fail('a ConPTY same-dims reattach did NOT realign (no repaint burst)', { burstBytes })
      // Bounded: TWO viewports' worth, generously — the jiggle is two real resizes, so
      // conhost may answer with two repaints (it may also fold them into one flush; the cap
      // admits either). Anything past this is not a repaint, it is a loop that settled.
      const burstCeiling = 2 * 132 * 40 * 4
      if (burstBytes > burstCeiling)
        return fail('the attach repaint burst was not bounded', { burstBytes, burstCeiling })
    }

    clientB.kill('rf1')
    await delay(300)
    clientB.dispose()
    clientC.dispose()
    clearTimeout(watchdog)
    writeOut({
      pass: true,
      beforeCols: beforeInfo?.cols,
      beforeRows: beforeInfo?.rows,
      afterCols: afterInfo?.cols,
      afterRows: afterInfo?.rows,
      probeSawSpawnSize: sawCols,
      posixProbeSawResize: posix ? true : 'n/a (win32 — see repaintBytes)',
      repaintBytesAfterAttach: capB.length - replayLen,
      // The rescoped phase C, in numbers: one bounded realignment burst on ConPTY (0 on
      // POSIX), and nothing at all in the window after it.
      sameDimsBurstBytes: burstBytes,
      sameDimsTrailingBytes: trailingBytes
    })
    app.exit(0)
  } catch (err) {
    fail(String(err))
  }
}
