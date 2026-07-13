// Opt-in (MOGGING_DAEMON) backend path: instead of running the PtyService in-process,
// relay the terminal IPC channels to the detached daemon (ADR 0006). The renderer/preload/UI
// are unchanged — they still speak the same TerminalChannels; only where the PTY lives moves.
// Kept opt-in until the daemon path reaches full parity (agent-state OSC), so the proven
// in-proc path stays the default and the green baseline is untouched.
import { ipcMain, type WebContents } from 'electron'
import * as path from 'node:path'
import { TerminalChannels, LedgerChannels, GateChannels, PANE_CWD_MAX, normalizeRemoteConnection } from '@contracts'
import type { AgentState, Approval, SpawnRequest, SpawnResult, SpawnSpec, StateSyncRequest, WriteCommand, ResizeCommand, KillCommand, SetRoleCommand } from '@contracts'
import { getTelemetry } from '@backend'
import { ensureDaemon, DaemonClient } from './daemon-client'
import { DaemonMigrationDeferredError, migrateOlderDaemonSessions } from './daemon-migrate'
import { getSettingsStore } from './app-settings'
import { resolveServiceKeyEnv } from './service-keys'
import { onPaneStateForBridge } from './event-bridge'
import { sanitizeRemote } from './remotes'

function normalizeRequestedRemoteCwd(raw: unknown): string | undefined {
  if (raw === undefined || raw === '') return undefined
  if (
    typeof raw !== 'string' ||
    raw.length > PANE_CWD_MAX ||
    /[\x00-\x1f\x7f]/.test(raw) ||
    !path.posix.isAbsolute(raw)
  ) {
    throw new Error('Invalid remote working directory')
  }
  const normalized = path.posix.normalize(raw)
  if (!normalized || normalized.length > PANE_CWD_MAX) throw new Error('Invalid remote working directory')
  return normalized
}

// The one live daemon connection, for other main modules (review gate 4/03).
let activeClient: DaemonClient | null = null
export function getDaemonClient(): DaemonClient | null {
  return activeClient
}

// ── WHO IS A REVIEWER: the app's own answer, and the only one that counts ──────────────
//
// Roles used to be authority wherever the DAEMON held them, and the daemon's `set-role` is
// open to any authenticated client — which is every pane, since each one can read the 0600
// endpoint file. So a worker agent could run
//     mogging role <its own pane> reviewer && mogging approve <its own branch>
// and the merge gate (backend/features/review: no merge without `approved`) swung open on
// its own say-so. The pane-token binding on `approve` closed the OTHER half of that (a pane
// can no longer speak AS another pane), but it cannot help here: the forger was never lying
// about which pane it was — it was lying about what that pane is allowed to be.
//
// Authority therefore lives where a pane cannot reach: role assignment arrives ONLY over
// TerminalChannels.setRole, an ipcMain channel, and panes are PTY children with no IPC —
// they speak the daemon protocol and nothing else. The renderer sends it straight from the
// user's workspace manifest (controller.publishRoles). The daemon keeps its own role map
// for what it is good for — mailbox routing, ledger labels, `mogging list` — and `mogging
// role` still writes it. It just no longer decides who may sign off.
const appRoles = new Map<string, string>()

/** The role the APP assigned to this pane, or undefined. Never what the daemon was told. */
export function appAssignedRole(paneId: string): string | undefined {
  return appRoles.get(paneId)
}

/** Approvals that the app is willing to believe: signed by a pane the USER made a reviewer.
 *  Everything the daemon reports passes through here before it can gate a merge or paint a
 *  ✓ — a self-promoted pane's sign-off is not filtered late, it is simply never an approval. */
export function authoritativeApprovals(list: readonly Approval[]): Approval[] {
  return list.filter((a) => appAssignedRole(a.byPaneId) === 'reviewer')
}

/** The live sign-off list, already filtered to app-assigned reviewers. Fails CLOSED: no
 *  daemon, no approvals (the review gate's existing stance). */
