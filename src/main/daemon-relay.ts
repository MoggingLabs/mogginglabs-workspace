// Opt-in (MOGGING_DAEMON) backend path: instead of running the PtyService in-process,
// relay the terminal IPC channels to the detached daemon (ADR 0006). The renderer/preload/UI
// are unchanged — they still speak the same TerminalChannels; only where the PTY lives moves.
// Kept opt-in until the daemon path reaches full parity (agent-state OSC), so the proven
// in-proc path stays the default and the green baseline is untouched.
import { ipcMain, type WebContents } from 'electron'
import * as path from 'node:path'
import { TerminalChannels, LedgerChannels, GateChannels } from '@contracts'
import type { SpawnRequest, SpawnResult, SpawnSpec, WriteCommand, ResizeCommand, KillCommand, SetRoleCommand } from '@contracts'
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

  let disposed = false
  let reconnecting = false
  let client!: DaemonClient
  /** The last spec this app sent per pane. Replayed on reconnect: `spawn` is an ensure —
   *  it reattaches to a session the (new) daemon restored, or respawns a lost one — and its
   *  reply replays scrollback through onData, so every pane repaints without renderer help. */
  const specs = new Map<string, SpawnSpec>()

  const makeClient = async (): Promise<DaemonClient> => {
    const endpoint = await ensureDaemon(daemonEntry)
    const c: DaemonClient = new DaemonClient(endpoint, {
      onData: (id, data) => getWebContents()?.send(TerminalChannels.data, { id: Number(id), data }),
      onExit: (id, exitCode) => {
        specs.delete(id) // an exited pane must not be resurrected by a reconnect replay
        getWebContents()?.send(TerminalChannels.exit, { id: Number(id), exitCode })
      },
      onState: (id, state) => {
        getWebContents()?.send(TerminalChannels.state, { id: Number(id), state })
        onPaneStateForBridge(Number(id), state) // 8/10: needs-you -> webhooks (main-side, daemon untouched)
      },
      // The daemon only pushes `state` on CHANGE, so a client that (re)connects would show
      // grey dots until each agent next flips. `welcome` carries every pane's live state —
      // replay it so attention indicators are correct the moment the connection exists.
      onWelcome: (panes) => {
        for (const p of panes)
          if (p.state) getWebContents()?.send(TerminalChannels.state, { id: Number(p.id), state: p.state })
      },
      onCwd: (id, cwd) => getWebContents()?.send(TerminalChannels.cwd, { id: Number(id), cwd }),
      onOwners: (claims) => getWebContents()?.send(LedgerChannels.owners, { claims }),
      onLimit: (id) => getWebContents()?.send(TerminalChannels.limit, { id: Number(id) }),
      onApprovals: (list) => getWebContents()?.send(GateChannels.approvals, { list }),
      // The daemon died (or was killed) under us. Without this the app kept a dead socket
      // forever — no state events (grey dots, no attention toasts), every spawn timing out —
      // a zombie session only an app restart fixed. Only the CURRENT client may trigger a
      // reconnect: a failed candidate's close, or a late close from an already-replaced
      // client, must not start a second loop.
      onClose: () => {
        if (!disposed && client === c) void reconnect()
      }
    })
    await c.connect()
    return c
  }

  const seed = (c: DaemonClient): void => {
    c.requestOwners() // seed the renderer's claim chips; pushes keep them live
    void c.queryApprovals() // seed the board's ✓-chips the same way
  }

  const reconnect = async (): Promise<void> => {
    if (reconnecting) return
    reconnecting = true
    activeClient = null
    console.warn('[daemon] connection lost — reconnecting')
    let delayMs = 500
    while (!disposed) {
      try {
        const next = await makeClient() // re-runs discovery: spawns a fresh daemon if none is live
        client = next
        activeClient = next
        for (const [id, spec] of specs) next.spawn(id, spec).catch(() => {}) // repaint rides the reply's scrollback
        seed(next)
        console.warn(`[daemon] reconnected (${specs.size} pane(s) reattached)`)
        break
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        console.warn(`[daemon] reconnect failed (${why}); retrying in ${delayMs}ms`)
        await new Promise((r) => setTimeout(r, delayMs))
        delayMs = Math.min(delayMs * 2, 15000)
      }
    }
    reconnecting = false
  }

  client = await makeClient()
  activeClient = client
  seed(client)

  ipcMain.handle(TerminalChannels.spawn, async (_e, req: SpawnRequest): Promise<SpawnResult> => {
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
    const spec: SpawnSpec = { cwd: req.cwd, cols: req.cols, rows: req.rows, remote, env }
    // Recorded BEFORE the reply: a spawn that lands in a dying daemon still replays once the
    // connection is back, so the pane comes alive instead of staying blank until app restart.
    specs.set(String(req.id), spec)
    // Straight through, unmodified: `existing` tells the restore path not to type a launch
    // command into a live agent, and `pty` tells xterm how this pane's pty grows. Main relays
    // the daemon's answer — it does not compute either (that is the whole point of pty-host).
    return await client.spawn(String(req.id), spec)
  })
  ipcMain.on(TerminalChannels.write, (_e, cmd: WriteCommand) => client.input(String(cmd.id), cmd.data))
  ipcMain.on(TerminalChannels.resize, (_e, cmd: ResizeCommand) => {
    const spec = specs.get(String(cmd.id))
    if (spec) Object.assign(spec, { cols: cmd.cols, rows: cmd.rows }) // the replay must use CURRENT dims
    client.resize(String(cmd.id), cmd.cols, cmd.rows)
  })
  ipcMain.on(TerminalChannels.kill, (_e, cmd: KillCommand) => {
    specs.delete(String(cmd.id)) // closed on purpose — never resurrected by a reconnect replay
    client.kill(String(cmd.id))
  })
  ipcMain.on(TerminalChannels.setRole, (_e, cmd: SetRoleCommand) => client.setRole(String(cmd.id), cmd.role))

  return () => {
    disposed = true // stops the reconnect loop; a close caused by our own dispose stays quiet
    activeClient = null
    client.dispose()
  }
}
