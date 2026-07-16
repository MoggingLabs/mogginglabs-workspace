// Env-gated APP-LEVEL survival smoke (MOGGING_SURVIVE=A then =B), run as two separate
// Electron launches. Phase A starts a pane in the daemon and quits the app WITHOUT killing
// the daemon; phase B relaunches, reconnects to the SAME running daemon, and asserts the
// pane is still alive (counter advanced) and re-attached (no duplicate). This proves the
// ADR 0006 goal: agents survive an app quit/relaunch. (Uses the DaemonClient directly.)
//
// Since the runtime split (ADR 0016) BOTH phases also prove WHO hosts the surviving
// daemon: the pid behind the endpoint must be executing the standalone helper binary,
// not the Electron app. That is the gate the fuse flip is conditioned on — survival must
// hold on the runtime we actually ship, not the Electron-as-Node path that no longer exists.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureDaemon, DaemonClient } from '../daemon-client'
import { helperRuntime } from '../node-helper'
import { processImagePath, samePath } from './kit'

// A cwd-independent path both Electron launches (and the test harness) can agree on.
const RESULT = path.join(os.tmpdir(), 'mogging-daemon-survive-result.json')
// The sweep's verdict file (qa-smokes.sh reads out/<name>-result.json, pass:true).
const OUT_RESULT = path.join(app.getAppPath(), 'out', 'survive-result.json')
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
function writeOutResult(o: unknown): void {
  try {
    fs.mkdirSync(path.dirname(OUT_RESULT), { recursive: true })
    fs.writeFileSync(OUT_RESULT, JSON.stringify(o))
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
    writeOutResult({ phase, pass: false, error: 'smoke timeout' })
    app.exit(1)
  }, 22000)
  try {
    const helper = helperRuntime()
    const ep = await ensureDaemon(path.join(__dirname, 'daemon.js'), helper)
    // The host proof (ADR 0016): the daemon pid must be executing the standalone helper.
    const daemonImage = processImagePath(ep.pid)
    const helperHosted = samePath(daemonImage, helper.executable)
    let cap = ''
    const client = new DaemonClient(ep, {
      onData: (id, d) => {
        if (id === 'sp1') cap += d
      }
    })
    const panes = await client.connect()

    if (phase === 'A') {
      // A cold spawn must report existing=false — the flag the restore path keys off.
      const { existing: existedA } = await client.spawn('sp1', { run: COUNTER })
      if (existedA) {
        // RE-ENTRY (electron-vite dev respawns electron after app.exit): the cold run
        // already recorded phase A. Overwriting now would poison existedA for phase B.
        client.dispose()
        app.exit(0)
        return
      }
      await delay(3200)
      const maxA = Math.max(-1, ...marks(cap))
      writeResult({ phase: 'A', maxA, daemonPidA: ep.pid, existedA, helperHostedA: helperHosted })
      // Phase A "passes" when the counter pane is demonstrably alive in the daemon —
      // AND the daemon is on the helper (a pane surviving on the wrong host proves nothing).
      writeOutResult({ phase: 'A', pass: maxA >= 0 && helperHosted, maxA, daemonPidA: ep.pid, helperHosted, daemonImage })
      client.dispose()
      app.exit(0) // quit the app but leave the detached daemon running
      return
    }

    // Phase B RE-ENTRY guard (same respawn story): the verdict is already written —
    // recomputing against a consumed tmp file would clobber a real PASS with junk.
    if (readResult().phase === 'B') {
      client.dispose()
      app.exit(0)
      return
    }

    // phase B — reconnect to the surviving daemon
    const had = panes.some((p) => p.id === 'sp1') // pane was already in the daemon's welcome
    // REATTACH must report existing=true, and the app must be able to SEE that: it is the
    // only signal that the pane's agent is still running, and the restore lineup refuses to
    // type `claude --resume` into a pane that already has Claude in it (agents/index.ts).
    const spawnedB = await client.spawn('sp1', { run: COUNTER }) // id-guard: run ignored
    const existedB = spawnedB.existing
    // The DAEMON owns the pty, so only the daemon can say how it grows. A reattach that omits
    // this (a pre-v4 daemon) must never reach xterm: it would render against a guessed backend.
    // Floor is 18309 (the ConPTY gate pty-host enforces) — NOT xterm's 21376 reflow threshold:
    // CI's windows-latest is Server 2022 (build 20348), where ConPTY is fine and reflow-off is
    // xterm's correct conservative path, not a defect.
    const ptyOk =
      process.platform === 'win32'
        ? spawnedB.pty?.backend === 'conpty' && spawnedB.pty.buildNumber >= 18309
        : spawnedB.pty?.backend === 'posix'
    await delay(3200)
    const mB = marks(cap)
    const prev = readResult()
    const maxA = typeof prev.maxA === 'number' ? (prev.maxA as number) : -1
    const sameDaemon = prev.daemonPidA === ep.pid
    // Continuation: the counter advanced well past where phase A left off (a fresh spawn would
    // reset near 0). `had` + `sameDaemon` prove we REATTACHED to the same running pane rather
    // than creating a duplicate. minB is low because reattach replays scrollback (expected).
    const survived = mB.length > 0 && Math.max(...mB) > maxA
    const existedA = prev.existedA === true
    const flagOk = existedB === true && !existedA // cold=false, reattach=true
    // Host proof, both ends (ADR 0016): phase A spawned on the helper, and the SAME pid
    // this phase reattached to is still executing it.
    const helperOk = prev.helperHostedA === true && helperHosted
    const pass = had && survived && sameDaemon && flagOk && ptyOk && helperOk
    const verdict = {
      phase: 'B',
      pass,
      had,
      survived,
      sameDaemon,
      flagOk,
      ptyOk,
      helperOk,
      daemonImage,
      pty: spawnedB.pty,
      existedA,
      existedB,
      maxA,
      minB: mB.length ? Math.min(...mB) : -1,
      maxB: mB.length ? Math.max(...mB) : -1,
      daemonPidA: prev.daemonPidA,
      daemonPidB: ep.pid
    }
    writeResult(verdict)
    writeOutResult(verdict)
    client.dispose()
    app.exit(pass ? 0 : 1)
  } catch (e) {
    writeResult({ phase, pass: false, error: String(e) })
    writeOutResult({ phase, pass: false, error: String(e) })
    app.exit(1)
  }
}
