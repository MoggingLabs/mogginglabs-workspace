// Opt-in (MOGGING_DAEMON) backend path: instead of running the PtyService in-process,
// relay the terminal IPC channels to the detached daemon (ADR 0006). The renderer/preload/UI
// are unchanged — they still speak the same TerminalChannels; only where the PTY lives moves.
// Kept opt-in until the daemon path reaches full parity (agent-state OSC), so the proven
// in-proc path stays the default and the green baseline is untouched.
import { ipcMain, type WebContents } from 'electron'
import * as path from 'node:path'
import { TerminalChannels, LedgerChannels, GateChannels } from '@contracts'
import type { AgentState, SpawnRequest, SpawnResult, SpawnSpec, StateSyncRequest, WriteCommand, ResizeCommand, KillCommand, SetRoleCommand } from '@contracts'
import { getTelemetry } from '@backend'
import { ensureDaemon, DaemonClient } from './daemon-client'
import { migrateOlderDaemonSessions } from './daemon-migrate'
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
  /** THE generation gate (v5). Pane id -> the one session generation whose events may
   *  reach the renderer; 'killed' is a tombstone set the moment the app closes a pane.
   *  Ids are reused (a split takes the lowest free slot), so events still in flight from
   *  a killed pane's pty — its last data flush, its async exit — would otherwise land in
   *  the reused id's brand-new pane ("[process exited]" in a healthy terminal) or delete
   *  its reconnect-replay spec. Gens are learned from `welcome`/`spawned` and compared on
   *  every pane event; a mismatch is a dead generation talking, and it is dropped. */
  const gens = new Map<string, number | 'killed'>()
  const current = (id: string, gen: number): boolean => gens.get(id) === gen
  /** Last gate-passing state per pane — the answer to the renderer's stateSync PULL.
   *  Push alone cannot keep the dot honest: the daemon emits state on CHANGE only, and
   *  a welcome replay fired before a pane's listener existed (app boot, renderer
   *  reload) is simply lost. Fed by onState/onWelcome, emptied with the session. */
  const lastStates = new Map<string, AgentState>()

  const makeClient = async (): Promise<DaemonClient> => {
    const endpoint = await ensureDaemon(daemonEntry)
    const c: DaemonClient = new DaemonClient(endpoint, {
      // Fired from `spawned`/`attached` BEFORE their scrollback replay, so the replay
      // itself passes the gate it establishes.
      onGen: (id, gen) => gens.set(id, gen),
      onData: (id, data, gen) => {
        if (current(id, gen)) getWebContents()?.send(TerminalChannels.data, { id: Number(id), data })
      },
      onExit: (id, exitCode, gen) => {
        if (!current(id, gen)) return // a dead generation's late exit — not this pane's news
        specs.delete(id) // an exited pane must not be resurrected by a reconnect replay
        lastStates.delete(id) // no session, no state — a late sync must not repaint a dead pane
        getWebContents()?.send(TerminalChannels.exit, { id: Number(id), exitCode })
      },
      onState: (id, state, gen) => {
        if (!current(id, gen)) return
        lastStates.set(id, state)
        getWebContents()?.send(TerminalChannels.state, { id: Number(id), state })
        onPaneStateForBridge(Number(id), state) // 8/10: needs-you -> webhooks (main-side, daemon untouched)
      },
      // The daemon only pushes `state` on CHANGE, so a client that (re)connects would show
      // grey dots until each agent next flips. `welcome` carries every pane's live state —
      // replay it so attention indicators are correct the moment the connection exists.
      // It also carries every pane's CURRENT gen: seed the gate from it, so the replayed
      // states pass and stragglers from before a daemon restart cannot.
      onWelcome: (panes) => {
        for (const p of panes) {
          // The app closed this pane but its kill died with the old connection (send
          // into a dead socket is silently dropped): finish the job on the new one, and
          // KEEP the tombstone — a session the user closed stays closed, never a zombie
          // shell in the daemon whose events re-open the renderer gate.
          if (gens.get(p.id) === 'killed') {
            c.kill(p.id)
            lastStates.delete(p.id)
            continue
          }
          gens.set(p.id, p.gen)
          if (p.state) {
            lastStates.set(p.id, p.state)
            getWebContents()?.send(TerminalChannels.state, { id: Number(p.id), state: p.state })
          }
        }
      },
      onCwd: (id, cwd, gen) => {
        if (current(id, gen)) getWebContents()?.send(TerminalChannels.cwd, { id: Number(id), cwd })
      },
      onOwners: (claims) => getWebContents()?.send(LedgerChannels.owners, { claims }),
      onLimit: (id, gen) => {
        if (current(id, gen)) getWebContents()?.send(TerminalChannels.limit, { id: Number(id) })
      },
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

  // Cross-version hand-off, BEFORE the first daemon spawn: on the first launch of a new
  // protocol version this pulls the previous daemon's sessions into our (still absent)
  // store and retires it, so the daemon we are about to start restores the user's panes
  // instead of a blank slate. Guarded + bounded inside; a failure means a plain start.
  try {
    await migrateOlderDaemonSessions()
  } catch (err) {
    getTelemetry().captureError(err, { feature: 'daemon', op: 'migrate', platform: process.platform })
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
    // Tombstone the id: everything still in flight from the killed session (last data
    // flush, the async exit) is dropped until the next `spawned` re-opens the gate.
    gens.set(String(cmd.id), 'killed')
    lastStates.delete(String(cmd.id))
    client.kill(String(cmd.id))
  })
  // The dot's reliability contract: a mounting pane PULLS its current state (the
  // in-proc backend serves the same channel from tracker truth — one backend at a time).
  ipcMain.handle(TerminalChannels.stateSync, (_e, req: StateSyncRequest) =>
    lastStates.get(String(req.id)) ?? null
  )
  ipcMain.on(TerminalChannels.setRole, (_e, cmd: SetRoleCommand) => client.setRole(String(cmd.id), cmd.role))

  return () => {
    disposed = true // stops the reconnect loop; a close caused by our own dispose stays quiet
    activeClient = null
    client.dispose()
  }
}
