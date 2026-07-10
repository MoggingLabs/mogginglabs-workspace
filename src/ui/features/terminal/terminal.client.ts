import { TerminalChannels } from '@contracts'
import type {
  AgentState,
  CwdEvent,
  DataEvent,
  ExitEvent,
  KillCommand,
  PaneId,
  ResizeCommand,
  SpawnRequest,
  SpawnResult,
  StateEvent,
  StateSyncRequest,
  WriteCommand
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/** Typed client for the terminal feature's IPC surface. The only place in the UI
 *  that knows the terminal channel names. */
export const terminalClient = {
  /** Resolves with `{ existing }` — true when the backend reattached us to a session it
   *  already held (a surviving daemon), so nothing must be typed into the pane. */
  spawn: (req: SpawnRequest): Promise<SpawnResult> =>
    getBridge().invoke(TerminalChannels.spawn, req) as Promise<SpawnResult>,
  write: (cmd: WriteCommand): void => getBridge().send(TerminalChannels.write, cmd),
  resize: (cmd: ResizeCommand): void => getBridge().send(TerminalChannels.resize, cmd),
  kill: (cmd: KillCommand): void => getBridge().send(TerminalChannels.kill, cmd),
  /** PULL the pane's current agent state (null = backend holds no session). The dot's
   *  reliability contract: a mounting pane must ask — change events it never heard
   *  (renderer reload, boot against a surviving daemon) are not coming back. */
  stateSync: (id: PaneId): Promise<AgentState | null> =>
    getBridge().invoke(TerminalChannels.stateSync, { id } satisfies StateSyncRequest) as Promise<AgentState | null>,
  // Each subscription returns its unsubscriber. Panes are per-slot objects that die on
  // close while these channels live for the whole session — a pane that doesn't detach
  // on dispose keeps writing into a disposed xterm forever.
  onData: (cb: (e: DataEvent) => void): (() => void) =>
    getBridge().on(TerminalChannels.data, (p) => cb(p as DataEvent)),
  onExit: (cb: (e: ExitEvent) => void): (() => void) =>
    getBridge().on(TerminalChannels.exit, (p) => cb(p as ExitEvent)),
  onState: (cb: (e: StateEvent) => void): (() => void) =>
    getBridge().on(TerminalChannels.state, (p) => cb(p as StateEvent)),
  onCwd: (cb: (e: CwdEvent) => void): (() => void) =>
    getBridge().on(TerminalChannels.cwd, (p) => cb(p as CwdEvent))
}
