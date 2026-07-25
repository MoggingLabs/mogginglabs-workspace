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
//   D. A PANE SPAWN THAT CANNOT START IS ANSWERED   an `ensure()` that throws must come back
//      as a named refusal the client can act on. Unguarded it unwound the socket's data pump,
//      which costs the rest of that chunk's frames AND tells the asker nothing.
//   E. A DAEMON SPAWN THAT CANNOT START REJECTS   the same claim for the daemon process itself:
//      a dead helper executable must reject, never re-throw an 'error' event into fatal().
//   F. A FAILED SPAWN LEAVES NO REPLAY SPEC   the relay records each pane's spec BEFORE the
//      reply, so a spawn that lands in a DYING daemon still comes back on the next reconnect.
//      When that spawn FAILS outright the renderer buries the pane instead — "[terminal failed
//      to start]", marked dead, every keystroke gated — so a spec left behind is a session the
//      next reconnect spawns for REAL (for a remote pane, a real ssh with a live auth attempt),
//      painting its prompt underneath a dead banner only restart() can clear. Driven through
//      the TerminalChannels.spawn ipcMain handler: the ONLY door that writes that map.
//   G. A QUIESCE DECLARED MID-FLIGHT IS OBEYED   B inverted. B quiesces and THEN kills; here the
//      daemon dies first and the quiesce lands after ensureDaemon has already committed to a
//      spawn. `quiescing` was read once at entry with ~25s of awaits behind it, so an updater's
//      quiesce declared mid-flight still seated a daemon — one running from the INSTALLED exe,
//      re-taking the very file lock the pre-install retire had just released: the NSIS "cannot
//      be closed. Please close it manually and click Retry" stall this machinery exists to
//      prevent, reported by retireOwnDaemon as "nothing running — nothing locks the exe".
// (F and G run between D and the cleanup; E stays last — it needs the retire behind it.)
//
// Windowless on purpose: the relay takes a WebContents GETTER and tolerates null (renderer
// events are simply unsent), and daemon health is read straight off runtime-health's state.
import { app, ipcMain } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isAlive } from '@backend/platform/pid'
import { TerminalChannels } from '@contracts'
import { beginDaemonQuiescence, endDaemonQuiescence, ensureDaemon, retireOwnDaemon, DaemonClient } from '../daemon-client'
import { startDaemonBackend, getDaemonClient } from '../daemon-relay'
import { daemonEntryPath } from '../node-helper'
import { getDaemonHealth } from '../runtime-health'
import type { DaemonEndpoint, SpawnRequest } from '@contracts'

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

/** How many times `event` has been journaled so far — the loop's own progress, read from the
 *  side. Act G waits on 'daemon-spawning' rather than sleeping a guessed number of ms. */
const journalCount = (event: string): number => readClientLog().split(event).length - 1

type InvokeDoor = (event: unknown, ...args: unknown[]) => unknown

/** THE spawn door: the TerminalChannels.spawn ipcMain handler, registered by the relay.
 *  Act F must go through THIS and nothing else — it is the only code in the app that records
 *  a pane's reconnect-replay spec, and every other act reaches the daemon via
 *  getDaemonClient().spawn(), which bypasses the whole bookkeeping under test.
 *
 *  A windowless smoke has no renderer to `invoke` with, so the handler is fetched from where
 *  `ipcMain.handle` files it: the private `_invokeHandlers` map, keyed by channel, holding a
 *  wrapper that answers through the invoke event's `_reply`/`_throw`. Nothing here is
 *  production wiring — no seam is added to the relay for it — and if Electron ever moves that
 *  map the door simply is not found, which act F reports as a FAILED flag (`replayDoorFound`)
 *  rather than quietly turning into a vacuous pass. */
function spawnDoor(): InvokeDoor | null {
  const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeDoor> })._invokeHandlers
  return handlers?.get(TerminalChannels.spawn) ?? null
}

