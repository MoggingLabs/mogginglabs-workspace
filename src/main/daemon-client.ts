// The app's client to the detached PTY daemon (ADR 0006). Lives in the app-wiring layer
// (src/main). It discovers a running daemon or spawns one via Electron-as-Node, does the
// version + auth-token handshake, and relays pane I/O. On each app launch it reconnects to
// the SAME running daemon (survival). Electron-free itself — no electron imports here.
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { createLineFramer, encodeMessage, DAEMON_PROTOCOL_VERSION } from '@contracts'
import { buildStampOf } from '@backend/platform/build-stamp'
import { isAlive, pipeAlive } from '@backend/platform/pid'
import { runtimeDir as sharedRuntimeDir } from '@backend/platform/runtime-paths'
import type {
  Approval,
  Claim,
  ClientMessage,
  ServerMessage,
  DaemonEndpoint,
  SpawnSpec,
  PaneInfo,
  AgentState,
  SpawnResult,
  PaneCwdLocality,
  PaneCwdSource
} from '@contracts'

// --- endpoint discovery paths ---
// THE derivation is shared with the daemon (@backend/platform/runtime-paths): dev and
// installed releases never share a daemon even at the same protocol version, because the
// spawned daemon inherits MOGGING_CHANNEL and derives the SAME dir from the SAME helper.
// Re-exported (read-only — no mkdir) for daemon-migrate/daemon-sweep/cli-runtime/mcp-endpoint,
// which scan or create SIBLING dirs under this root.
export const runtimeDir = sharedRuntimeDir
const endpointPath = (): string => path.join(runtimeDir(), 'endpoint.json')
const daemonSpawnLogPath = (): string => path.join(runtimeDir(), 'daemon.log')

/** An endpoint we may trust: our protocol version, a live pid, and a pipe still held. */
function endpointLive(ep: DaemonEndpoint | null): ep is DaemonEndpoint {
  return !!ep && ep.version === DAEMON_PROTOCOL_VERSION && isAlive(ep.pid) && pipeAlive(ep.address)
}

function readEndpoint(): DaemonEndpoint | null {
  try {
    return JSON.parse(fs.readFileSync(endpointPath(), 'utf8')) as DaemonEndpoint
  } catch {
    return null
  }
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Wait for an endpoint written by a *live* daemon of the current protocol version. */
async function waitForLiveEndpoint(timeoutMs: number): Promise<DaemonEndpoint | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ep = readEndpoint()
    if (endpointLive(ep)) return ep
    await delay(100)
  }
  return null
}

/** How long a retire waits for the daemon's pid to actually die after `shutdown` is flushed.
 *  Mirrors daemon-migrate's SHUTDOWN_WAIT_MS: the daemon persists its store and unwinds its
 *  PTYs inside this window. */
const RETIRE_WAIT_MS = 4_000
const RETIRE_CONNECT_TIMEOUT_MS = 3_000
const RETIRE_FLUSH_MS = 500

/** True once the app has deliberately taken its own daemon down (an update is about to run
 *  the installer). From that moment `ensureDaemon` REFUSES to spawn: the relay's reconnect
 *  loop reacts to the daemon's death within milliseconds, and a resurrected daemon — running
 *  from the installed exe — would re-take the very file lock the retire just released. */
let quiescing = false
export function beginDaemonQuiescence(): void {
  quiescing = true
}

/**
 * Gracefully retire the daemon behind an endpoint: handshake as a client (its OWN version +
 * token — we are its guest), send `shutdown`, and wait for the pid to actually die. The
 * daemon's shutdown path calls persistNow() before exiting, so this is LOSSLESS: the fresh
 * spawn that follows cold-start restores every pane from the store this flush just wrote.
 * The `shutdown` frame is settled on the WRITE CALLBACK, not fire-and-forget —
 * socket.destroy() discards queued writes, and a dropped shutdown is a daemon that quietly
 * survives its own retirement (daemon-migrate learned this the hard way).
 *
 * Returns true when the pid is verifiably gone. False means the daemon is still running —
 * callers must degrade (keep using it / proceed and let the installer complain), never hang.
 */
