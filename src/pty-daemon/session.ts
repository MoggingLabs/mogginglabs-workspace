// The daemon's terminal multiplexer: it OWNS the node-pty processes and a per-pane
// scrollback ring buffer, and fans output out to any number of attached clients. This is
// purpose-built for the daemon (multi-client + reconnect + scrollback), which is why it
// does not reuse @backend's single-client PtyService. (ADR 0006.)
//
// It also PERSISTS sessions (cwd + command label + scrollback) to a small store, so the
// daemon self-recovers on a cold start / crash and repaints prior scrollback (Phase-1/03).
import * as os from 'node:os'
import * as pty from '@lydell/node-pty'
import type { SpawnSpec, PaneInfo, AgentState } from '@contracts'
import { OscParser } from '@backend/features/agent-state'
import { SessionStore, resumeCommandFor } from '@backend/features/workspace'
import type { PersistedPane, PersistedWorkspace, WorkspaceLayout } from '@contracts'

const SCROLLBACK_BYTES = 200_000

export interface PaneSubscriber {
  send(data: string): void
  exit(code: number): void
  state(state: AgentState): void
}

interface PaneHooks {
  onExit: () => void
  onChange: () => void
}

class PaneSession {
  readonly id: string
  readonly cwd: string
  readonly command?: string
  cols: number
  rows: number
  private proc: pty.IPty
  private buffer = ''
  private lastState: AgentState = 'idle'
  private subs = new Set<PaneSubscriber>()

  constructor(id: string, spec: SpawnSpec, hooks: PaneHooks, restore?: { scrollback: string; resumeCommand?: string | null }) {
    this.id = id
    this.cols = spec.cols ?? 80
    this.rows = spec.rows ?? 24
    this.cwd = spec.cwd ?? os.homedir()
    this.command = spec.run
    if (restore?.scrollback) this.buffer = restore.scrollback // seed prior output for repaint

    const isWin = process.platform === 'win32'
    const shell = spec.shell ?? (isWin ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash')
    const args = spec.args ?? (isWin ? [] : ['-l'])
    this.proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
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
      hooks.onChange()
    })
    this.proc.onExit(({ exitCode }) => {
      for (const s of this.subs) s.exit(exitCode)
      this.subs.clear()
      hooks.onExit()
    })
    // Fresh panes run their launch command. RESTORED panes repaint prior scrollback in a fresh
    // shell at the same cwd, and relaunch a known agent via its own resume (step 4) — never a
    // frozen process; a pane with no resumable agent just restores its shell.
    if (spec.run && !restore) this.proc.write(spec.run + '\r')
    else if (restore?.resumeCommand) this.proc.write(restore.resumeCommand + '\r')
  }

  get scrollback(): string {
    return this.buffer
  }
  info(): PaneInfo {
    return { id: this.id, cols: this.cols, rows: this.rows }
  }
  snapshot(): PersistedPane {
    return {
      id: this.id,
      workspaceId: 'default',
      cwd: this.cwd,
      command: this.command,
      scrollback: this.buffer,
      updatedAt: Date.now()
    }
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
  private persistTimer?: NodeJS.Timeout

  constructor(private readonly store: SessionStore) {}

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
  snapshotAll(): PersistedPane[] {
    return [...this.panes.values()].map((p) => p.snapshot())
  }

  /** The current single default workspace + its (flat) layout. Steps 04/05 add real
   *  workspaces + a split tree; this persists the pane arrangement that exists today. */
  workspaces(): PersistedWorkspace[] {
    const layout: WorkspaceLayout = { v: 1, panes: [...this.panes.keys()] }
    return [{ id: 'default', name: 'Workspace', layout: JSON.stringify(layout), updatedAt: Date.now() }]
  }

  private persist(): void {
    this.store.savePanes(this.snapshotAll())
    this.store.saveWorkspaces(this.workspaces())
  }

  private hooks(id: string): PaneHooks {
    return {
      onExit: () => {
        this.panes.delete(id)
        this.schedulePersist(500)
      },
      onChange: () => this.schedulePersist(2000)
    }
  }

  /** Spawn or return the existing pane (id-guard across the process boundary — a
   *  reconnecting client re-requesting the same id ATTACHES, never duplicates). */
  ensure(id: string, spec: SpawnSpec): { pane: PaneSession; existed: boolean } {
    const existing = this.panes.get(id)
    if (existing) return { pane: existing, existed: true }
    const pane = new PaneSession(id, spec, this.hooks(id))
    this.panes.set(id, pane)
    this.schedulePersist(500)
    return { pane, existed: false }
  }

  /** Cold-start restore: re-create persisted panes (fresh shell at cwd + seeded scrollback).
   *  Only runs into an empty manager. Returns how many panes were restored. */
  restore(): number {
    if (this.panes.size > 0) return 0
    this.store.loadWorkspaces() // load persisted workspaces (layout consumed by the app in 04/05)
    const persisted = this.store.loadPanes()
    for (const p of persisted) {
      const spec: SpawnSpec = { cwd: p.cwd, run: p.command }
      // Relaunch a known agent via its own resume (step 4) — never a frozen process.
      const resumeCommand = resumeCommandFor(p.command)
      const pane = new PaneSession(p.id, spec, this.hooks(p.id), { scrollback: p.scrollback, resumeCommand })
      this.panes.set(p.id, pane)
    }
    return persisted.length
  }

  /** Coalesced background write (scrollback churns constantly). */
  schedulePersist(delayMs = 2000): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.persist()
    }, delayMs)
  }

  /** Flush synchronously (e.g. on graceful shutdown). */
  persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    this.persist()
  }

  remove(id: string): void {
    const p = this.panes.get(id)
    if (p) {
      p.kill()
      this.panes.delete(id)
      this.schedulePersist(500)
    }
  }
  killAll(): void {
    for (const p of this.panes.values()) p.kill()
    this.panes.clear()
  }
}

export type { PaneSession }
