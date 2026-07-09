import { homedir } from 'node:os'
import { statSync } from 'node:fs'
import type {
  AgentState,
  CwdEvent,
  DataEvent,
  ExitEvent,
  KillCommand,
  ResizeCommand,
  SpawnRequest,
  SpawnResult,
  StateEvent,
  WriteCommand
} from '@contracts'
import { spawnPty, ptyEmulation, type IPty } from '../../platform/pty-host'
import { defaultShell, shellArgs } from '../../platform/shell'
import { killPtyTree } from '../../platform/process-tree'
import { getTelemetry } from '../../core/telemetry'
import { ActivityTracker, OscParser, fileUriToPath } from '../agent-state'

/** The directory a pane's shell starts in: the requested one when it is a real directory,
 *  the home directory otherwise. Mirrors pty-daemon/session.ts's pickCwd — the two backends
 *  must not disagree about where a pane opens. `''` means "none asked for" (never the
 *  process's own directory, which is the app's install folder in a packaged build), and a
 *  path removed since the workspace was saved falls back rather than failing the spawn. */
function pickCwd(requested?: string): string {
  if (requested) {
    try {
      if (statSync(requested).isDirectory()) return requested
    } catch {
      /* gone, or not readable — fall through to home */
    }
  }
  return homedir()
}

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
  private readonly ptys = new Map<number, IPty>()
  private readonly trackers = new Map<number, ActivityTracker>()
  /** Last size each pane's PTY is actually AT (or was asked for before it spawned). */
  private readonly sizes = new Map<number, { cols: number; rows: number }>()

  constructor(private readonly sink: TerminalSink) {}

  spawn(req: SpawnRequest): SpawnResult {
    if (this.ptys.has(req.id)) return { existing: true, pty: ptyEmulation() }

    // A resize that lands before the spawn used to hit `ptys.get(id)?.resize` and vanish,
    // leaving the PTY at its spawn size while the renderer's xterm sat at the real one.
    // A grid that disagrees with the PTY is exactly how ConPTY's repaint smears (see
    // resize() below), so the last size wins over the spawn request.
    const pending = this.sizes.get(req.id)
    const cols = pending?.cols || req.cols || 80
    const rows = pending?.rows || req.rows || 24

    try {
      // spawnPty is the only door to node-pty: it decides useConpty and hands back the emulation
      // that describes THIS process, so the descriptor can never disagree with the pty.
      const { proc, emulation } = spawnPty(defaultShell(), shellArgs(), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: pickCwd(req.cwd),
        env: process.env as Record<string, string>
      })
      this.sizes.set(req.id, { cols, rows })

      // Pane state = the ActivityTracker's verdict, with the OscParser feeding it
      // explicit signals — the same fusion as the daemon path (parity; see
      // agent-state/activity.ts for the precedence rules).
      const tracker = new ActivityTracker((state: AgentState) => this.sink.state({ id: req.id, state }))
      this.trackers.set(req.id, tracker)
      const osc = new OscParser(
        (state: AgentState) => tracker.notify(state),
        (ev) => {
          if (ev.kind === 'bell') tracker.bell()
          // OSC 7 reports the pane's cwd -> surface it for per-pane git (Phase-2/03).
          if (ev.kind === 'cwd' && ev.payload) {
            const cwd = fileUriToPath(ev.payload)
            if (cwd) this.sink.cwd({ id: req.id, cwd })
          }
        }
      )

      proc.onData((data) => {
        tracker.data() // BEFORE the parse: a verdict in this chunk must land last
        osc.push(data)
        this.sink.data({ id: req.id, data })
      })

      proc.onExit(({ exitCode }) => {
        this.trackers.get(req.id)?.dispose()
        this.trackers.delete(req.id)
        this.sink.exit({ id: req.id, exitCode })
        this.ptys.delete(req.id)
        this.sizes.delete(req.id)
      })

      this.ptys.set(req.id, proc)
      return { existing: false, pty: emulation }
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
    this.trackers.get(id)?.input() // typing answers whatever the pane was blocked on
    this.ptys.get(id)?.write(data)
  }

  /**
   * Resize a pane's PTY — but never for free. A resize is not a cheap notification: on
   * Windows, ConPTY answers EVERY resize (including one to the size it already has) by
   * repainting its whole viewport — `ESC[H`, then each row of conhost's screen buffer,
   * then a cursor restore. Measured against cmd.exe: a no-op resize costs a full 418-byte
   * repaint, and a 9-tick sweep (what a 150 ms rail transition or a window drag produces)
   * costs nine of them.
   *
   * That repaint is what smears an agent's TUI: it replays conhost's idea of the screen —
   * which still holds the pre-agent shell prompts — over rows the agent is mid-render on,
   * splicing `C:\...>` lines into the middle of its frame. So: no size change, no resize.
   * The renderer coalesces the rest (terminal-pane.ts's refit debounce).
   */
  resize({ id, cols, rows }: ResizeCommand): void {
    if (!cols || !rows) return
    const at = this.sizes.get(id)
    if (at && at.cols === cols && at.rows === rows) return
    this.sizes.set(id, { cols, rows })
    this.ptys.get(id)?.resize(cols, rows)
  }

  kill({ id }: KillCommand): void {
    this.trackers.get(id)?.dispose()
    this.trackers.delete(id)
    const proc = this.ptys.get(id)
    if (proc) {
      killPtyTree(proc)
      this.ptys.delete(id)
    }
    this.sizes.delete(id)
  }

  disposeAll(): void {
    for (const tracker of this.trackers.values()) tracker.dispose()
    this.trackers.clear()
    for (const proc of this.ptys.values()) killPtyTree(proc)
    this.ptys.clear()
    this.sizes.clear()
  }
}
