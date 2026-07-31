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
//   B. COLD-START RESTORE — the four contract points, in order:
//        1. the restored session lists 44x11, not the 80x24 spawn default;
//        2. its resume ('claude --resume') is DEFERRED: absent from scrollback while
//           only a bare (dims-less) attach has seen the pane;
//        3. a spawn WITHOUT dims (an unmeasured hidden pane) neither resizes the
//           session nor releases the resume — absent dims mean "leave it alone";
//        4. a spawn WITH measured dims equal to the session's applies nothing but
//           CONFIRMS the size, and the resume types promptly after it.
//   C. HEADLESS GRACE — a fresh cold start where NO client ever sends dims: the resume
//      still types on its own once LAUNCH_DIMS_GRACE_MS expires (daemon self-recovery,
//      ADR 0006, must not wait forever on an app that never comes).
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

    // 2. bare attach (no dims): the replay must NOT contain the resume yet.
    clientB.attach(PANE)
    await until(() => capB.length > 0, 5000)
    await delay(1000) // past the window where the pre-fix constructor typed it instantly
    const deferred = !capB.includes('--resume')
    if (!deferred) return fail('resume typed before any client measured the pane')

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
    if (capB.includes('--resume')) return fail('a dims-less spawn released the deferred resume')

    // 4. measured dims equal to the session's: applies nothing, confirms, resume types.
    const reMeasured = await clientB.spawn(PANE, { cols: 44, rows: 11, cwd: '' })
    if (!reMeasured.existing) return fail('measured respawn lost the session')
    const typedAfterConfirm = await until(() => capB.includes('--resume'), 8000)
    if (!typedAfterConfirm)
      return fail('resume never typed after a measured attach confirmed the grid', { capTail: capB.slice(-200) })
    if (!(await retire(clientB, ep2.pid))) return fail('gen B daemon did not die on shutdown')

    // C. headless grace: no client ever measures — the resume must fire on its own.
    // The replayed scrollback already carries gen B's typed resume, so compare COUNTS.
    process.env.MOGGING_LAUNCH_DIMS_GRACE_MS = '2000'
    const ep3 = await ensureDaemon(daemonJs, helper)
    if (ep3.pid === ep2.pid) return fail('gen C is not a fresh daemon')
    let capC = ''
    const clientC = new DaemonClient(ep3, {
      onData: (id, d) => {
        if (id === PANE) capC += d
      }
    })
    await clientC.connect()
    clientC.attach(PANE)
    await until(() => capC.length > 0, 5000)
    const countResume = (): number => (capC.match(/--resume/g) || []).length
    const baseline = countResume()
    const graceTyped = await until(() => countResume() > baseline, 8000)
    if (!graceTyped)
      return fail('headless grace never typed the resume (self-recovery lost)', { baseline })

    clientC.kill(PANE)
    await delay(300)
    if (!(await retire(clientC, ep3.pid))) return fail('gen C daemon did not die on shutdown')

    clearTimeout(watchdog)
    writeOut({
      pass: true,
      gridRestored,
      deferredUntilMeasured: deferred,
      dimlessLeftAlone,
      typedAfterConfirm,
      graceTyped
    })
    app.exit(0)
  } catch (err) {
    fail(String(err))
  }
}
