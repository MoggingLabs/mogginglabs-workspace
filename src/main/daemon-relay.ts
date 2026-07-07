// Opt-in (MOGGING_DAEMON) backend path: instead of running the PtyService in-process,
// relay the terminal IPC channels to the detached daemon (ADR 0006). The renderer/preload/UI
// are unchanged — they still speak the same TerminalChannels; only where the PTY lives moves.
// Kept opt-in until the daemon path reaches full parity (agent-state OSC), so the proven
// in-proc path stays the default and the green baseline is untouched.
import { ipcMain, type WebContents } from 'electron'
import * as path from 'node:path'
import { TerminalChannels, LedgerChannels, GateChannels } from '@contracts'
import type { SpawnRequest, WriteCommand, ResizeCommand, KillCommand, SetRoleCommand } from '@contracts'
import { ensureDaemon, DaemonClient } from './daemon-client'
import { getSettingsStore } from './app-settings'
import { resolveServiceKeyEnv } from './service-keys'
import { onPaneStateForBridge } from './event-bridge'

// The one live daemon connection, for other main modules (review gate 4/03).
let activeClient: DaemonClient | null = null
export function getDaemonClient(): DaemonClient | null {
  return activeClient
}

/** Connect to (or spawn) the daemon and bridge the terminal channels to it.
 *  Returns a disposer that detaches the client WITHOUT killing the daemon (survival). */
export async function startDaemonBackend(getWebContents: () => WebContents | null): Promise<() => void> {
  const daemonEntry = path.join(__dirname, 'daemon.js') // out/main/daemon.js, run via Electron-as-Node
  const endpoint = await ensureDaemon(daemonEntry)

  const client = new DaemonClient(endpoint, {
    onData: (id, data) => getWebContents()?.send(TerminalChannels.data, { id: Number(id), data }),
    onExit: (id, exitCode) => getWebContents()?.send(TerminalChannels.exit, { id: Number(id), exitCode }),
    onState: (id, state) => {
      getWebContents()?.send(TerminalChannels.state, { id: Number(id), state })
      onPaneStateForBridge(Number(id), state) // 8/10: needs-you -> webhooks (main-side, daemon untouched)
    },
    onCwd: (id, cwd) => getWebContents()?.send(TerminalChannels.cwd, { id: Number(id), cwd }),
    onOwners: (claims) => getWebContents()?.send(LedgerChannels.owners, { claims }),
    onLimit: (id) => getWebContents()?.send(TerminalChannels.limit, { id: Number(id) }),
    onApprovals: (list) => getWebContents()?.send(GateChannels.approvals, { list })
  })
  await client.connect()
  activeClient = client
  client.requestOwners() // seed the renderer's claim chips; pushes keep them live
  void client.queryApprovals() // seed the board's ✓-chips the same way

  ipcMain.handle(TerminalChannels.spawn, (_e, req: SpawnRequest) => {
    // Remote pane (4/05): the renderer names a host ID; MAIN resolves the row here
    // (the daemon stays db-free, values never round-trip the renderer).
    const row = req.remoteHostId
      ? getSettingsStore()?.listRemotes().find((h) => h.id === req.remoteHostId)
      : undefined
    const remote = row ? { name: row.name, host: row.host, user: row.user, port: row.port } : undefined
    // Vault service keys (8/08): resolved HERE, in main, into the per-pane env —
    // the renderer never sees a value; the daemon merges it into the PTY env
    // (never typed, so no secret in scrollback/sessions.db). Remote panes get
    // none: the key would ride SSH to another machine (not our env to hand out).
    const env = remote ? undefined : resolveServiceKeyEnv()
    client.spawn(String(req.id), { cwd: req.cwd, cols: req.cols, rows: req.rows, remote, env })
  })
  ipcMain.on(TerminalChannels.write, (_e, cmd: WriteCommand) => client.input(String(cmd.id), cmd.data))
  ipcMain.on(TerminalChannels.resize, (_e, cmd: ResizeCommand) => client.resize(String(cmd.id), cmd.cols, cmd.rows))
  ipcMain.on(TerminalChannels.kill, (_e, cmd: KillCommand) => client.kill(String(cmd.id)))
  ipcMain.on(TerminalChannels.setRole, (_e, cmd: SetRoleCommand) => client.setRole(String(cmd.id), cmd.role))

  return () => {
    if (activeClient === client) activeClient = null
    client.dispose()
  }
}
