import { TerminalChannels } from '@contracts'
import type {
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
  onData: (cb: (e: DataEvent) => void): void =>
    getBridge().on(TerminalChannels.data, (p) => cb(p as DataEvent)),
  onExit: (cb: (e: ExitEvent) => void): void =>
    getBridge().on(TerminalChannels.exit, (p) => cb(p as ExitEvent)),
  onState: (cb: (e: StateEvent) => void): void =>
    getBridge().on(TerminalChannels.state, (p) => cb(p as StateEvent)),
  onCwd: (cb: (e: CwdEvent) => void): void =>
    getBridge().on(TerminalChannels.cwd, (p) => cb(p as CwdEvent))
}