/** Drive the door and report ITS answer — resolved value or the message it threw. */
function driveSpawnDoor(door: InvokeDoor, req: SpawnRequest): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let settled = false
    const say = (e: unknown): string => (e instanceof Error ? e.message : String(e))
    const settle = (ok: boolean, detail: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, detail })
    }
    const timer = setTimeout(() => settle(false, 'TIMEOUT: the spawn door never answered'), 20_000)
    try {
      const returned = door(
        {
          _reply: (value: unknown): void => settle(true, 'RESOLVED ' + JSON.stringify(value ?? null)),
          _throw: (err: unknown): void => settle(false, say(err))
        },
        req
      )
      // Belt and braces: today `handle` wraps the listener and answers through _reply/_throw
      // above, and the wrapper's own promise resolves a microtask later (already settled). An
      // Electron that filed the listener RAW would answer through this promise instead —
      // whichever speaks FIRST is the answer, so the act survives either shape.
      void Promise.resolve(returned).then(
        (value) => settle(true, 'RESOLVED ' + JSON.stringify(value ?? null)),
        (err) => settle(false, say(err))
      )
    } catch (e) {
      settle(false, say(e))
    }
  })
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
  // Testimony, not an assertion: `r` is boolean-only (the verdict is `every(v === true)`), so
  // the refusal STRING that act D read rides alongside it in the result file.
  let spawnRefusal = ''
  let replayAnswer = ''
  // Act F's pane id, minted per RUN. The daemon RESTORES persisted panes at cold start
  // (SessionManager.restore), so a fixed id would let a session a PRE-FIX run left in
  // sessions.db reappear in a later run's welcome and read as this run's resurrection.
  const replayPaneId = 9000 + (Date.now() % 900)
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

    // ── D. a pane spawn that CANNOT start must be ANSWERED, not swallowed ────────────────
    // The daemon-process twin of act E, one level down. `ensure()` throws for real causes (the
    // persisted shell is gone, ConPTY refuses, the cwd is unmounted) and the throw unwinds
    // through the socket's data pump: the daemon survives on uncaughtException, but the framer
    // has already advanced past this chunk's other frames and the asking client is told
    // NOTHING — it falls to its own 5s timeout for a pane the daemon decided about instantly.
    // The seam (MOGGING_DAEMON_SPAWN_FAIL_ID, inert unless it names this exact id) makes a real
    // throw drivable; the assertion reads WHICH error came back, so it does not rest on timing.
    {
      const client = getDaemonClient()
      const probeId = 'spawnfail-probe'
      let refusal = ''
      try {
        if (!client) throw new Error('no daemon client after heal')
        await client.spawn(probeId, { cwd: os.homedir() }, 4000)
        refusal = 'RESOLVED — the armed spawn did not fail at all'
      } catch (e) {
        refusal = e instanceof Error ? e.message : String(e)
      }
      // The seam has to be ARMED for any of this to mean anything (a gate that silently lost
      // its env would otherwise read as a pass).
      r.spawnFailArmed = process.env.MOGGING_DAEMON_SPAWN_FAIL_ID === probeId
      // The named refusal IS the claim: pre-fix the client can only report its own silence.
      r.spawnFailureAnswered = /spawnfailed/.test(refusal)
      r.spawnFailureNotSilence = !/did not answer/.test(refusal)
      spawnRefusal = refusal
    }

    // ── F. a spawn that failed with the daemon ABSENT must leave nothing to replay ───────
    // The spec is recorded BEFORE the reply on purpose (a spawn into a dying daemon must still
    // come back), so the ONLY thing standing between a FAILED spawn and a resurrected session
    // is the handler's own withdrawal on the error path — the same `specs.delete` the kill
    // handler does, for the same reason ("closed on purpose — never resurrected by a reconnect
    // replay"). Quiescence is the clamp that makes the sequence deterministic: with it latched
    // nothing can heal while the spawn is in flight, so the failure is decided BEFORE the
    // reconnect that would replay it — otherwise a heal racing the 5s spawn timeout replays the
    // spec while it is still legitimately present and the act would prove nothing.
    {
      const door = spawnDoor()
      r.replayDoorFound = !!door
      if (!door) throw new Error('no TerminalChannels.spawn handler registered — cannot reach the spec door')
      const epBefore = readEndpoint()
      if (!epBefore || !isAlive(epBefore.pid)) throw new Error('no live daemon at the start of act F')
      beginDaemonQuiescence()
      process.kill(epBefore.pid)
      const deadBy = Date.now() + 5000
      while (getDaemonHealth().state === 'connected' && Date.now() < deadBy) await delay(50)
      r.replaySawDeadDaemon = getDaemonHealth().state !== 'connected'
      const answer = await driveSpawnDoor(door, { id: replayPaneId, cwd: os.homedir(), cols: 80, rows: 24 })
      replayAnswer = answer.detail
      // WHICH failure matters: the refusal must be the daemon's silence (the client's own spawn
      // timeout), which can only be reached AFTER the spec was recorded. A rejection thrown
      // earlier — a bad remote host, an invalid remote cwd — never reaches `specs.set` at all,
      // and would make everything below true without exercising the withdrawal.
      r.replaySpawnRefused = !answer.ok && /did not answer spawn/.test(answer.detail)
      endDaemonQuiescence()
      const epHealed = await waitHealed(epBefore.pid, 30_000)
      r.replayHealed = !!epHealed
      if (!epHealed) throw new Error('relay did not heal after the failed spawn')
      // The relay's own count, journaled at the moment it replays: 'daemon-reconnected {panes:N}'.
      const reconnects = readClientLog().split('\n').filter((l) => l.includes('daemon-reconnected'))
      r.replayedNothing = /"panes":0/.test(reconnects[reconnects.length - 1] ?? '')
      // THE claim, end to end: ask the healed daemon itself. `welcome` lists every session it
      // holds, so a replayed spec shows up here as a REAL pane — the prompt that would be
      // painting under the renderer's dead banner. Sampled a few times because the replay is
      // dispatched (not awaited) just before health flips to 'connected'.
      let welcomeReads = 0
      let resurrectedPane = false
      for (let i = 0; i < 3 && !resurrectedPane; i++) {
        if (i > 0) await delay(700)
        const probe = new DaemonClient(epHealed, {}, { kind: 'daemonheal-welcome', heartbeatMs: 0 })
        try {
          const panes = await probe.connect()
          welcomeReads++
          if (panes.some((p) => p.id === String(replayPaneId))) resurrectedPane = true
        } catch {
          /* a refused sample proves nothing either way — `replayWelcomeRead` is the guard */
        }
        probe.dispose()
      }
      r.replayWelcomeRead = welcomeReads > 0
      r.replayNoSessionResurrected = !resurrectedPane
    }

    // ── G. a quiesce declared MID-FLIGHT must not seat a daemon ──────────────────────────
    // B's inversion, and the half of quiescence B cannot see: B latches BEFORE the death, so
    // the entry check alone answers it. Here the loop is already past that check and inside
    // ensureDaemon's spawn when the updater declares the quiesce — the window that was ~25s
    // wide (reach probe, other-clients probe, stamp retire, spawn + a 15s readiness wait) and
    // read exactly once. 'daemon-spawning' is journaled BETWEEN the child spawn and the
    // readiness wait, so waiting for a FRESH one puts the quiesce provably mid-flight: a
    // guessed sleep that landed early would be answered by the entry check and pass either way.
    {
      const epLive = readEndpoint()
      if (!epLive || !isAlive(epLive.pid)) throw new Error('no live daemon at the start of act G')
      const spawnsBefore = journalCount('daemon-spawning')
      process.kill(epLive.pid)
      const committedBy = Date.now() + 10_000
      while (journalCount('daemon-spawning') === spawnsBefore && Date.now() < committedBy) await delay(25)
      r.midFlightCaughtInSpawn = journalCount('daemon-spawning') > spawnsBefore
      beginDaemonQuiescence()
      // Health is the observable, NOT a live pid: post-fix the daemon this spawn seated does
      // exist for a moment before it is retired — that is the fix WORKING (retire what we just
      // seated rather than hand it back). What must never happen is the relay taking it into
      // service, which is the resurrection the installer trips over.
      const windowUntil = Date.now() + 8000
      let resurrections = 0
      while (Date.now() < windowUntil) {
        if (getDaemonHealth().state === 'connected') resurrections++
        await delay(200)
      }
      r.midFlightNotResurrected = resurrections === 0
      // Which check refused it: the LATE one, past the readiness wait. A quiesce answered by
      // the entry check journals 'daemon-reconnect-failed … quiescing' and nothing else — so
      // this line is also the proof the act landed mid-flight rather than early. POLLED, not
      // sampled once: the daemon's readiness is the machine's business, not the claim's.
      const lateRetire = /quiesce-retire-late-spawn/
      const retiredBy = Date.now() + 8000
      while (!lateRetire.test(readClientLog()) && Date.now() < retiredBy) await delay(200)
      r.midFlightLateSpawnRetired = lateRetire.test(readClientLog())
      // And nothing may be LEFT running: a live daemon still holds the exe the installer is
      // about to overwrite, which is the entire point of the pre-install retire.
      const goneBy = Date.now() + 8000
      let left = readEndpoint()
      while (left && isAlive(left.pid) && Date.now() < goneBy) {
        await delay(200)
        left = readEndpoint()
      }
      r.midFlightNoDaemonLeft = !(left && isAlive(left.pid))
    }

    // ── Cleanup: stop the loop FIRST, then prove the last daemon dead ────────────────────
    dispose()
    dispose = null
    if (ep3) {
      const retired = await retireOwnDaemon({ quiesce: true })
      const until = Date.now() + 5000
      while (isAlive(ep3.pid) && Date.now() < until) await delay(100)
      r.cleanedUp = retired && !isAlive(ep3.pid)
    }

    // ── E. a DAEMON spawn that cannot start must reject, never take the app down ─────────
    // `spawn` reports a missing/unopenable executable asynchronously via an 'error' event,
    // and an 'error' with no listener is re-thrown by EventEmitter — straight into boot.ts's
    // uncaughtException -> fatal() -> app.exit(1). The reachable causes are all background
    // ones (antivirus quarantining the unsigned helper, an installer swapping it, a dev
    // `rm -rf build/node-helper`), so the whole window vanished mid-session because a
    // RECONNECT could not find a binary. If this act regresses, the gate does not fail —
    // the app exits and the verdict reads MISSING, which is itself the tell.
    {
      // A REAL entry with a DEAD executable: passing a bogus entry too made ensureDaemon
      // refuse before it ever reached the spawn, so the 'error' path went unexercised and
      // the assertion could not bite (caught by sabotaging the fix and watching this pass).
      const gone = path.join(app.getPath('temp'), 'mogging-no-such-helper-5591.exe')
      let rejected = false
      try {
        await ensureDaemon(daemonEntryPath(), { executable: gone, nativesDir: path.dirname(gone) })
      } catch {
        rejected = true // the built-in answer: a caught rejection the caller can back off on
      }
      // Surviving to WRITE a verdict is the other half of the proof: the pre-fix bytes
      // never reach the write at all, so the gate reads MISSING rather than FAIL.
      r.deadHelperRejects = rejected
    }

    const pass = Object.entries(r).every(([, v]) => v === true)
    write({ pass, ...r, spawnRefusal, replayAnswer, replayPaneId })
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
