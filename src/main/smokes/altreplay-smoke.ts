// Env-gated ALT-SCREEN REPLAY smoke (MOGGING_ALTREPLAY=1) — windowless, the REAL daemon.
//
// Gates the half of a reattach the scrollback ring cannot carry: TERMINAL STATE.
//
// The ring is trimmed from its HEAD, and a full-screen agent emits `?1049h` exactly once,
// seconds after launch. Past 200k characters of output that one sequence has rolled off
// while thousands of alt-screen frames remain — so the replay used to pour absolute-
// addressed cell diffs into a fresh xterm's NORMAL buffer, where LF scrolls. That is the
// reported bug: a pane whose composer is missing and whose text is mixed across rows.
//
//   A. EVICTED ENTER (the field case) — a probe takes the alternate screen, sets modes and
//      a scroll region, prints a marker, then emits MORE than the ring holds. On reattach
//      the payload must carry the mode set, must NOT carry one byte of the frames, and must
//      be short: there is no history on an alternate screen, so there is nothing to replay.
//   B. ENTER STILL PRESENT — the ring's PRE-alt bytes are genuine normal-buffer history
//      (xterm keeps that buffer behind the alt one, so it is what the user sees on quit).
//      They must survive; everything from the enter onward must not.
//   C. NORMAL BUFFER UNTOUCHED — a pane that never took the alternate screen replays its
//      ring verbatim. This is the assertion that keeps "say nothing when there is nothing
//      to say" honest, and it is what lets every other gate stay green.
//   D. NO STIMULUS — a standing subscriber sees ZERO bytes across the reattach. The fix is
//      state reconstruction, not a resize nudge; this is the positive statement of that.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SCROLLBACK_CHARS } from '@backend/features/terminal/pane-shared'
import { ensureDaemon, DaemonClient } from '../daemon-client'
import { helperRuntime } from '../node-helper'

const OUT_RESULT = path.join(app.getAppPath(), 'out', 'altreplay-result.json')
const SENTINEL = path.join(process.env.MOGGING_USERDATA || os.tmpdir(), 'altreplay-ran')

// `` rather than a literal ESC: the command line survives cmd.exe and POSIX sh alike,
// and node resolves the escape inside the single-quoted JS string. Same quoting discipline
// as reattachfit-smoke's PROBE.
// The markers are CONCATENATED AT RUNTIME, and that is load-bearing rather than fussy: the
// shell echoes the command line it was typed, so a marker spelled literally here would land
// in the ring BEFORE the alt-screen enter — and every assertion about what survives the cut
// would then be satisfied by the echo instead of by the replay.
const ALT_SETUP =
  "var e='\\u001b';process.stdout.write('PRE_'+'ALT_HISTORY\\n');" +
  "process.stdout.write(e+'[?1049h'+e+'[?1002h'+e+'[?1006h'+e+'[?2004h'+e+'[?25l'+e+'[3;40r');" +
  "process.stdout.write('ALT_'+'MARK');"
const IDLE = 'setInterval(function(){},1000)'

// Enough to push the alt enter off the head of the ring, in few enough writes to stay quick.
const FILLER = `var f='F'.repeat(10000);for(var i=0;i<${Math.ceil(SCROLLBACK_CHARS / 10000) + 6};i++)process.stdout.write(f);`

const PROBE_EVICTED = `node -e "${ALT_SETUP}${FILLER}${IDLE}"`
const PROBE_KEPT = `node -e "${ALT_SETUP}${IDLE}"`
const PROBE_NORMAL = `node -e "process.stdout.write('NORMAL_'+'MARK\\n');${IDLE}"`

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

