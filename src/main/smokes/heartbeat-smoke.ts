// Env-gated heartbeat smoke (MOGGING_HEARTBEAT=1) — windowless, one REAL daemon.
//
// Gates the DaemonClient liveness heartbeat — the machinery that turns "the daemon wedged
// with its socket still open" from an invisible forever-freeze (frozen panes, dropped input,
// no signal anywhere) into the ordinary onClose → reconnect path. The protocol always had
// ping/pong; before the heartbeat, nothing ever sent one.
//
// The wedge is injected with the daemon's MOGGING_DAEMON_PING_MUTE_MS seam (same pattern as
// MOGGING_DAEMON_SPAWN_DELAY_MS): for the first N ms the daemon ignores `ping` — provably
// alive (welcome, spawn, pty data all work) yet silent to the liveness probe.
//
// Three acts against ONE daemon, inside the mute window and after it:
//   A. QUIET + MUTED  → a client whose pings go unanswered and that hears nothing else must
//      declare the line dead: destroy its own socket (onClose fires) while the daemon PID
//      LIVES — a wedge verdict, not a kill — and journal 'heartbeat-lost'.
//   B. BUSY + MUTED   → a client attached to a pane that is STREAMING output must NOT be
//      shot: any inbound message is liveness. This is the assertion that keeps the heartbeat
//      honest — a daemon too busy to pong is emphatically not dead.
//   C. AFTER THE MUTE → pongs flow; a quiet client stays connected well past the stale
//      threshold, and a pane round-trip proves the daemon's loop end to end.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isAlive } from '@backend/platform/pid'
import { ensureDaemon, retireOwnDaemon, DaemonClient } from '../daemon-client'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const MUTE_MS = 12_000

function isolatedRunDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), 'Library', 'Application Support')
  const runRoot = path.join(base, 'MoggingLabs', 'run')
  // The VERSION segment only — run/ also holds the CLI runtime's `mcp/` dir (see stampwar).
  const seg = fs
    .readdirSync(runRoot)
    .find((n) => /^(dev-)?v\d+$/.test(n) && fs.statSync(path.join(runRoot, n)).isDirectory())
  return path.join(runRoot, String(seg))
}

const readClientLog = (): string => {
  try {
    return fs.readFileSync(path.join(isolatedRunDir(), 'client.log'), 'utf8')
  } catch {
    return ''
  }
}

export async function runHeartbeatSmoke(): Promise<void> {
  const write = (o: object): void => {
    try {
      const out = path.join(app.getAppPath(), 'out')
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'heartbeat-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  setTimeout(() => {
    write({ pass: false, error: 'TIMEOUT: heartbeat smoke did not complete' })
    app.exit(1)
  }, 150_000)

  const r: Record<string, unknown> = {}
  const clients: DaemonClient[] = []
  try {
    // The daemon inherits this at spawn (ensureDaemon passes process.env through).
    process.env.MOGGING_DAEMON_PING_MUTE_MS = String(MUTE_MS)
    const muteStartedBy = Date.now() // the daemon boots AFTER this, so mute outlives this + MUTE_MS is a floor
    const ep = await ensureDaemon(path.join(__dirname, 'daemon.js'))
    r.seated = isAlive(ep.pid)

    // ── A. quiet + muted: the heartbeat must declare the line dead — daemon left alive ────
    let aClosed = 0
    const clientA = new DaemonClient(ep, { onClose: () => aClosed++ }, { kind: 'app', heartbeatMs: 300 })
    clients.push(clientA)
    await clientA.connect() // welcome arms the heartbeat; the daemon then never pongs
    const aStart = Date.now()
    while (aClosed === 0 && Date.now() - aStart < 8000) await delay(100)
    r.wedgeDetected = aClosed > 0
    r.wedgeDetectedQuickly = aClosed > 0 && Date.now() - aStart < 5000
    r.daemonLeftAlive = isAlive(ep.pid) // a wedge VERDICT, never a kill
    r.lossJournaled = readClientLog().includes('heartbeat-lost')

    // ── B. busy + muted: streaming output is liveness — the client must NOT be shot ──────
    let bClosed = 0
    const clientB = new DaemonClient(ep, { onClose: () => bClosed++ }, { kind: 'app', heartbeatMs: 300 })
    clients.push(clientB)
    await clientB.connect()
    await clientB.spawn('9902', { cwd: '' })
    // A command that streams forever; the pane's data messages keep lastSeen fresh.
    const torrent =
      process.platform === 'win32' ? 'for /l %i in () do @echo mogging-tick\r' : 'while :; do echo mogging-tick; done\n'
    clientB.input('9902', torrent)
    const bStart = Date.now()
    while (Date.now() - bStart < 2500) {
      if (bClosed > 0) break
      await delay(100)
    }
    r.busyNotShot = bClosed === 0
    clientB.kill('9902') // stop the torrent with the pane
    clientB.dispose()

    // ── C. after the mute: pongs answer, a QUIET client stays connected ──────────────────
    const muteRemaining = muteStartedBy + MUTE_MS + 1000 - Date.now()
    if (muteRemaining > 0) await delay(muteRemaining)
    let cClosed = 0
    const clientC = new DaemonClient(ep, { onClose: () => cClosed++ }, { kind: 'app', heartbeatMs: 300 })
    clients.push(clientC)
    await clientC.connect()
    await delay(3000) // 10 intervals of silence-but-for-pongs: only pongs can be keeping it alive
    r.stableAfterMute = cClosed === 0
    const round = await clientC.spawn('9903', { cwd: '' })
    r.roundTripAfterMute = round.existing === false
    clientC.kill('9903')
    clientC.dispose()

    // ── Cleanup: prove the daemon dead ────────────────────────────────────────────────────
    const retired = await retireOwnDaemon({ quiesce: true })
    const until = Date.now() + 5000
    while (isAlive(ep.pid) && Date.now() < until) await delay(100)
    r.cleanedUp = retired && !isAlive(ep.pid)

    const pass = Object.entries(r).every(([, v]) => v === true)
    write({ pass, ...r })
    app.exit(pass ? 0 : 1)
  } catch (e) {
    for (const c of clients) {
      try {
        c.dispose()
      } catch {
        /* already gone */
      }
    }
    write({ pass: false, error: String(e), ...r })
    app.exit(1)
  }
}
