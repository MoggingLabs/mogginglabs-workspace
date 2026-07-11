// The app's client to the detached PTY daemon (ADR 0006). Lives in the app-wiring layer
// (src/main). It discovers a running daemon or spawns one via Electron-as-Node, does the
// version + auth-token handshake, and relays pane I/O. On each app launch it reconnects to
// the SAME running daemon (survival). Electron-free itself — no electron imports here.
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { createLineFramer, encodeMessage, DAEMON_PROTOCOL_VERSION, channelFromEnv, runtimeSegment } from '@contracts'
import type {
  Approval,
  Claim, ClientMessage, ServerMessage, DaemonEndpoint, SpawnSpec, PaneInfo, AgentState, SpawnResult } from '@contracts'

// --- endpoint discovery paths (MUST match src/pty-daemon/lifecycle.ts) ---
// runtimeSegment(channelFromEnv()): dev and installed releases never share a daemon, even at the
// same protocol version. The spawned daemon inherits MOGGING_CHANNEL, so it derives the SAME dir.
// Exported for daemon-migrate.ts, which scans SIBLING version dirs under the same root.
export function runtimeDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), 'Library', 'Application Support')
  return path.join(base, 'MoggingLabs', 'run', runtimeSegment(channelFromEnv()))
}
const endpointPath = (): string => path.join(runtimeDir(), 'endpoint.json')
const daemonSpawnLogPath = (): string => path.join(runtimeDir(), 'daemon.log')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
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
    if (ep && ep.version === DAEMON_PROTOCOL_VERSION && isAlive(ep.pid)) return ep
    await delay(100)
  }
  return null
}

/** Discover a running daemon or spawn one (detached, via Electron-as-Node). */
export async function ensureDaemon(daemonEntry: string): Promise<DaemonEndpoint> {
  const existing = readEndpoint()
  if (existing && existing.version === DAEMON_PROTOCOL_VERSION && isAlive(existing.pid)) return existing

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
  onCwd?: (id: string, cwd: string, gen: number) => void
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
  /** Pane id -> resolvers waiting for that pane's `spawned` reply (`existing` + the pty it got). */
  private spawnWaiters = new Map<string, Array<(res: SpawnResult) => void>>()
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
          for (const done of waiters) done({ existing: m.existing === true, restored: m.restored === true, pty: m.pty })
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
        this.events.onCwd?.(m.id, m.cwd, m.gen)
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
      case 'error':
        // surfaced via logs; a well-behaved client rarely hits this
        break
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
          const i = at.indexOf(done)
          if (i >= 0) at.splice(i, 1)
          if (!at.length) this.spawnWaiters.delete(id)
        }
        reject(new Error(`daemon did not answer spawn for pane ${id} within ${timeoutMs}ms`))
      }, timeoutMs)
      const done = (res: SpawnResult): void => {
        clearTimeout(timer)
        resolve(res)
      }
      list.push(done)
      this.send({ t: 'spawn', id, spec })
    })
  }
  attach(id: string): void {
    this.send({ t: 'attach', id })
  }
  input(id: string, data: string): void {
    this.send({ t: 'input', id, data })
  }
  /** Swarm manifest (Phase-4/01): fire-and-forget role naming. */
  setRole(id: string, role: string): void {
    this.send({ t: 'set-role', id, role })
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
  /** Reviewer gate (4/03): a removed worktree's branch loses its sign-off. */
  unapprove(branch: string): void {
    this.send({ t: 'unapprove', branch })
  }
  resize(id: string, cols: number, rows: number): void {
    this.send({ t: 'resize', id, cols, rows })
  }
  kill(id: string): void {
    this.send({ t: 'kill', id })
  }
  dispose(): void {
    this.sock?.destroy()
    this.sock = null
  }
}