export async function retireDaemonEndpoint(ep: DaemonEndpoint): Promise<boolean> {
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      try {
        sock.destroy()
      } catch {
        /* already gone */
      }
      resolve()
    }
    const sock = net.connect(ep.address)
    sock.setEncoding('utf8')
    const connectTimer = setTimeout(finish, RETIRE_CONNECT_TIMEOUT_MS)
    const framer = createLineFramer((obj) => {
      const m = obj as { t?: string }
      if (m.t === 'welcome') {
        try {
          sock.write(JSON.stringify({ t: 'shutdown' }) + '\n', () => setTimeout(finish, 50))
        } catch {
          finish()
        }
        setTimeout(finish, RETIRE_FLUSH_MS)
      } else if (m.t === 'error') {
        finish() // auth refused — not ours to touch
      }
    })
    sock.on('data', (chunk: string) => framer(chunk))
    sock.on('error', finish)
    sock.on('close', finish)
    sock.on('connect', () => {
      try {
        sock.write(JSON.stringify({ t: 'hello', v: ep.version, token: ep.token }) + '\n')
      } catch {
        finish()
      }
    })
  })
  const waitUntil = Date.now() + RETIRE_WAIT_MS
  while (isAlive(ep.pid) && Date.now() < waitUntil) await delay(100)
  return !isAlive(ep.pid)
}

/**
 * Retire OUR OWN live daemon — the pre-install step. The daemon runs from the installed
 * executable and, being a process, holds a Windows file lock on it: an installer that runs
 * while it lives ends in "MoggingLabs Workspace cannot be closed. Please close it manually
 * and click Retry" — against a windowless process no user can see. Shutdown persists the
 * store, so the post-update boot restores every pane; `quiesce` stops the reconnect loop
 * from resurrecting it in the moments between this call and process exit.
 */
export async function retireOwnDaemon(opts: { quiesce: boolean }): Promise<boolean> {
  if (opts.quiesce) quiescing = true
  const ep = readEndpoint()
  if (!endpointLive(ep)) return true // nothing running — nothing locks the exe
  return retireDaemonEndpoint(ep)
}

/** Discover a running daemon or spawn one (detached, via Electron-as-Node). */
export async function ensureDaemon(daemonEntry: string): Promise<DaemonEndpoint> {
  if (quiescing) throw new Error('daemon is quiescing for an update — refusing to spawn')
  const existing = readEndpoint()
  if (endpointLive(existing)) {
    // THE BUILD-STAMP CHECK. The endpoint is live and speaks our protocol — but is it running
    // our CODE? The daemon outlives the app (ADR 0006), so after an update this reconnect
    // would otherwise hand every pane to a process still executing last release's daemon:
    // same wire, stale behaviour, and nothing anywhere would fail. (v0.11.1's tracker fix
    // shipped exactly that way — it changed no wire, so only a burned protocol version
    // delivered it. The stamp is that lesson, made structural.)
    //
    // A missing recorded stamp reads as stale — daemons predating the stamp are by
    // definition old code. A missing EXPECTED stamp (we cannot read our own bundle) reads
    // as "no opinion": never retire on a question we cannot answer.
    const expected = buildStampOf(daemonEntry)
    if (!expected || existing.build === expected) return existing
    console.warn(
      `[daemon] live daemon is a different build (have ${existing.build ?? 'none'}, want ${expected}) — retiring in place`
    )
    const retired = await retireDaemonEndpoint(existing)
    if (!retired) {
      // It would not die. A stale-but-working daemon beats a boot with no terminals at all;
      // the next launch (or the update's own retire) gets another chance.
      console.warn('[daemon] stale-build daemon did not retire; continuing against it')
      return existing
    }
    // Fall through: the endpoint below is now stale by construction and gets unlinked.
  }
  // A stale endpoint must not survive this call. Left in place it poisons every retry:
  // waitForLiveEndpoint below re-reads it and "succeeds" against a daemon that isn't there,
  // and the relay's reconnect loop (which re-runs discovery each attempt) dials the same
  // dead address forever instead of spawning a fresh daemon. Only ever unlinked when it
  // failed endpointLive — a live daemon's endpoint is never touched.
  if (existing) {
    try {
      fs.unlinkSync(endpointPath())
    } catch {
      /* already gone */
    }
  }

  fs.mkdirSync(runtimeDir(), { recursive: true })
  const logFd = fs.openSync(daemonSpawnLogPath(), 'a')
  // process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE makes it a plain Node.
  const child = spawn(process.execPath, [daemonEntry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true
  })
  child.unref()

  const ep = await waitForLiveEndpoint(15000)
  if (!ep) throw new Error('pty daemon did not become ready')
  return ep
}