export async function getAuthoritativeApprovals(): Promise<Approval[]> {
  const list = (await activeClient?.queryApprovals()) ?? []
  return authoritativeApprovals(list)
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
  const cwdRevisions = new Map<string, { connection: number; gen: number; revision: number }>()
  let nextConnection = 0
  let activeConnection = 0
  /** Last gate-passing state per pane — the answer to the renderer's stateSync PULL.
   *  Push alone cannot keep the dot honest: the daemon emits state on CHANGE only, and
   *  a welcome replay fired before a pane's listener existed (app boot, renderer
   *  reload) is simply lost. Fed by onState/onWelcome, emptied with the session. */
  const lastStates = new Map<string, AgentState>()

  const makeClient = async (): Promise<DaemonClient> => {
    const endpoint = await ensureDaemon(daemonEntry)
    const connection = ++nextConnection
    activeConnection = connection
    cwdRevisions.clear()
    const generation = (gen: number): string => `${endpoint.pid}:${connection}:${gen}`
    const c: DaemonClient = new DaemonClient(endpoint, {
      // Fired from `spawned`/`attached` BEFORE their scrollback replay, so the replay
      // itself passes the gate it establishes.
      onGen: (id, gen) => {
        if (connection !== activeConnection) return
        if (gens.get(id) !== gen) cwdRevisions.delete(id)
        gens.set(id, gen)
      },
      onData: (id, data, gen) => {
        if (current(id, gen)) getWebContents()?.send(TerminalChannels.data, { id: Number(id), data })
      },
      onExit: (id, exitCode, gen) => {
        if (!current(id, gen)) return // a dead generation's late exit — not this pane's news
        specs.delete(id) // an exited pane must not be resurrected by a reconnect replay
        lastStates.delete(id) // no session, no state — a late sync must not repaint a dead pane
        cwdRevisions.delete(id)
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
        if (connection !== activeConnection) return
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
      onCwd: (id, cwd, gen, revision, source, locality) => {
        if (connection !== activeConnection || !current(id, gen)) return
        const previous = cwdRevisions.get(id)
        if (previous && previous.connection === connection && previous.gen === gen && revision < previous.revision) return
        cwdRevisions.set(id, { connection, gen, revision })
        getWebContents()?.send(TerminalChannels.cwd, {
          id: Number(id),
          cwd,
          generation: generation(gen),
          revision,
          source,
          locality
        })
      },
      onOwners: (claims) => getWebContents()?.send(LedgerChannels.owners, { claims }),
      onLimit: (id, gen) => {
        if (current(id, gen)) getWebContents()?.send(TerminalChannels.limit, { id: Number(id) })
      },
      // Typed-launch detection: the daemon watched the pane's PTY subtree and an agent CLI
      // appeared (or left). Gen-gated like every other pane event — a dead generation's
      // verdict must never claim the reused id's brand-new pane.
      onAgent: (id, agentId, cwd, sinceMs, gen) => {
        if (current(id, gen)) getWebContents()?.send(TerminalChannels.agent, { id: Number(id), agentId, cwd, sinceMs })
      },
      // Filtered at the boundary, not at the consumer: this push paints the board's
      // "Approved by the reviewer" ✓, and a chip that lies is the same bug as a gate that
      // opens. A self-promoted pane's sign-off never becomes an approval anywhere in the app.
      onApprovals: (list) => getWebContents()?.send(GateChannels.approvals, { list: authoritativeApprovals(list) }),
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
    const confirmedRemotes = (getSettingsStore()?.listRemotes() ?? [])
      .map((remote) => normalizeRemoteConnection(remote))
      .filter((remote): remote is NonNullable<typeof remote> => !!remote)
    const migration = await migrateOlderDaemonSessions(confirmedRemotes)
    if (migration === 'deferred') throw new DaemonMigrationDeferredError()
  } catch (err) {
    if (err instanceof DaemonMigrationDeferredError) throw err
    getTelemetry().captureError(err, { feature: 'daemon', op: 'migrate', platform: process.platform })
  }

  client = await makeClient()
  activeClient = client
  seed(client)

  ipcMain.handle(TerminalChannels.spawn, async (_e, req: SpawnRequest): Promise<SpawnResult> => {
    // Remote pane (4/05): the renderer names a host ID; MAIN resolves the row here
    // (the daemon stays db-free, values never round-trip the renderer).
    let remote: SpawnSpec['remote']
    if (req.remoteHostId) {
      const raw = getSettingsStore()?.listRemotes().find((h) => h.id === req.remoteHostId)
      const row = sanitizeRemote(raw)
      if (!raw || raw.platform !== 'posix' || !row || row.id !== req.remoteHostId || row.platform !== 'posix') {
        throw new Error(`Remote host is unavailable or unsupported: ${req.remoteHostId}`)
      }
      remote = {
        name: row.name,
        host: row.host,
        user: row.user,
        port: row.port,
        cwd: normalizeRequestedRemoteCwd(req.remoteCwd),
        platform: 'posix'
      }
    } else if (req.remoteCwd !== undefined) {
      throw new Error('A remote working directory requires a remote host')
    }
    // Vault service keys (8/08): resolved HERE, in main, into the per-pane env —
    // the renderer never sees a value; the daemon merges it into the PTY env
    // (never typed, so no secret in scrollback/sessions.db). Remote panes get
    // none: the key would ride SSH to another machine (not our env to hand out).
    const env = remote ? undefined : resolveServiceKeyEnv()
    const spec: SpawnSpec = { cwd: remote ? undefined : req.cwd, cols: req.cols, rows: req.rows, remote, env }
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
    cwdRevisions.delete(String(cmd.id))
    // A role dies with the SLOT, not with the process. Pane ids are reused (a split takes
    // the lowest free one), so a reviewer's id outliving its pane would hand reviewer
    // authority to whatever opens there next — which the renderer, having no role to push
    // for an ordinary pane, would never correct. Closing the pane retires the assignment;
    // the app must name a reviewer again. (Deliberately NOT cleared on process exit: a
    // reviewer whose agent quit still reviewed the branch, and their sign-off stands.)
    appRoles.delete(String(cmd.id))
    client.kill(String(cmd.id))
  })
  // The dot's reliability contract: a mounting pane PULLS its current state (the
  // in-proc backend serves the same channel from tracker truth — one backend at a time).
  ipcMain.handle(TerminalChannels.stateSync, (_e, req: StateSyncRequest) =>
    lastStates.get(String(req.id)) ?? null
  )
  ipcMain.on(TerminalChannels.setRole, (_e, cmd: SetRoleCommand) => {
    // THE trusted channel (see appRoles): this arrives from the renderer — the user's own
    // manifest — and a pane has no way to send it. Recorded here as the app's answer to
    // "who is a reviewer", then forwarded so the daemon's coordination map agrees with the UI.
    appRoles.set(String(cmd.id), cmd.role)
    client.setRole(String(cmd.id), cmd.role)
  })

  return () => {
    disposed = true // stops the reconnect loop; a close caused by our own dispose stays quiet
    activeClient = null
    client.dispose()
  }
}