export async function runAltReplaySmoke(): Promise<void> {
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
  }, 60000)
  const fail = (error: string, extra: Record<string, unknown> = {}): void => {
    clearTimeout(watchdog)
    writeOut({ pass: false, error, ...extra })
    app.exit(1)
  }

  /** Reattach with a FRESH client and return the replay payload it is handed. The daemon
   *  sends `spawned.scrollback` to the spawning client only, and daemon-client hands it
   *  straight to onData — so a fresh client's first bytes ARE the payload. */
  const replayOf = async (
    ep: Awaited<ReturnType<typeof ensureDaemon>>,
    id: string,
    cols: number,
    rows: number
  ): Promise<string> => {
    let cap = ''
    const c = new DaemonClient(ep, {
      onData: (paneId, d) => {
        if (paneId === id) cap += d
      }
    })
    await c.connect()
    const res = await c.spawn(id, { cols, rows })
    if (!res.existing) throw new Error(`reattach to ${id} reported existing=false (session lost)`)
    await delay(600)
    c.dispose()
    return cap
  }

  try {
    const ep = await ensureDaemon(path.join(__dirname, 'daemon.js'), helperRuntime())

    // ── Seed three panes ─────────────────────────────────────────────────────────────
    // The ar1 watcher SPAWNS its own pane rather than merely connecting: the daemon binds a
    // client to a pane's output in subscribe(), which only runs off a spawn or an attach, so
    // a client that never asked for a pane hears nothing about it. That is also what makes
    // it the right standing subscriber for D — it is bound to the LIVE channel, and the
    // replay a later reattach receives is sent to the spawning client alone.
    let standing = ''
    let anyData = 0
    const watcher = new DaemonClient(ep, {
      onData: (id, d) => {
        anyData += d.length
        if (id === 'ar1') standing += d
      }
    })
    const welcome = await watcher.connect()
    // A surviving daemon from an earlier run would hand back its OLD ar1 — and `run` is
    // one-shot, ignored on reattach, so the probe would never fire and the ring would never
    // fill. Fail with the reason rather than timing out on a symptom.
    const stale = welcome.filter((p) => p.id.startsWith('ar')).map((p) => p.id)
    if (stale.length) return fail('daemon already holds this gate’s panes (stale run?)', { stale })
    const spawnedA = await watcher.spawn('ar1', { cols: 100, rows: 30, run: PROBE_EVICTED })
    if (spawnedA.existing) return fail('ar1 reported existing=true on a cold spawn')

    const seeder = new DaemonClient(ep, {})
    await seeder.connect()
    await seeder.spawn('ar2', { cols: 100, rows: 30, run: PROBE_KEPT })
    await seeder.spawn('ar3', { cols: 100, rows: 30, run: PROBE_NORMAL })
    // The evicted case needs its filler actually written; the others are instant.
    const filled = await until(() => standing.length > SCROLLBACK_CHARS, 40000)
    if (!filled) {
      return fail('probe never produced enough output to evict the ring head', {
        seen: standing.length,
        anyPaneBytes: anyData,
        tail: standing.slice(-300),
        probe: PROBE_EVICTED.slice(0, 160)
      })
    }
    await delay(1000)
    seeder.dispose()

    // ── A. the field case: the alt enter has rolled off the head ─────────────────────
    const quietBefore = standing.length
    const a = await replayOf(ep, 'ar1', 100, 30)
    const hasModes = ['[?1002h', '[?1006h', '[?2004h', '[?25l', '[3;40r'].every((s) => a.includes(`\x1b${s}`))
    const entersAlt = /\x1b\[\?(?:1049|1047|47)h/.test(a)
    const clearsAfterEnter = a.indexOf('\x1b[?1049h') !== -1 && a.indexOf('\x1b[?1049h') < a.indexOf('\x1b[2J')
    if (!entersAlt) return fail('replay did not re-enter the alternate screen', { head: a.slice(0, 200) })
    if (!hasModes) return fail('replay lost the modes the session holds', { head: a.slice(0, 200) })
    if (!clearsAfterEnter) return fail('replay cleared the screen before entering the alternate buffer')
    if (a.includes('FFFFFFFFFF')) return fail('replay carried alt-screen frame bytes', { len: a.length })
    if (a.includes('ALT_MARK')) return fail('replay carried alt-screen content past the enter')
    // No history on an alternate screen means nothing to replay — the payload is a prefix.
    if (a.length > 512) return fail('alt replay is not a prefix — frames survived', { len: a.length })

    // ── D. the fix is state reconstruction, not a stimulus ───────────────────────────
    // Nothing may reach the LIVE channel: a standing subscriber hears pty output only, and
    // the probe is idle. Bytes here would be ConPTY answering a resize we should not send.
    const stimulusBytes = standing.length - quietBefore
    if (stimulusBytes !== 0) return fail('reattach put bytes on the live channel', { stimulusBytes })

    // ── B. the pre-alt prefix is real history and must survive ───────────────────────
    const b = await replayOf(ep, 'ar2', 100, 30)
    if (!b.includes('PRE_ALT_HISTORY')) return fail('replay dropped the pre-alt normal-buffer history')
    if (b.includes('ALT_MARK')) return fail('replay kept alt-screen content past the enter', { len: b.length })

    // ── C. a normal-buffer pane is replayed verbatim ─────────────────────────────────
    const c = await replayOf(ep, 'ar3', 100, 30)
    if (!c.includes('NORMAL_MARK')) return fail('a normal-buffer replay lost its ring')
    if (/\x1b\[\?(?:1049|1047|47)h/.test(c)) return fail('a normal-buffer replay synthesized an alt-screen enter')

    for (const id of ['ar1', 'ar2', 'ar3']) watcher.kill(id)
    await delay(400)
    watcher.dispose()
    clearTimeout(watchdog)
    writeOut({
      pass: true,
      evictedReplayLen: a.length,
      evictedCarriedModes: hasModes,
      keptPreAltHistory: b.includes('PRE_ALT_HISTORY'),
      normalReplayLen: c.length,
      stimulusBytes,
      ringCap: SCROLLBACK_CHARS
    })
    app.exit(0)
  } catch (err) {
    fail(String(err))
  }
}