export interface DaemonEvents {
  /** A pane's CURRENT session generation, learned from a `spawned`/`attached` reply —
   *  fired BEFORE that reply's scrollback replay, so a consumer that gates events on
   *  (id, gen) accepts the replay itself. Pane ids are reused; gens are not (v5). */
  onGen?: (id: string, gen: number) => void
  /** Pane output (also delivers scrollback on (re)attach, for repaint). */
  onData?: (id: string, data: string, gen: number) => void
  onExit?: (id: string, code: number, gen: number) => void
  onState?: (id: string, state: AgentState, gen: number) => void
  /** A pane's OSC-7 cwd (also replayed on (re)attach) — feeds per-pane git (2/03). */
  onCwd?: (
    id: string,
    cwd: string,
    gen: number,
    revision: number,
    source: PaneCwdSource,
    locality: PaneCwdLocality
  ) => void
  /** Panes the daemon already had when we connected (reconnect => reattach these). */
  onWelcome?: (panes: PaneInfo[]) => void
  /** Ownership-ledger snapshot — replies AND unsolicited pushes on change (4/02). */
  onOwners?: (claims: Claim[]) => void
  /** A pane's agent reported a usage limit (4/04 failover). */
  onLimit?: (id: string, gen: number) => void
  /** TYPED-LAUNCH DETECTION: an agent CLI process appeared in / left this pane's PTY subtree
   *  (`agentId` null = gone). Also REPLAYED on (re)attach, which is how a restarted app
   *  re-learns the identity of an agent the daemon kept alive but the app never launched. */
  onAgent?: (id: string, agentId: string | null, cwd: string | undefined, sinceMs: number | undefined, gen: number) => void
  /** Reviewer-gate sign-off list — replies AND pushes on change (4/03 polish). */
  onApprovals?: (list: Approval[]) => void
  onClose?: () => void
}

export class DaemonClient {
  private sock: net.Socket | null = null
  private approvalWaiters: Array<(list: Approval[]) => void> = []
  private roleWaiters = new Map<string, Array<(ok: boolean) => void>>()
  private paneVerifyWaiters = new Map<number, (valid: boolean) => void>()
  private nextVerifyRequestId = 1
  /** Pane id -> resolvers waiting for that pane's `spawned` reply (`existing` + the pty it got). */
  private spawnWaiters = new Map<
    string,
    Array<{ resolve: (res: SpawnResult) => void; reject: (err: Error) => void }>
  >()
  constructor(
    private readonly endpoint: DaemonEndpoint,
    private readonly events: DaemonEvents = {}
  ) {}

  /** Connect + handshake. Resolves with the daemon's existing panes (from `welcome`). */
  connect(): Promise<PaneInfo[]> {
    return new Promise<PaneInfo[]>((resolve, reject) => {
      const sock = net.connect(this.endpoint.address)
      this.sock = sock
      sock.setEncoding('utf8')
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      // Never hang: if the daemon doesn't welcome us, fail fast so callers can recover.
      const timer = setTimeout(() => settle(() => reject(new Error('daemon welcome timeout'))), 8000)
      const framer = createLineFramer((obj) =>
        this.dispatch(obj as ServerMessage, (panes) => settle(() => resolve(panes)))
      )
      sock.on('data', (chunk: string) => framer(chunk))
      sock.on('error', (e) => settle(() => reject(e)))
      sock.on('close', () => {
        this.sock = null
        settle(() => reject(new Error('daemon closed before welcome')))
        this.events.onClose?.()
      })
      sock.on('connect', () => {
        sock.write(encodeMessage({ t: 'hello', v: DAEMON_PROTOCOL_VERSION, token: this.endpoint.token }))
      })
    })
  }

