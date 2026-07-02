// The app's client to the detached PTY daemon (ADR 0006). Lives in the app-wiring layer
// (src/main). It discovers a running daemon or spawns one via Electron-as-Node, does the
// version + auth-token handshake, and relays pane I/O. On each app launch it reconnects to
// the SAME running daemon (survival). Electron-free itself — no electron imports here.
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { createLineFramer, encodeMessage, DAEMON_PROTOCOL_VERSION } from '@contracts'
import type { ClientMessage, ServerMessage, DaemonEndpoint, SpawnSpec, PaneInfo, AgentState } from '@contracts'

// --- endpoint discovery paths (MUST match src/pty-daemon/lifecycle.ts) ---
function runtimeDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), 'Library', 'Application Support')
  return path.join(base, 'MoggingLabs', 'run', 'v' + DAEMON_PROTOCOL_VERSION)
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
  /** Pane output (also delivers scrollback on (re)attach, for repaint). */
  onData?: (id: string, data: string) => void
  onExit?: (id: string, code: number) => void
  onState?: (id: string, state: AgentState) => void
  /** A pane's OSC-7 cwd (also replayed on (re)attach) — feeds per-pane git (2/03). */
  onCwd?: (id: string, cwd: string) => void
  /** Panes the daemon already had when we connected (reconnect => reattach these). */
  onWelcome?: (panes: PaneInfo[]) => void
  onClose?: () => void
}

export class DaemonClient {
  private sock: net.Socket | null = null
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
        this.events.onData?.(m.id, m.data)
        break
      case 'spawned':
      case 'attached':
        if (m.scrollback) this.events.onData?.(m.id, m.scrollback)
        break
      case 'exit':
        this.events.onExit?.(m.id, m.code)
        break
      case 'state':
        this.events.onState?.(m.id, m.state)
        break
      case 'cwd':
        this.events.onCwd?.(m.id, m.cwd)
        break
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

  spawn(id: string, spec?: SpawnSpec): void {
    this.send({ t: 'spawn', id, spec })
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
