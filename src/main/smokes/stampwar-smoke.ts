// Env-gated stamp-war smoke (MOGGING_STAMPWAR=1) — windowless, REAL daemons.
//
// Gates the retire-war guard on ensureDaemon's build-stamp path. The war it prevents was
// observed live (2026-07-15, run/v9/daemon.log): two same-channel apps of DIFFERENT builds
// each found the other's daemon stamp-stale on boot/reconnect and retired it — six retires
// in two hours, every pane's live process (agents mid-turn) dying each round, with nothing
// painted in any pane. The guard: a mismatched daemon is retired ONLY when no OTHER client
// is attached to it (welcome's `otherClients`, daemon-side count).
//
// Three acts, on real spawned daemons in this smoke's isolated runtime tree:
//   A. mismatch + a LIVE client  → ensureDaemon must REFUSE the retire: same daemon pid
//      survives, the attached client keeps a working round-trip, and client.log carries
//      the 'stamp-retire-refused' breadcrumb (the journal is load-bearing, not decoration).
//   B. mismatch + NO client      → the retire must still happen (an app update replacing a
//      stale daemon nobody uses is the stamp's whole purpose): old pid dies, the fresh
//      daemon carries the foreign entry's true stamp.
//   C. old-daemon compatibility  → a welcome WITHOUT `otherClients` (daemons predating the
//      field) reads as "cannot learn" and retires as before — proven against a doctored
//      probe result is impossible here, so act B doubles as the shape check via a daemon
//      that DOES report; the null path is unit-shaped inside ensureDaemon (probe timeout →
//      retire) and covered by the refusal matrix being exactly `otherClients > 0`.
//
// The "foreign build" is a byte-appended COPY of out/main/daemon.js placed as a SIBLING
// (daemon-stampwar.js) so its module resolution is identical — different bytes, different
// stamp, same behaviour. Every daemon this smoke starts, it also proves dead.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildStampOf } from '@backend/platform/build-stamp'
import { isAlive } from '@backend/platform/pid'
import { ensureDaemon, retireOwnDaemon, DaemonClient } from '../daemon-client'
import { helperRuntime } from '../node-helper'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitUntilDead(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!isAlive(pid)) return true
    await delay(100)
  }
  return !isAlive(pid)
}

/** This smoke's isolated runtime dir (the harness redirected LOCALAPPDATA/XDG_RUNTIME_DIR),
 *  derived exactly as daemon-client derives it — where endpoint.json and client.log live. */
function isolatedRunDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), 'Library', 'Application Support')
  const runRoot = path.join(base, 'MoggingLabs', 'run')
  // The VERSION segment only: run/ also holds the CLI runtime's `mcp/` dir (installCliRuntime
  // creates it before any smoke runs), and readdir order put it first — every journal read
  // then looked in a dir no daemon writes.
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

export async function runStampWarSmoke(): Promise<void> {
  const write = (o: object): void => {
    try {
      const out = path.join(app.getAppPath(), 'out')
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'stampwar-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  setTimeout(() => {
    write({ pass: false, error: 'TIMEOUT: stamp-war smoke did not complete' })
    app.exit(1)
  }, 120_000)

  const r: Record<string, unknown> = {}
  let client: DaemonClient | null = null
  try {
    const daemonEntry = path.join(__dirname, 'daemon.js')

    // The foreign build: same bytes + one comment = a different stamp, identical behaviour.
    const foreignEntry = path.join(__dirname, 'daemon-stampwar.js')
    fs.copyFileSync(daemonEntry, foreignEntry)
    fs.appendFileSync(foreignEntry, '\n// stampwar: foreign-build byte\n')
    const homeStamp = buildStampOf(daemonEntry)
    const foreignStamp = buildStampOf(foreignEntry)
    r.stampsDiffer = !!homeStamp && !!foreignStamp && homeStamp !== foreignStamp

    // ── A. mismatch + a live client: the retire must be REFUSED ─────────────────────────
    const ep1 = await ensureDaemon(daemonEntry, helperRuntime())
    r.seated = isAlive(ep1.pid) && ep1.build === homeStamp

    client = new DaemonClient(ep1, {}, { kind: 'app' })
    await client.connect()
    // A real round-trip (a `spawned` reply can only come from a live daemon), and the pane
    // gives the daemon something to lose if a retire ever fires here.
    const first = await client.spawn('9901', { cwd: '' })
    r.paneSpawned = first.existing === false

    const epWar = await ensureDaemon(foreignEntry, helperRuntime())
    r.warRefusedSamePid = epWar.pid === ep1.pid && isAlive(ep1.pid)
    r.warRefusedKeptStamp = epWar.build === homeStamp
    // The attached client survived — `existing: true` is a fresh reply, not a cached value.
    const again = await client.spawn('9901', { cwd: '' })
    r.clientSurvivedWar = again.existing === true
    r.refusalJournaled = readClientLog().includes('stamp-retire-refused')

    // ── B. mismatch + no client: the retire must still happen (that IS the update path) ──
    client.dispose()
    client = null
    await delay(400) // let the daemon process the socket close before the probe counts clients

    const ep2 = await ensureDaemon(foreignEntry, helperRuntime())
    r.staleRetired = await waitUntilDead(ep1.pid, 5000)
    r.freshSeated = ep2.pid !== ep1.pid && isAlive(ep2.pid) && ep2.build === foreignStamp
    // 'stamp-retire {' (event + JSON detail): NOT a substring of 'stamp-retire-refused {'.
    r.retireJournaled = readClientLog().includes('stamp-retire {')

    // ── Cleanup: prove the last daemon dead too ──────────────────────────────────────────
    const retired = await retireOwnDaemon({ quiesce: true })
    r.cleanedUp = retired && (await waitUntilDead(ep2.pid, 5000))
    try {
      fs.rmSync(foreignEntry, { force: true })
    } catch {
      /* best effort */
    }

    const pass = Object.entries(r).every(([, v]) => v === true)
    write({ pass, ...r })
    app.exit(pass ? 0 : 1)
  } catch (e) {
    try {
      client?.dispose()
    } catch {
      /* already gone */
    }
    write({ pass: false, error: String(e), ...r })
    app.exit(1)
  }
}
