// The daemon's terminal multiplexer: it OWNS the node-pty processes and a per-pane
// scrollback ring buffer, and fans output out to any number of attached clients. This is
// purpose-built for the daemon (multi-client + reconnect + scrollback), which is why it
// does not reuse @backend's single-client PtyService. (ADR 0006.)
import * as os from 'node:os'
import * as pty from '@lydell/node-pty'
import type { SpawnSpec, PaneInfo, AgentState } from '@contracts'
import { OscParser } from '@backend/features/agent-state'

const SCROLLBACK_BYTES = 200_000

export interface PaneSubscriber {
  send(data: string): void
  exit(code: number): void
  state(state: AgentState): void
}

class PaneSession {
  readonly id: string
  cols: number
  rows: number
  private proc: pty.IPty
  private buffer = ''
  private lastState: AgentState = 'idle'
  private subs = new Set<PaneSubscriber>()

  constructor(id: string, spec: SpawnSpec, onExit: () => void) {
    this.id = id
    this.cols = spec.cols ?? 80
    this.rows = spec.rows ?? 24
    const isWin = process.platform === 'win32'
    const shell = spec.shell ?? (isWin ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash')
    const args = spec.args ?? (isWin ? [] : ['-l'])
    this.proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: spec.cwd ?? os.homedir(),
      env: process.env as Record<string, string>
    })
    // Parse OSC agent-state (idle/busy/attention) off the raw stream — same parser as the
    // in-proc PtyService, so the daemon path has full agent-state parity.
    const osc = new OscParser((state) => {
      this.lastState = state
      for (const s of this.subs) s.state(state)
    })
    this.proc.onData((d) => {
      this.buffer = (this.buffer + d).slice(-SCROLLBACK_BYTES)
      osc.push(d)
      for (const s of this.subs) s.send(d)
    })
    this.proc.onExit(({ exitCode }) => {
      for (const s of this.subs) s.exit(exitCode)
      this.subs.clear()
      onExit()
    })
    if (spec.run) this.proc.write(spec.run + '\r')
  }

  get scrollback(): string {
    return this.buffer
  }
  info(): PaneInfo {
    return { id: this.id, cols: this.cols, rows: this.rows }
  }
  subscribe(s: PaneSubscriber): void {
    this.subs.add(s)
    s.state(this.lastState) // replay current agent-state to a (re)attaching client
  }
  unsubscribe(s: PaneSubscriber): void {
    this.subs.delete(s)
  }
  write(data: string): void {
    this.proc.write(data)
  }
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    try {
      this.proc.resize(cols, rows)
    } catch {
      /* pane may be exiting */
    }
  }
  kill(): void {
    try {
      this.proc.kill()
    } catch {
      /* already gone */
    }
  }
}

export class SessionManager {
  private panes = new Map<string, PaneSession>()

  has(id: string): boolean {
    return this.panes.has(id)
  }
  count(): number {
    return this.panes.size
  }
  list(): PaneInfo[] {
    return [...this.panes.values()].map((p) => p.info())
  }
  get(id: string): PaneSession | undefined {
    return this.panes.get(id)
  }

  /** Spawn or return the existing pane (id-guard across the process boundary — a
   *  reconnecting client re-requesting the same id ATTACHES, never duplicates). */
  ensure(id: string, spec: SpawnSpec): { pane: PaneSession; existed: boolean } {
    const existing = this.panes.get(id)
    if (existing) return { pane: existing, existed: true }
    const pane = new PaneSession(id, spec, () => this.panes.delete(id))
    this.panes.set(id, pane)
    return { pane, existed: false }
  }

  remove(id: string): void {
    const p = this.panes.get(id)
    if (p) {
      p.kill()
      this.panes.delete(id)
    }
  }
  killAll(): void {
    for (const p of this.panes.values()) p.kill()
    this.panes.clear()
  }
}

export type { PaneSession }
