// Opt-in (MOGGING_DAEMON) backend path: instead of running the PtyService in-process,
// relay the terminal IPC channels to the detached daemon (ADR 0006). The renderer/preload/UI
// are unchanged — they still speak the same TerminalChannels; only where the PTY lives moves.
// Kept opt-in until the daemon path reaches full parity (agent-state OSC), so the proven
// in-proc path stays the default and the green baseline is untouched.
import { ipcMain, type WebContents } from 'electron'
import * as path from 'node:path'
import { TerminalChannels, LedgerChannels } from '@contracts'
import type { SpawnRequest, WriteCommand, ResizeCommand, KillCommand, SetRoleCommand } from '@contracts'
import { ensureDaemon, DaemonClient } from './daemon-client'

/** Connect to (or spawn) the daemon and bridge the terminal channels to it.
 *  Returns a disposer that detaches the client WITHOUT killing the daemon (survival). */
export async function startDaemonBackend(getWebContents: () => WebContents | null): Promise<() => void> {
  const daemonEntry = path.join(__dirname, 'daemon.js') // out/main/daemon.js, run via Electron-as-Node
  const endpoint = await ensureDaemon(daemonEntry)

  const client = new DaemonClient(endpoint, {
    onData: (id, data) => getWebContents()?.send(TerminalChannels.data, { id: Number(id), data }),
    onExit: (id, exitCode) => getWebContents()?.send(TerminalChannels.exit, { id: Number(id), exitCode }),
    onState: (id, state) => getWebContents()?.send(TerminalChannels.state, { id: Number(id), state }),
    onCwd: (id, cwd) => getWebContents()?.send(TerminalChannels.cwd, { id: Number(id), cwd }),
    onOwners: (claims) => getWebContents()?.send(LedgerChannels.owners, { claims })
  })
  await client.connect()
  client.requestOwners() // seed the renderer's claim chips; pushes keep them live

  ipcMain.handle(TerminalChannels.spawn, (_e, req: SpawnRequest) => {
    client.spawn(String(req.id), { cwd: req.cwd, cols: req.cols, rows: req.rows })
  })
  ipcMain.on(TerminalChannels.write, (_e, cmd: WriteCommand) => client.input(String(cmd.id), cmd.data))
  ipcMain.on(TerminalChannels.resize, (_e, cmd: ResizeCommand) => client.resize(String(cmd.id), cmd.cols, cmd.rows))
  ipcMain.on(TerminalChannels.kill, (_e, cmd: KillCommand) => client.kill(String(cmd.id)))
  ipcMain.on(TerminalChannels.setRole, (_e, cmd: SetRoleCommand) => client.setRole(String(cmd.id), cmd.role))

  return () => client.dispose()
}
