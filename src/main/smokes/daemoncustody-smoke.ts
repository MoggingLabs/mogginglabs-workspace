// Env-gated daemon-custody smoke (MOGGING_DAEMONCUSTODY=1) — windowless, REAL daemons.
//
// Gates the custody split introduced after v0.11.1 nearly shipped dead twice over:
//
//   THE BUILD STAMP. DAEMON_PROTOCOL_VERSION answers "can an old daemon speak to this app?"
//   and for a while it was made to answer a second question it cannot carry: "is the running
//   daemon's CODE current?" (the tracker fix changed no wire, so only a burned protocol
//   version could deliver it — and every burn minted an immortal run/v<N> dir). The stamp is
//   the honest second lever: the daemon self-hashes its bundle into endpoint.json; the app
//   compares against the bundle it would spawn and retires a stale daemon IN PLACE — same
//   dir, graceful shutdown (persistNow), cold-start restore.
//
//   THE SWEEP. Nothing ever deleted a retired version's runtime dir: the first machine we
//   audited carried eight of them — 31 MB of dead auth tokens and stale scrollback. The
//   sweep removes dead, strictly-older, same-channel dirs at boot, and refuses everything
//   else (live pid, current, future, foreign channel).
//
// Three acts, escalating from pure function to REAL process lifecycle:
//   A. buildStampOf — deterministic, byte-sensitive, null on unreadable.
//   B. sweepRunRoot — the whole refusal matrix on a fixture root, including a LIVE pid
//      (this very process) that must be kept.
//   C. the real thing: spawn a daemon from out/main/daemon.js, assert its endpoint carries
//      the true stamp; DOCTOR the endpoint to a stale stamp and call ensureDaemon again —
//      the stale daemon must die and a fresh one (new pid, true stamp) must replace it in
//      the same dir; then retireOwnDaemon(quiesce) — the pre-install step — must kill that
//      one too and leave ensureDaemon REFUSING to spawn, which is exactly the window in
//      which the updater hands control to the installer.
//
// Isolated by the launch recipe's LOCALAPPDATA, so the daemons spawned here never touch a
// real machine's runtime root — and every daemon this smoke starts, it also proves dead.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildStampOf } from '@backend/platform/build-stamp'
import { ensureDaemon, retireOwnDaemon } from '../daemon-client'
import { sweepRunRoot } from '../daemon-sweep'
import { isAlive } from '@backend/platform/pid'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitUntilDead(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!isAlive(pid)) return true
    await delay(100)
  }
  return !isAlive(pid)
}

