// Env-gated RESTORE-DIMS smoke (MOGGING_RESTOREDIMS=1) — windowless, the REAL daemon,
// three daemon GENERATIONS over one session store.
//
// Gates THE DIMS INVARIANT (the smeared-restore root cause): grid dimensions flow one
// way — from a real client measurement to the pty — and a typed launch never lands in a
// pty whose size no client has measured. An agent CLI reads its width ONCE at boot and
// draws its TUI at it; the correcting resize then lands mid-frame, and ConPTY answers
// every resize with a stale full-viewport repaint spliced over the live TUI.
//
//   A. COLD SPAWN at 44x11 with run 'claude' (PATH is stripped for the whole smoke, so
//      the typed command ECHOES and resolves to nothing — never a real agent), then a
//      graceful shutdown persists command='claude' + the 44x11 grid.
//   B. COLD-START RESTORE — the contract points, in order:
//        1. the restored session lists 44x11, not the 80x24 spawn default;
//        2. its LAUNCH INTENT rides the welcome (PaneInfo.launch) and the daemon types
//           NOTHING into the restored pane — the resume is composed by MAIN off that
//           intent (a daemon-typed resume matched 0 of 34 real panes and suppressed
//           the app's richer relaunch; see session.ts's spawn path);
//        3. a spawn WITHOUT dims (an unmeasured hidden pane) neither resizes nor
//           confirms the session — absent dims mean "leave it alone";
//        4. a spawn WITH measured dims equal to the session's applies nothing but
//           CONFIRMS the size, and the reply READS BACK the grid the session holds
//           (spawned cols/rows) — still with nothing daemon-typed;
//        5. the replay GROUNDS terminal modes after its history (RESTORE_MODE_RESET) —
//           a dead TUI's alt-screen/mouse/paste modes never leak into the fresh shell;
//        6. a STALE-generation resize is REFUSED and the true generation's applies
//           (protocol `gen`, additive — the reused-pane-id smear guard);
//        7. replay disposition: 'suppress' delivers no ring bytes (the reconnect
//           double-paint fix), 'reset' delivers the full-reset prefix plus the ring.
//   C. HEADLESS RESTORE — a fresh cold start where NO client ever sends dims: even
//      past LAUNCH_DIMS_GRACE_MS the daemon still types nothing (the grace releases
//      DEFERRED SPAWN-RUN launches, never a composed resume); the intent stays on the
//      welcome for whichever app connects next.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureDaemon, DaemonClient } from '../daemon-client'
import { helperRuntime } from '../node-helper'
import { isAlive } from '@backend/platform/pid'

const OUT_RESULT = path.join(app.getAppPath(), 'out', 'restoredims-result.json')
// Re-entry guard (electron-vite dev respawns electron after app.exit): scoped to the
// gate's isolated userData, so a fresh sweep run never inherits a stale sentinel.
const SENTINEL = path.join(process.env.MOGGING_USERDATA || os.tmpdir(), 'restoredims-ran')

const PANE = 'rdim1'
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

/** Graceful daemon stop + wait for the pid to actually die (persistNow ran, endpoint
 *  cleared) — the next ensureDaemon must spawn a genuinely FRESH generation. */
async function retire(client: DaemonClient, pid: number): Promise<boolean> {
  client.shutdown()
  const died = await until(() => !isAlive(pid), 8000)
  client.dispose()
  return died
}

