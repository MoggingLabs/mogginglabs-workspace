import { TerminalChannels } from '@contracts'
import type {
  CwdEvent,
  DataEvent,
  ExitEvent,
  KillCommand,
  ResizeCommand,
  SpawnRequest,
  StateEvent,
  WriteCommand
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/** Typed client for the terminal feature's IPC surface. The only place in the UI
 *  that knows the terminal channel names. */
export const terminalClient = {
  spawn: (req: SpawnRequest): Promise<void> =>
    getBridge().invoke(TerminalChannels.spawn, req) as Promise<void>,
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