export async function runDaemonCustodySmoke(): Promise<void> {
  const write = (o: object): void => {
    try {
      const out = path.join(app.getAppPath(), 'out')
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'daemoncustody-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  setTimeout(() => {
    write({ pass: false, error: 'TIMEOUT: daemon custody smoke did not complete' })
    app.exit(1)
  }, 90_000)

  const r: Record<string, unknown> = {}
  try {
    // ── A. the stamp function ─────────────────────────────────────────────────────────
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'))
    const f = path.join(tmp, 'bundle.js')
    fs.writeFileSync(f, 'console.log(1)')
    const s1 = buildStampOf(f)
    const s2 = buildStampOf(f)
    fs.writeFileSync(f, 'console.log(2)') // one byte of behaviour
    const s3 = buildStampOf(f)
    r.stampStable = !!s1 && s1 === s2 && /^[0-9a-f]{16}$/.test(s1)
    r.stampByteSensitive = !!s3 && s3 !== s1
    r.stampNullOnMissing = buildStampOf(path.join(tmp, 'nope.js')) === null

    // ── B. the sweep's refusal matrix ─────────────────────────────────────────────────
    // Fixture root, current version 9, prod channel. Every dir states its own expectation.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runroot-'))
    const mk = (name: string, endpoint?: object, extras: string[] = []): void => {
      const d = path.join(root, name)
      fs.mkdirSync(d, { recursive: true })
      if (endpoint) fs.writeFileSync(path.join(d, 'endpoint.json'), JSON.stringify(endpoint))
      for (const x of extras) fs.writeFileSync(path.join(d, x), 'x')
    }
    // A pid that is certainly dead: spawn-and-reap would be overkill — pid 4 billion is
    // outside every OS's range... not portable. Use a child that already exited? Simpler:
    // pick this process's pid + a large offset and verify it is actually dead first; if the
    // roll lands on a live pid, step until dead (bounded).
    let deadPid = process.pid + 100_000
    for (let i = 0; i < 50 && isAlive(deadPid); i++) deadPid += 7919
    r.foundDeadPid = !isAlive(deadPid)
    mk('v3', { version: 3, address: 'x', token: 't', pid: deadPid }, ['sessions.db', 'daemon.log']) // dead + old → SWEEP
    mk('v4', undefined, ['sessions.db']) // no endpoint at all → dead → SWEEP
    mk('v5', { version: 5, address: 'not-a-pipe', token: 't', pid: process.pid }) // LIVE pid (us) → KEEP
    mk('v9', { version: 9, address: 'x', token: 't', pid: deadPid }) // current → KEEP (never judged)
    mk('v12', { version: 12, address: 'x', token: 't', pid: deadPid }) // future → KEEP (a newer release's)
    mk('dev-v3', { version: 3, address: 'x', token: 't', pid: deadPid }) // foreign channel → KEEP
    const report = sweepRunRoot(root, 9, 'prod')
    const left = fs.readdirSync(root).sort()
    r.sweepRemoved = JSON.stringify(report.swept.sort()) === JSON.stringify(['v3', 'v4'])
    r.sweepKeptLive = JSON.stringify(report.keptLive) === JSON.stringify(['v5'])
    r.sweepSurvivors = JSON.stringify(left) === JSON.stringify(['dev-v3', 'v12', 'v5', 'v9'])

    // ── C. the real lifecycle ─────────────────────────────────────────────────────────
    const daemonEntry = path.join(__dirname, 'daemon.js')
    const expected = buildStampOf(daemonEntry)
    r.expectedStamp = !!expected

    const ep1 = await ensureDaemon(daemonEntry)
    r.endpointCarriesStamp = ep1.build === expected && !!ep1.build

    // Doctor the live endpoint to claim a stale build — byte-for-byte what an endpoint
    // written by LAST release's daemon looks like to THIS release's app — and rediscover.
    // ensureDaemon must retire the impostor and seat a fresh daemon in the same dir.
    // (runtimeDir honors this smoke's isolated LOCALAPPDATA, so the derivation below finds
    // exactly the endpoint the spawn above wrote — the same derivation daemon-client uses.)
    const base =
      process.platform === 'win32'
        ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
        : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), 'Library', 'Application Support')
    const runRoot = path.join(base, 'MoggingLabs', 'run')
    const seg = fs.readdirSync(runRoot).find((n) => fs.existsSync(path.join(runRoot, n, 'endpoint.json')))
    const epFile = path.join(runRoot, String(seg), 'endpoint.json')
    fs.writeFileSync(epFile, JSON.stringify({ ...ep1, build: '0000000000000000' }))

    // Decision-trail instrumentation: when this act fails, the verdict must carry WHY —
    // the exact inputs ensureDaemon is about to judge, and every warn it emits while judging.
    const back = JSON.parse(fs.readFileSync(epFile, 'utf8')) as typeof ep1
    let accessErr = 'none'
    try {
      fs.accessSync(back.address)
    } catch (e) {
      accessErr = String((e as NodeJS.ErrnoException).code)
    }
    r.trace = {
      seg,
      address: back.address,
      wroteBuild: back.build,
      version: back.version,
      pid: back.pid,
      pidAlive: isAlive(back.pid),
      accessErr,
      ep1Keys: Object.keys(ep1).sort().join(',')
    }
    const warns: string[] = []
    const origWarn = console.warn.bind(console)
    console.warn = (...a: unknown[]): void => {
      warns.push(a.map(String).join(' '))
      origWarn(...a)
    }

    let ep2
    try {
      ep2 = await ensureDaemon(daemonEntry)
    } finally {
      console.warn = origWarn
      r.warns = warns
    }
    r.staleRetired = await waitUntilDead(ep1.pid, 5000)
    r.freshSeated = ep2.pid !== ep1.pid && ep2.build === expected && isAlive(ep2.pid)

    // The pre-install step: retire our own daemon and refuse to resurrect it.
    const retired = await retireOwnDaemon({ quiesce: true })
    r.retireOwnDaemon = retired && (await waitUntilDead(ep2.pid, 5000))
    let refused = false
    try {
      await ensureDaemon(daemonEntry)
    } catch {
      refused = true
    }
    r.quiescenceRefusesSpawn = refused

    const pass = Object.entries(r)
      .filter(([k]) => k !== 'trace' && k !== 'warns')
      .every(([, v]) => v === true)
    write({ pass, ...r })
    app.exit(pass ? 0 : 1)
  } catch (e) {
    write({ pass: false, error: String(e), ...r })
    app.exit(1)
  }
}