  private dispatch(m: ServerMessage, onWelcome: (panes: PaneInfo[]) => void): void {
    switch (m.t) {
      case 'welcome':
        this.events.onWelcome?.(m.panes)
        onWelcome(m.panes)
        break
      case 'data':
        this.events.onData?.(m.id, m.data, m.gen)
        break
      case 'spawned': {
        // Gen FIRST: consumers gate every pane event on (id, gen), and the scrollback
        // replay below must be accepted by the generation it belongs to.
        this.events.onGen?.(m.id, m.gen)
        if (m.scrollback) this.events.onData?.(m.id, m.scrollback, m.gen)
        // `existing` is how a caller learns the daemon reattached us to a session that
        // was already running (it is detached — ADR 0006). Nothing else can tell them.
        const waiters = this.spawnWaiters.get(m.id)
        if (waiters) {
          this.spawnWaiters.delete(m.id)
          for (const waiter of waiters) {
            waiter.resolve({ existing: m.existing === true, restored: m.restored === true, pty: m.pty })
          }
        }
        break
      }
      case 'attached':
        this.events.onGen?.(m.id, m.gen)
        if (m.scrollback) this.events.onData?.(m.id, m.scrollback, m.gen)
        break
      case 'exit':
        this.events.onExit?.(m.id, m.code, m.gen)
        break
      case 'state':
        this.events.onState?.(m.id, m.state, m.gen)
        break
      case 'cwd':
        this.events.onCwd?.(m.id, m.cwd, m.gen, m.rev, m.source, m.locality)
        break
      case 'owners':
        this.events.onOwners?.(m.claims)
        break
      case 'limit':
        this.events.onLimit?.(m.id, m.gen)
        break
      case 'agent':
        this.events.onAgent?.(m.id, m.agentId, m.cwd, m.sinceMs, m.gen)
        break
      case 'approvals': {
        const waiter = this.approvalWaiters.shift()
        waiter?.(m.list)
        this.events.onApprovals?.(m.list)
        break
      }
      case 'pane-verified': {
        const done = this.paneVerifyWaiters.get(m.requestId)
        if (done) {
          this.paneVerifyWaiters.delete(m.requestId)
          done(m.valid === true)
        }
        break
      }
      case 'role-set': {
        const waiters = this.roleWaiters.get(m.id)
        const done = waiters?.shift()
        if (waiters && !waiters.length) this.roleWaiters.delete(m.id)
        done?.(m.ok === true)
        break
      }
      case 'error': {
        // Pane-scoped rejections fail the pending spawn; the rest are surfaced via logs.
        const waiters = m.id ? this.spawnWaiters.get(m.id) : undefined
        if (m.id && waiters) {
          this.spawnWaiters.delete(m.id)
          for (const waiter of waiters) waiter.reject(new Error(`daemon rejected pane ${m.id}: ${m.reason}`))
        }
        break
      }
    }
  }

  private send(m: ClientMessage): void {
    try {
      this.sock?.write(encodeMessage(m))
    } catch {
      /* peer gone; caller will reconnect */
    }
  }