export async function runRestoreDimsSmoke(): Promise<void> {
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
  }, 90000)
  const fail = (error: string, extra: Record<string, unknown> = {}): void => {
    clearTimeout(watchdog)
    writeOut({ pass: false, error, ...extra })
    app.exit(1)
  }
  try {
    // Panes inherit the daemon's env, and the daemon inherits ours: with PATH cut to the
    // bare system dirs, the shell itself still works (COMSPEC / absolute $SHELL) but the
    // typed 'claude' / 'claude --resume' resolves to NOTHING — it echoes into scrollback
    // (all this smoke asserts on) instead of launching a real agent on a dev machine.
    process.env.PATH = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin'
    const helper = helperRuntime()
    const daemonJs = path.join(__dirname, 'daemon.js')

    // A. cold spawn at 44x11, run 'claude' — persists the label the restore resumes by.
    process.env.MOGGING_LAUNCH_DIMS_GRACE_MS = '30000' // gen B must not fire by grace mid-check
    const ep1 = await ensureDaemon(daemonJs, helper)
    let capA = ''
    const clientA = new DaemonClient(ep1, {
      onData: (id, d) => {
        if (id === PANE) capA += d
      }
    })
    await clientA.connect()
    const spawnedA = await clientA.spawn(PANE, { cols: 44, rows: 11, cwd: '', run: 'claude' })
    if (spawnedA.existing) return fail('cold spawn reported existing=true (stale daemon state?)')
    const echoed = await until(() => capA.includes('claude'), 8000)
    if (!echoed) return fail('run command never echoed', { capTail: capA.slice(-200) })
    if (!(await retire(clientA, ep1.pid))) return fail('gen A daemon did not die on shutdown')

    // B. cold-start restore — the four contract points.
    const ep2 = await ensureDaemon(daemonJs, helper)
    if (ep2.pid === ep1.pid) return fail('gen B is not a fresh daemon')
    let capB = ''
    const clientB = new DaemonClient(ep2, {
      onData: (id, d) => {
        if (id === PANE) capB += d
      }
    })
    const welcomeB = await clientB.connect()
    const restored = welcomeB.find((p) => p.id === PANE)
    const gridRestored = restored?.cols === 44 && restored?.rows === 11
    if (!gridRestored)
      return fail('restore lost the persisted grid (spawned at the default?)', { restored })

    // 2. bare attach (no dims): the daemon must type NOTHING into a restored pane — the
    // resume rides the LAUNCH INTENT on the wire now (PaneInfo.launch; main composes),
    // never daemon-composed bytes. The old contract ("deferred until measured, then the
    // DAEMON types --resume") is retired: a daemon-typed resume suppressed the app's
    // richer relaunch and matched 0 of 34 real panes (see session.ts's spawn path).
    const intentCarried = restored?.launch?.agentId === 'claude'
    if (!intentCarried)
      return fail('restore lost the launch intent the resume now rides', { launch: restored?.launch ?? null })
    clientB.attach(PANE)
    await until(() => capB.length > 0, 5000)
    await delay(1000) // past the window where the pre-intent daemon typed it instantly
    const deferred = !capB.includes('--resume')
    if (!deferred) return fail('the daemon composed a resume into a restored pane')

    // 3. a dims-less spawn (unmeasured pane) must neither resize nor confirm.
    const reNoDims = await clientB.spawn(PANE, { cwd: '' })
    if (!reNoDims.existing) return fail('dims-less respawn lost the session')
    await delay(800)
    const probe = new DaemonClient(ep2, {})
    const welcomeProbe = await probe.connect()
    const afterNoDims = welcomeProbe.find((p) => p.id === PANE)
    probe.dispose()
    const dimlessLeftAlone = afterNoDims?.cols === 44 && afterNoDims?.rows === 11
    if (!dimlessLeftAlone)
      return fail('a dims-less spawn RESIZED the session (invented dims)', { afterNoDims })
    if (capB.includes('--resume')) return fail('a dims-less spawn made the daemon compose a resume')

    // 4. measured dims equal to the session's: applies nothing, confirms — and the reply
    // READS BACK the grid the session actually holds (the spawned cols/rows contract).
    // The daemon still types nothing: the resume is main's job, launched off the intent.
    const reMeasured = await clientB.spawn(PANE, { cols: 44, rows: 11, cwd: '' })
    if (!reMeasured.existing) return fail('measured respawn lost the session')
    if (reMeasured.cols !== 44 || reMeasured.rows !== 11)
      return fail('measured respawn did not read back the confirmed grid', {
        cols: reMeasured.cols ?? null,
        rows: reMeasured.rows ?? null
      })
    await delay(800)
    if (capB.includes('--resume'))
      return fail('the daemon composed a resume after a measured attach', { capTail: capB.slice(-200) })

    // 5. the restored replay GROUNDS terminal modes after its history: the dead process
    // may have held alt-screen/mouse/bracketed-paste; the fresh shell holds none
    // (RESTORE_MODE_RESET rides the ring between history and the shell's first byte).
    // ?1047l, not ?1049l: the reset deliberately leaves alt-screen WITHOUT homing the
    // cursor over the history it follows (pane-shared.ts's RESTORE_MODE_RESET note).
    const modeGrounded = capB.includes('\x1b[?1047l') && capB.includes('\x1b[?2004l')
    if (!modeGrounded) return fail('restored replay carries no mode reset (RESTORE_MODE_RESET missing)')

    // 6. gen-gated resize (protocol `gen`, additive): a STALE generation's resize is
    // refused — pane ids are reused, and ConPTY answers every applied resize with a
    // full repaint, so a stale one smears the successor. The true gen applies.
    const genB = reMeasured.gen
    if (typeof genB !== 'number') return fail('spawn reply carries no gen (SpawnResult.gen missing)')
    clientB.resize(PANE, 90, 22, genB + 7)
    await delay(700)
    const staleProbe = new DaemonClient(ep2, {})
    const staleInfo = (await staleProbe.connect()).find((p) => p.id === PANE)
    staleProbe.dispose()
    const staleRefused = staleInfo?.cols === 44 && staleInfo?.rows === 11
    if (!staleRefused) return fail('a STALE-gen resize was applied', { staleInfo })
    clientB.resize(PANE, 90, 22, genB)
    await delay(700)
    const trueProbe = new DaemonClient(ep2, {})
    const trueInfo = (await trueProbe.connect()).find((p) => p.id === PANE)
    trueProbe.dispose()
    const trueGenApplied = trueInfo?.cols === 90 && trueInfo?.rows === 22
    if (!trueGenApplied) return fail('a TRUE-gen resize was refused', { trueInfo })

    // 6b. BELIEF FOLLOWS THE PTY. transport forwards a client's cols/rows unvalidated, so
    // `cols: 0` reaches PaneSession.resize — where node-pty throws. The session used to
    // record the size BEFORE applying it and swallow that throw, leaving info(), the
    // persisted snapshot and every attachDims comparison describing a grid ConPTY never
    // took; the same-dims dedupe then made it permanent, so a later honest resize to 0x22
    // would have been dropped as a no-op. A refused resize must leave the session's
    // reported size exactly where it was.
    clientB.resize(PANE, 0, 22, genB)
    await delay(700)
    const poisonProbe = new DaemonClient(ep2, {})
    const poisonInfo = (await poisonProbe.connect()).find((p) => p.id === PANE)
    poisonProbe.dispose()
    const beliefHeld = poisonInfo?.cols === 90 && poisonInfo?.rows === 22
    if (!beliefHeld) return fail('a resize the pty could not take poisoned the session’s belief', { poisonInfo })

    // 7. replay disposition (the reconnect double-paint fix): 'suppress' must deliver
    // NO replay bytes; 'reset' must deliver a full-reset prefix plus the ring.
    const ringLen = capB.length
    await clientB.spawn(PANE, { cols: 90, rows: 22, cwd: '' }, undefined, 'suppress')
    await delay(800)
    const suppressDelta = capB.length - ringLen
    // The claim is "no RING bytes" — a measured same-dims spawn on ConPTY now also
    // triggers the attach realignment repaint (session.repaintForAttach), a bounded burst
    // of NEW bytes that is not the ring and must not read as it. TWO viewports' allowance,
    // not one: the realignment is a JIGGLE (grow one row, restore) because
    // ResizePseudoConsole with the dimensions conhost already holds repaints nothing, so
    // conhost may answer with two repaints. win32 only; POSIX keeps the strict bound, which
    // is what proves the platform guard rather than assuming it.
    const repaintAllowance = process.platform === 'win32' ? 2 * 90 * 22 * 4 : 0
    const suppressOk = suppressDelta < Math.max(300, ringLen / 4) + repaintAllowance
    if (!suppressOk) return fail('suppress replay still delivered the ring', { suppressDelta, ringLen })
    const beforeReset = capB.length
    await clientB.spawn(PANE, { cols: 90, rows: 22, cwd: '' }, undefined, 'reset')
    await delay(800)
    const resetChunk = capB.slice(beforeReset)
    const resetOk = resetChunk.includes('\x1bc') && resetChunk.length > 100
    if (!resetOk) return fail('reset replay carried no full-reset prefix', { resetLen: resetChunk.length })

    if (!(await retire(clientB, ep2.pid))) return fail('gen B daemon did not die on shutdown')

    // C. headless restore: no client ever measures, the launch grace expires — and the
    // daemon STILL types nothing. Self-recovery moved with the composer: the intent
    // stays on the wire (welcome) for whichever app connects next; a daemon that typed
    // its own poorer resume here would suppress that richer relaunch (the 0-of-34 bug).
    process.env.MOGGING_LAUNCH_DIMS_GRACE_MS = '2000'
    const ep3 = await ensureDaemon(daemonJs, helper)
    if (ep3.pid === ep2.pid) return fail('gen C is not a fresh daemon')
    let capC = ''
    const clientC = new DaemonClient(ep3, {
      onData: (id, d) => {
        if (id === PANE) capC += d
      }
    })
    const welcomeC = await clientC.connect()
    const intentHeldHeadless = welcomeC.find((p) => p.id === PANE)?.launch?.agentId === 'claude'
    if (!intentHeldHeadless) return fail('headless restore dropped the launch intent')
    clientC.attach(PANE)
    await until(() => capC.length > 0, 5000)
    const countResume = (): number => (capC.match(/--resume/g) || []).length
    const baseline = countResume()
    await delay(3500) // past the 2000ms grace, with margin
    const graceTypesNothing = countResume() === baseline
    if (!graceTypesNothing)
      return fail('the grace timer composed a resume — composition belongs to main', { baseline })

    clientC.kill(PANE)
    await delay(300)
    if (!(await retire(clientC, ep3.pid))) return fail('gen C daemon did not die on shutdown')

    clearTimeout(watchdog)
    writeOut({
      pass: true,
      gridRestored,
      intentCarried,
      daemonTypesNothing: deferred,
      dimlessLeftAlone,
      measuredReadBack: { cols: reMeasured.cols ?? null, rows: reMeasured.rows ?? null },
      modeGrounded,
      staleGenRefused: staleRefused,
      trueGenApplied,
      beliefHeld,
      suppressOk,
      resetOk,
      intentHeldHeadless,
      graceTypesNothing
    })
    app.exit(0)
  } catch (err) {
    fail(String(err))
  }
}
