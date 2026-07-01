// Env-gated APP-LEVEL survival smoke (MOGGING_SURVIVE=A then =B), run as two separate
// Electron launches. Phase A starts a pane in the daemon and quits the app WITHOUT killing
// the daemon; phase B relaunches, reconnects to the SAME running daemon, and asserts the
// pane is still alive (counter advanced) and re-attached (no duplicate). This proves the
// ADR 0006 goal: agents survive an app quit/relaunch. (Uses the DaemonClient directly.)
import { app } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureDaemon, DaemonClient } from './daemon-client'

// A cwd-independent path both Electron launches (and the test harness) can agree on.
const RESULT = path.join(os.tmpdir(), 'mogging-daemon-survive-result.json')
const COUNTER =
  'node -e "let i=0;setInterval(function(){process.stdout.write(\'MARK_\'+(i++)+String.fromCharCode(10))},300)"'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const marks = (s: string): number[] => (s.match(/MARK_(\d+)/g) || []).map((x) => Number(x.slice(5)))
function writeResult(o: unknown): void {
  try {
    fs.writeFileSync(RESULT, JSON.stringify(o))
  } catch {
    /* ignore */
  }
}
function readResult(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(RESULT, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function runDaemonSurviveSmoke(phase: string): Promise<void> {
  // Hard safety net: never let the app hang if the daemon path stalls.
  setTimeout(() => {
    writeResult({ phase, pass: false, error: 'smoke timeout' })
    app.exit(1)
  }, 22000)
  try {
    const ep = await ensureDaemon(path.join(__dirname, 'daemon.js'))
    let cap = ''
    const client = new DaemonClient(ep, {
      onData: (id, d) => {
        if (id === 'sp1') cap += d
      }
    })
    const panes = await client.connect()

    if (phase === 'A') {
      client.spawn('sp1', { run: COUNTER })
      await delay(3200)
      writeResult({ phase: 'A', maxA: Math.max(-1, ...marks(cap)), daemonPidA: ep.pid })
      client.dispose()
      app.exit(0) // quit the app but leave the detached daemon running
      return
    }

    // phase B — reconnect to the surviving daemon
    const had = panes.some((p) => p.id === 'sp1') // pane was already in the daemon's welcome
    client.spawn('sp1', { run: COUNTER }) // id-guard: attaches the existing pane (run ignored)
    await delay(3200)
    const mB = marks(cap)
    const prev = readResult()
    const maxA = typeof prev.maxA === 'number' ? (prev.maxA as number) : -1
    const sameDaemon = prev.daemonPidA === ep.pid
    // Continuation: the counter advanced well past where phase A left off (a fresh spawn would
    // reset near 0). `had` + `sameDaemon` prove we REATTACHED to the same running pane rather
    // than creating a duplicate. minB is low because reattach replays scrollback (expected).
    const survived = mB.length > 0 && Math.max(...mB) > maxA
    const pass = had && survived && sameDaemon
    writeResult({
      phase: 'B',
      pass,
      had,
      survived,
      sameDaemon,
      maxA,
      minB: mB.length ? Math.min(...mB) : -1,
      maxB: mB.length ? Math.max(...mB) : -1,
      daemonPidA: prev.daemonPidA,
      daemonPidB: ep.pid
    })
    client.dispose()
    app.exit(pass ? 0 : 1)
  } catch (e) {
    writeResult({ phase, pass: false, error: String(e) })
    app.exit(1)
  }
}
