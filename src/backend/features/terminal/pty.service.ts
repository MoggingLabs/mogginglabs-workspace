import { homedir } from 'node:os'
import * as pty from 'node-pty'
import type {
  AgentState,
  CwdEvent,
  DataEvent,
  ExitEvent,
  KillCommand,
  ResizeCommand,
  SpawnRequest,
  StateEvent,
  WriteCommand
} from '@contracts'
import { defaultShell, shellArgs } from '../../platform/shell'
import { killPtyTree } from '../../platform/process-tree'
import { getTelemetry } from '../../core/telemetry'
import { OscParser, fileUriToPath } from '../agent-state'

/** The sink the service pushes pane events into (wired to IPC by the module). */
export interface TerminalSink {
  data(event: DataEvent): void
  exit(event: ExitEvent): void
  state(event: StateEvent): void
  cwd(event: CwdEvent): void
}

/**
 * Owns the live PTYs. Electron-free and unit-testable: give it a fake sink and
 * assert on emitted events.
 */
export class PtyService {
  private readonly ptys = new Map<number, pty.IPty>()

  constructor(private readonly sink: TerminalSink) {}

  spawn(req: SpawnRequest): void {
    if (this.ptys.has(req.id)) return

    try {
      const proc = pty.spawn(defaultShell(), shellArgs(), {
        name: 'xterm-256color',
        cols: req.cols || 80,
        rows: req.rows || 24,
        cwd: req.cwd || homedir(),
        env: process.env as Record<string, string>
      })

      const osc = new OscParser(
        (state: AgentState) => this.sink.state({ id: req.id, state }),
        (ev) => {
          // OSC 7 reports the pane's cwd -> surface it for per-pane git (Phase-2/03).
          if (ev.kind === 'cwd' && ev.payload) {
            const cwd = fileUriToPath(ev.payload)
            if (cwd) this.sink.cwd({ id: req.id, cwd })
          }
        }
      )

      proc.onData((data) => {
        osc.push(data)
        this.sink.data({ id: req.id, data })
      })

      proc.onExit(({ exitCode }) => {
        this.sink.exit({ id: req.id, exitCode })
        this.ptys.delete(req.id)
      })

      this.ptys.set(req.id, proc)
    } catch (err) {
      // Example telemetry use: spawn failures are exactly what we want reported.
      // No terminal content is passed — only structured, primitive context.
      getTelemetry().captureError(err, {
        feature: 'terminal',
        op: 'spawn',
        platform: process.platform
      })
      throw err
    }
  }

  write({ id, data }: WriteCommand): void {
    this.ptys.get(id)?.write(data)
  }

  resize({ id, cols, rows }: ResizeCommand): void {
    this.ptys.get(id)?.resize(cols, rows)
  }

  kill({ id }: KillCommand): void {
    const proc = this.ptys.get(id)
    if (proc) {
      killPtyTree(proc)
      this.ptys.delete(id)
    }
  }

  disposeAll(): void {
    for (const proc of this.ptys.values()) killPtyTree(proc)
    this.ptys.clear()
  }
}
