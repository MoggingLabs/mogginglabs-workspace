import { randomBytes } from 'node:crypto'
import type {
  AgentDetectedEvent,
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
import { defaultShell, paneShellLaunch } from '../../platform/shell'
import { killPtyTree } from '../../platform/process-tree'
import { SCROLLBACK_BYTES, pickCwd, trimTornStart } from './pane-shared'
import { getTelemetry } from '../../core/telemetry'
import {
  ActivityTracker,
  AgentProcessDetector,
  GitContextObserver,
  OscParser,
  PaneCwdState,
  countSubmittedLines,
  fileUriToPath,
  isEngagedInput,
  isSubmittedInput,
  isTerminalReply,
  normalizePaneCwd,
  type DetectedAgentProc,
  type DetectedProcessContext,
  type PaneCwdSnapshot
} from '../agent-state'
import { aiderLogPath } from '../context'

/** The sink the service pushes pane events into (wired to IPC by the module). */
export interface TerminalSink {
  data(event: DataEvent): void
  exit(event: ExitEvent): void
  state(event: StateEvent): void
  cwd(event: CwdEvent): void
  /** Typed-launch detection: an agent CLI process appeared in / left the pane's subtree. */
  agent(event: AgentDetectedEvent): void
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
  /** Per-pane scrollback ring, replayed on an `existing` re-spawn (a renderer reload
   *  re-requests every pane): parity with the daemon path, whose reattach repaints from
   *  ITS ring — without this an in-proc reload left every pane blank over a live shell. */
  private readonly buffers = new Map<number, string>()
  /** Source-aware cwd state for each pane. Shell reports are the conservative fallback when a
   * foreground process cannot be inspected (permissions or platform policy). */
  private readonly cwdStates = new Map<number, PaneCwdState>()
  private readonly gitContexts = new Map<number, GitContextObserver>()
  private readonly generations = new Map<number, string>()
  private nextGeneration = 1
  /** Typed-launch detection (the in-proc twin of the daemon's — one detector, all panes). */
  private readonly agentProcs = new AgentProcessDetector(
    (paneId, det) => this.applyAgentProc(Number(paneId), det),
    Date.now,
    {},
    (paneId, context) => this.applyProcessContext(Number(paneId), context)
  )
  constructor(private readonly sink: TerminalSink) {}

  private publishCwd(id: number, changed?: PaneCwdSnapshot | null): void {
    const generation = this.generations.get(id)
    if (!changed || !generation) return
    this.sink.cwd({
      id,
      cwd: changed.cwd,
      generation,
      revision: changed.revision,
      source: changed.source,
      locality: changed.locality
    })
  }

  private applyAgentProc(id: number, det: DetectedAgentProc | null): void {
    const state = this.cwdStates.get(id)
    if (!state) return
    const detectedCwd = det?.cwd
      ? normalizePaneCwd(det.cwd, { mustExist: false }) ?? undefined
      : undefined
    this.sink.agent({
      id,
      agentId: det?.agentId ?? null,
      cwd: det ? (detectedCwd ?? state.passiveCwd()) : undefined,
      sinceMs: det?.sinceMs
    })
  }

  private applyProcessContext(id: number, context: DetectedProcessContext | null): void {
    const state = this.cwdStates.get(id)
    if (!state) return
    const cwd = context?.cwd ? normalizePaneCwd(context.cwd, { mustExist: false }) ?? undefined : undefined
    this.publishCwd(id, state.acceptDetected(context ? { pid: context.pid, cwd } : null))
  }

  spawn(req: SpawnRequest): SpawnResult {
    // Remote intent must never degrade into a local shell. The in-process backend has
    // no SSH implementation; only the detached daemon may accept remote spawn requests.
    if (req.remoteHostId || req.remoteCwd !== undefined) {
      throw new Error('Remote panes require the detached daemon backend')
    }
    if (this.ptys.has(req.id)) {
      // Reattach: repaint before the reply resolves — the same wire order as the daemon
      // (scrollback data precedes `spawned`), which the renderer already handles.
      // Never `restored`: an in-proc pty lives in THIS process, so an existing session is
      // by definition continuously alive (a renderer reload), never a cold-start restore.
      const buf = this.buffers.get(req.id)
      if (buf) this.sink.data({ id: req.id, data: buf })
      this.publishCwd(req.id, this.cwdStates.get(req.id)?.current())
      return { existing: true, restored: false, pty: ptyEmulation() }
    }

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
      const shell = defaultShell()
      const spawnCwd = pickCwd(req.cwd)
      const paneToken = randomBytes(16).toString('hex')
      const generation = `${process.pid}:inproc:${this.nextGeneration++}`
      const cwdState = new PaneCwdState(spawnCwd, 'local')
      const inheritedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        AIDER_ANALYTICS_LOG: aiderLogPath(req.id)
      }
      const shellLaunch = paneShellLaunch(shell, inheritedEnv, `${process.pid}-${req.id}-${generation}`)
      const { proc, emulation } = spawnPty(shell, shellLaunch.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spawnCwd,
        // Shell integration (cwd reporting): the same env the daemon injects — a cmd.exe pane
        // that never told anyone where it was now does, on every prompt.
        // AIDER_ANALYTICS_LOG: the daemon's twin — aider's only exact source (see providers.ts).
        env: {
          ...inheritedEnv,
          ...shellLaunch.env,
          MOGGING_PANE_ID: String(req.id),
          MOGGING_PANE_TOKEN: paneToken
        } as Record<string, string>
      })
      this.sizes.set(req.id, { cols, rows })
      this.cwdStates.set(req.id, cwdState)
      this.generations.set(req.id, generation)
      if (shellLaunch.gitTraceFile) {
        this.gitContexts.set(req.id, new GitContextObserver(shellLaunch.gitTraceFile, (raw) => {
          const cwd = normalizePaneCwd(raw, { mustExist: true })
          if (cwd) this.publishCwd(req.id, cwdState.acceptWorktree(cwd))
        }))
      }

      // Pane state = the ActivityTracker's verdict, with the OscParser feeding it
      // explicit signals — the same fusion as the daemon path (parity; see
      // agent-state/activity.ts for the precedence rules).
      const tracker = new ActivityTracker((state: AgentState) => this.sink.state({ id: req.id, state }))
      this.trackers.set(req.id, tracker)
      const osc = new OscParser(
        // Parity with the daemon path: an OSC 9/99/777 notification is a GUESS (CLIs ring
        // it on completion too), so it goes through the bell's confirmation window rather
        // than latching red outright. 133;C/D is a verdict about the SHELL — it moves a
        // pane that has spoken, never authors the first state, and the prompt half ends
        // latches (activity.ts shellPrompt).
        (state: AgentState) =>
          state === 'attention'
            ? tracker.bell()
            : state === 'busy'
              ? tracker.shellCmdStart()
              : tracker.shellPrompt(),
        (ev) => {
          if (ev.kind === 'bell') tracker.bell()
          if (ev.kind === 'prompt') {
            tracker.shellPrompt()
            this.gitContexts.get(req.id)?.resetAtPrompt()
            this.agentProcs.promptSeen(String(req.id), 'osc133')
            this.publishCwd(req.id, cwdState.acceptPrompt(Date.now(), 'osc133'))
          }
          if (ev.kind === 'shell-prompt') {
            tracker.shellPrompt()
            this.gitContexts.get(req.id)?.resetAtPrompt()
            this.agentProcs.promptSeen(String(req.id), 'mogging')
            const cwd = ev.payload ? normalizePaneCwd(ev.payload, { mustExist: false }) : null
            this.publishCwd(
              req.id,
              cwd
                ? cwdState.acceptShell(cwd, true, Date.now(), 'mogging')
                : cwdState.acceptPrompt(Date.now(), 'mogging')
            )
          }
          // OSC 7 / 9;9 report the pane's cwd -> per-pane git (Phase-2/03), and the launch
          // dir of a hand-typed agent. De-duped on value: a cmd.exe prompt emits both forms.
          // 9;9 is also the SHELL's prompt marker — the detector's cheapest signal (it says a
          // foreground command has ENDED). Daemon parity: pty-daemon/session.ts.
          if (ev.kind === 'cwd' && ev.payload) {
            const prompt = ev.code === 9
            if (prompt) {
              tracker.shellPrompt() // 9;9 is OUR injected cmd.exe prompt mark — same verdict as 133;D
              this.gitContexts.get(req.id)?.resetAtPrompt()
              this.agentProcs.promptSeen(String(req.id), 'osc9')
            }
            const raw = fileUriToPath(ev.payload)
            const cwd = raw ? normalizePaneCwd(raw, { mustExist: false }) : null
            if (cwd) {
              this.publishCwd(
                req.id,
                cwdState.acceptShell(cwd, prompt, Date.now(), prompt ? 'osc9' : 'generic')
              )
            } else if (prompt) {
              this.publishCwd(req.id, cwdState.acceptPrompt(Date.now(), 'osc9'))
            }
          }
          if (ev.kind === 'agent-cwd' && ev.payload) {
            const cwd = normalizePaneCwd(ev.payload, { mustExist: true })
            if (cwd) {
              const result = cwdState.acceptReport(cwd, Date.now())
              this.publishCwd(req.id, result.changed)
            }
          }
        }
      )

      // Both callbacks are identity-guarded on THIS proc: pane ids are reused (a split
      // takes the lowest free slot), and a killed pty dies asynchronously — its last data
      // flush and its exit land AFTER kill() returned. Unguarded, that stale exit deleted
      // the reused id's NEW pty from the map (orphaning a live shell), disposed the new
      // pane's tracker, and printed "[process exited]" into a healthy terminal; stale data
      // painted the old shell's bytes into it. Same generation discipline as the daemon
      // path (transport.ts subscribes per session generation) — here the proc IS the gen.
      proc.onData((data) => {
        if (this.ptys.get(req.id) !== proc) return // a dead generation talking
        const grown = (this.buffers.get(req.id) ?? '') + data
        this.buffers.set(
          req.id,
          grown.length > SCROLLBACK_BYTES ? trimTornStart(grown.slice(-SCROLLBACK_BYTES)) : grown
        )
        osc.push(data)
        this.gitContexts.get(req.id)?.drain()
        this.sink.data({ id: req.id, data })
      })

      proc.onExit(({ exitCode }) => {
        if (this.ptys.get(req.id) !== proc) return // kill() (or a successor) already owns cleanup
        this.trackers.get(req.id)?.dispose()
        this.trackers.delete(req.id)
        this.agentProcs.untrack(String(req.id))
        this.gitContexts.get(req.id)?.dispose()
        this.gitContexts.delete(req.id)
        this.sink.exit({ id: req.id, exitCode })
        this.ptys.delete(req.id)
        this.sizes.delete(req.id)
        this.buffers.delete(req.id)
        this.cwdStates.delete(req.id)
        this.generations.delete(req.id)
      })

      this.ptys.set(req.id, proc)
      // Watch this pane's subtree. No `expectAgent`: an in-proc pane is always a FRESH shell
      // (this backend has no restore), so it starts empty and every launch into it is typed —
      // and therefore announces itself. It is never looked at unprompted.
      this.agentProcs.track(String(req.id), proc.pid)
      this.publishCwd(req.id, cwdState.current())
      return { existing: false, restored: false, pty: emulation }
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
    // Not for auto-replies: xterm answering a query (CPR/DA/focus) is not the user
    // answering the pane — it must not clear an attention latch (see replies.ts).
    if (!isTerminalReply(data)) {
      // A SUBMIT or a PRINTABLE key answers a blocked agent — see the daemon's twin,
      // isSubmittedInput and isEngagedInput.
      this.trackers.get(id)?.input(isSubmittedInput(data), isEngagedInput(data))
      // A submitted LINE is the only moment a shell can start something (see the daemon's twin).
      const submissions = countSubmittedLines(data)
      for (let i = 0; i < submissions; i++) {
        this.agentProcs.commandSubmitted(String(id))
        this.publishCwd(id, this.cwdStates.get(id)?.acceptCommandStart())
      }
    }
    this.ptys.get(id)?.write(data)
  }

  /** State-sync PULL: the CURRENT verdict for a mounting pane (null = no session).
   *  Trackers only emit on change, so a remounted renderer must ask, not wait. */
  stateOf(id: number): AgentState | null {
    return this.trackers.get(id)?.current() ?? null
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
    this.agentProcs.untrack(String(id))
    this.gitContexts.get(id)?.dispose()
    this.gitContexts.delete(id)
    const proc = this.ptys.get(id)
    if (proc) {
      killPtyTree(proc)
      this.ptys.delete(id)
    }
    this.sizes.delete(id)
    this.buffers.delete(id)
    this.cwdStates.delete(id)
    this.generations.delete(id)
  }

  disposeAll(): void {
    for (const tracker of this.trackers.values()) tracker.dispose()
    this.trackers.clear()
    this.agentProcs.dispose()
    for (const observer of this.gitContexts.values()) observer.dispose()
    this.gitContexts.clear()
    for (const proc of this.ptys.values()) killPtyTree(proc)
    this.ptys.clear()
    this.sizes.clear()
    this.buffers.clear()
    this.cwdStates.clear()
    this.generations.clear()
  }
}