  /** Spawn (or reattach to) a pane's session. Resolves with the daemon's `existing` flag:
   *  true = a live session was already there. Resolves false if the daemon never answers
   *  within the timeout — the safe default, matching a cold spawn. */
  /** Resolves with the daemon's own answer. REJECTS on timeout: a pane whose pty never reported
   *  its emulation cannot be rendered correctly, and `resolve(false)` used to invent one. */
  spawn(id: string, spec?: SpawnSpec, timeoutMs = 5000): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve, reject) => {
      const list = this.spawnWaiters.get(id) ?? []
      this.spawnWaiters.set(id, list)
      const timer = setTimeout(() => {
        const at = this.spawnWaiters.get(id)
        if (at) {
          const i = at.indexOf(waiter)
          if (i >= 0) at.splice(i, 1)
          if (!at.length) this.spawnWaiters.delete(id)
        }
        reject(new Error(`daemon did not answer spawn for pane ${id} within ${timeoutMs}ms`))
      }, timeoutMs)
      const waiter = {
        resolve: (res: SpawnResult): void => {
          clearTimeout(timer)
          resolve(res)
        },
        reject: (err: Error): void => {
          clearTimeout(timer)
          reject(err)
        }
      }
      list.push(waiter)
      this.send({ t: 'spawn', id, spec })
    })
  }
  attach(id: string): void {
    this.send({ t: 'attach', id })
  }
  input(id: string, data: string): void {
    this.send({ t: 'input', id, data })
  }
  /** Swarm manifest (Phase-4/01): acknowledged role naming. */
  setRole(id: string, role: string, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      const timer = setTimeout(() => {
        const list = this.roleWaiters.get(id)
        if (list) {
          const at = list.indexOf(done)
          if (at >= 0) list.splice(at, 1)
          if (!list.length) this.roleWaiters.delete(id)
        }
        done(false)
      }, timeoutMs)
      const list = this.roleWaiters.get(id) ?? []
      list.push(done)
      this.roleWaiters.set(id, list)
      this.send({ t: 'set-role', id, role })
    })
  }
  /** House notify (8/03 receipts ride it): raise a pane's attention with a
   *  short label — the same closed verb `mogging notify` uses, never content. */
  notify(id: string, event: string, message?: string): void {
    this.send({ t: 'notify', id, event, message })
  }
  /** Ownership ledger (4/02): ask for the current claim set (pushes follow). */
  requestOwners(): void {
    this.send({ t: 'owners' })
  }
  /** Reviewer gate (4/03): the live sign-off list (empty on timeout/disconnect —
   *  fail CLOSED: no reachable daemon means no approvals). */
  queryApprovals(timeoutMs = 3000): Promise<Approval[]> {
    return new Promise((resolveQ) => {
      let settled = false
      const finish = (list: Approval[]): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveQ(list)
      }
      const timer = setTimeout(() => {
        this.approvalWaiters = this.approvalWaiters.filter((w) => w !== finish)
        finish([])
      }, timeoutMs)
      this.approvalWaiters.push(finish)
      this.send({ t: 'approvals' })
    })
  }
  /** Validate a pane capability without ever disclosing the daemon's stored token. */
  verifyPaneToken(id: string, token: string, timeoutMs = 2000): Promise<boolean> {
    if (!id || !token) return Promise.resolve(false)
    const requestId = this.nextVerifyRequestId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.paneVerifyWaiters.delete(requestId)
        resolve(false)
      }, timeoutMs)
      this.paneVerifyWaiters.set(requestId, (valid) => {
        clearTimeout(timer)
        resolve(valid)
      })
      this.send({ t: 'verify-pane', requestId, id, token })
    })
  }
  /** Reviewer gate (4/03): a removed worktree's branch loses its sign-off. */
  unapprove(repoId: string, branch: string): void {
    this.send({ t: 'unapprove', repoId, branch })
  }
  resize(id: string, cols: number, rows: number): void {
    this.send({ t: 'resize', id, cols, rows })
  }
  kill(id: string): void {
    this.send({ t: 'kill', id })
  }
  /** Graceful daemon restart hook (maintenance/smokes): persistence and endpoint cleanup run. */
  shutdown(): void {
    const sock = this.sock
    if (!sock) return
    try {
      // Do not depend on the server process exiting quickly enough to close our side of the
      // connection. Once the request is in the kernel, closing this socket deterministically
      // drives the relay's existing onClose -> reconnect loop.
      sock.write(encodeMessage({ t: 'shutdown' }), () => {
        if (this.sock === sock) sock.destroy()
      })
    } catch {
      sock.destroy()
    }
  }
  dispose(): void {
    // Settle EVERY pending waiter now, not just the role ones. Each class of waiter has
    // its own timeout so nothing leaked, but a disposed client whose spawn callers sat
    // out a 5s timer while the role callers answered instantly was two teardown stories
    // where one suffices — and a caller told "false/[]/rejected" immediately can react
    // (the relay's reconnect replay) instead of stalling on a socket that is gone.
    for (const waiters of this.roleWaiters.values()) for (const done of waiters) done(false)
    this.roleWaiters.clear()
    for (const waiters of this.spawnWaiters.values()) {
      for (const waiter of waiters) waiter.reject(new Error('daemon client disposed'))
    }
    this.spawnWaiters.clear()
    for (const finish of this.approvalWaiters.splice(0)) finish([])
    for (const done of this.paneVerifyWaiters.values()) done(false)
    this.paneVerifyWaiters.clear()
    this.sock?.destroy()
    this.sock = null
  }
}
