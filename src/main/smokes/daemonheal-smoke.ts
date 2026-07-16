// Env-gated daemon-heal smoke (MOGGING_DAEMONHEAL=1) — windowless, the REAL relay.
//
// Gates the reconnect lifecycle that every silent daemon incident ultimately rides:
// startDaemonBackend's onClose → reconnect loop, its interaction with update quiescence,
// and the client.log journal that makes any of it diagnosable after the fact.
//
//   A. CRASH → SELF-HEAL   kill the daemon process outright; the relay must notice within
//      milliseconds (socket close), spawn a replacement, and land back on health
//      'connected' — with 'daemon-connection-lost' and 'daemon-reconnected' journaled.
//   B. QUIESCED → STUCK, HONESTLY   with quiescence latched (the pre-install state), a dead
//      daemon must NOT be resurrected: ensureDaemon refuses, the loop keeps retrying, and
//      health stays 'reconnecting' — the exact permanent-freeze shape update:restart could
//      leave behind when quitAndInstall had nothing to install.
//   C. UN-QUIESCE → SELF-HEAL   endDaemonQuiescence() alone — no restart, no user action —
//      must let the already-running retry loop seat a fresh daemon and go 'connected'.
//      This is the fix for the one-way latch: before it, B's state was FOREVER.
//
// Windowless on purpose: the relay takes a WebContents GETTER and tolerates null (renderer
// events are simply unsent), and daemon health is read straight off runtime-health's state.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isAlive } from '@backend/platform/pid'
import { beginDaemonQuiescence, endDaemonQuiescence, retireOwnDaemon } from '../daemon-client'
import { startDaemonBackend, getDaemonClient } from '../daemon-relay'
import { getDaemonHealth } from '../runtime-health'
import type { DaemonEndpoint } from '@contracts'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

const readEndpoint = (): DaemonEndpoint | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(isolatedRunDir(), 'endpoint.json'), 'utf8')) as DaemonEndpoint
  } catch {
    return null
  }
}

const readClientLog = (): string => {
  try {
    return fs.readFileSync(path.join(isolatedRunDir(), 'client.log'), 'utf8')
  } catch {
    return ''
  }
}

/** Poll until a LIVE endpoint with a pid other than `notPid` is up and health says connected. */
async function waitHealed(notPid: number, ms: number): Promise<DaemonEndpoint | null> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const ep = readEndpoint()
    if (ep && ep.pid !== notPid && isAlive(ep.pid) && getDaemonHealth().state === 'connected') return ep
    await delay(200)
  }
  return null
}

export async function runDaemonHealSmoke(): Promise<void> {
  const write = (o: object): void => {
    try {
      const out = path.join(app.getAppPath(), 'out')
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'daemonheal-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  setTimeout(() => {
    write({ pass: false, error: 'TIMEOUT: daemon-heal smoke did not complete' })
    app.exit(1)
  }, 150_000)

  const r: Record<string, unknown> = {}
  let dispose: (() => void) | null = null
  try {
    dispose = await startDaemonBackend(() => null)
    const ep1 = readEndpoint()
    r.started = !!ep1 && isAlive(ep1.pid) && getDaemonHealth().state === 'connected' && !!getDaemonClient()
    if (!ep1) throw new Error('no endpoint after startDaemonBackend')

    // ── A. crash → self-heal ─────────────────────────────────────────────────────────────
    process.kill(ep1.pid)
    const ep2 = await waitHealed(ep1.pid, 25_000)
    r.healedAfterCrash = !!ep2
    const log1 = readClientLog()
    r.lossJournaled = log1.includes('daemon-connection-lost')
    r.reconnectJournaled = log1.includes('daemon-reconnected')
    if (!ep2) throw new Error('relay did not heal after daemon kill')

    // ── B. quiesced → stuck, honestly ────────────────────────────────────────────────────
    beginDaemonQuiescence()
    process.kill(ep2.pid)
    // First: the loss must be NOTICED (health leaves 'connected' when the socket dies)…
    const leftBy = Date.now() + 5000
    while (getDaemonHealth().state === 'connected' && Date.now() < leftBy) await delay(50)
    r.quiesceNoticedLoss = getDaemonHealth().state !== 'connected'
    // …then the whole observation window must hold: one flip back to 'connected' (or a fresh
    // live daemon pid) means something resurrected a daemon inside the pre-install handoff —
    // the installer exe-lock bug come back.
    const quiesceUntil = Date.now() + 4000
    let resurrections = 0
    while (Date.now() < quiesceUntil) {
      const ep = readEndpoint()
      if (getDaemonHealth().state === 'connected' || (ep && ep.pid !== ep2.pid && isAlive(ep.pid))) resurrections++
      await delay(200)
    }
    r.quiesceHeldTheLine = resurrections === 0
    r.quiesceRefusalJournaled = /daemon-reconnect-failed.*quiescing/.test(readClientLog())

    // ── C. un-quiesce → the already-running loop heals on its own ────────────────────────
    endDaemonQuiescence()
    const ep3 = await waitHealed(ep2.pid, 25_000)
    r.healedAfterUnquiesce = !!ep3
    const log2 = readClientLog()
    r.quiesceJournaled = log2.includes('quiesce-begin') && log2.includes('quiesce-end')

    // ── Cleanup: stop the loop FIRST, then prove the last daemon dead ────────────────────
    dispose()
    dispose = null
    if (ep3) {
      const retired = await retireOwnDaemon({ quiesce: true })
      const until = Date.now() + 5000
      while (isAlive(ep3.pid) && Date.now() < until) await delay(100)
      r.cleanedUp = retired && !isAlive(ep3.pid)
    }

    const pass = Object.entries(r).every(([, v]) => v === true)
    write({ pass, ...r })
    app.exit(pass ? 0 : 1)
  } catch (e) {
    try {
      dispose?.()
    } catch {
      /* already gone */
    }
    write({ pass: false, error: String(e), ...r })
    app.exit(1)
  }
}
