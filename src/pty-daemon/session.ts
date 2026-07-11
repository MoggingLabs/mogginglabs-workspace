// The daemon's terminal multiplexer: it OWNS the node-pty processes and a per-pane
// scrollback ring buffer, and fans output out to any number of attached clients. This is
// purpose-built for the daemon (multi-client + reconnect + scrollback), which is why it
// does not reuse @backend's single-client PtyService. (ADR 0006.)
//
// It also PERSISTS sessions (cwd + command label + scrollback) to a small store, so the
// daemon self-recovers on a cold start / crash and repaints prior scrollback (Phase-1/03).
import * as os from 'node:os'
import * as fs from 'node:fs'
import { spawnPty, type IPty } from '@backend/platform/pty-host'
import { shellIntegrationEnv } from '@backend/platform/shell'
import type { Approval, SpawnSpec, PaneInfo, AgentState } from '@contracts'
import { notifyEventToState } from '@contracts'
import { ActivityTracker, AgentProcessDetector, OscParser, fileUriToPath, isTerminalReply, type DetectedAgentProc } from '@backend/features/agent-state'
import { SessionStore, resumeCommandFor } from '@backend/features/workspace'
import { Mailbox } from './mailbox'
import { Ledger } from './ledger'
import type { PersistedPane, PersistedWorkspace, WorkspaceLayout } from '@contracts'

const SCROLLBACK_BYTES = 200_000

/** The directory a pane's shell starts in: the requested one when it is a real directory,
 *  the home directory otherwise. `''` (no cwd asked for) and a path that has since been
 *  removed both land on home rather than on the daemon's own directory or a spawn error. */
function pickCwd(requested?: string): string {
  if (requested) {
    try {
      if (fs.statSync(requested).isDirectory()) return requested
    } catch {
      /* gone, or not readable — fall through to home */
    }
  }
  return os.homedir()
}

export interface PaneSubscriber {
  send(data: string): void
  exit(code: number): void
  state(state: AgentState): void
  cwd(path: string): void
  /** Usage-limit signal (Phase-4/04): distinct from state so failover can act. */
  limit?(): void
  /** Typed-launch detection: an agent CLI process appeared in / vanished from the
   *  pane's PTY subtree (process-table truth, not output heuristics). */
  agent?(agentId: string | null, cwd?: string, sinceMs?: number): void
}

interface PaneHooks {
  onExit: () => void
  onChange: () => void
  /** Something in this pane may have STARTED or ENDED a command (an activity-state edge, or
   *  a submitted line). The agent-process detector spends its one process snapshot here —
   *  see agent-state/agent-proc.ts for why that is the whole cost model. */
  onCommandEdge: () => void
}

class PaneSession {
  readonly id: string
  /** Session generation (v5): minted by the SessionManager, monotonic per daemon lifetime.
   *  Pane IDS are reused; (id, gen) is what actually names ONE session on the wire. */
  readonly gen: number
  readonly cwd: string
  readonly command?: string
  readonly remoteName?: string
  cols: number
  rows: number
  private proc: IPty
  private buffer = ''
  private lastState: AgentState = 'idle'
  private readonly tracker: ActivityTracker
  private lastCwd?: string // last OSC-7-reported cwd; replayed to (re)attaching clients
  /** The agent process the detector last saw in this pane's subtree (typed-launch
   *  detection) — replayed to (re)attaching clients so an app restart re-learns a
   *  hand-typed session it never launched. */
  private lastAgent: { agentId: string; cwd: string; sinceMs: number } | null = null
  private subs = new Set<PaneSubscriber>()
  private readonly hooks: PaneHooks
  /** True while this session is an UNTOUCHED cold-start restore: a fresh shell repainting
   *  persisted scrollback, with no live agent in it and nothing typed since. The app reads
   *  it (via `spawned.restored`) to decide that resume must TYPE — the opposite of a true
   *  reattach. Cleared by the first client input, and never set when the daemon itself
   *  typed a resume command (that pane is already handling its own continuity). */
  private pristineRestore: boolean

  constructor(
    id: string,
    gen: number,
    spec: SpawnSpec,
    hooks: PaneHooks,
    restore?: { scrollback: string; resumeCommand?: string | null },
    extraEnv: Record<string, string> = {}
  ) {
    this.id = id
    this.gen = gen
    this.hooks = hooks
    this.cols = spec.cols ?? 80
    this.rows = spec.rows ?? 24
    // `||`, not `??`: an EMPTY string is not a cwd. `??` let '' through to node-pty, which
    // then inherits the daemon's own working directory — the app's install folder, since
    // the daemon is spawned from the packaged binary. A plain terminal therefore opened in
    // `…\Programs\MoggingLabs Workspace` no matter which folder the wizard picked.
    //
    // The existsSync is the other half. Now that a REAL path arrives here (it used to be
    // '' always), a stale one — a worktree pruned between sessions, a folder the user moved
    // — would make pty.spawn throw and the pane would never open at all. A terminal in the
    // wrong directory is a bug; a terminal that does not exist is worse.
    this.cwd = pickCwd(spec.cwd)
    this.command = spec.run
    this.remoteName = spec.remote?.name
    if (restore?.scrollback) this.buffer = restore.scrollback // seed prior output for repaint
    // Pristine only when the daemon is NOT typing the resume itself (see field doc).
    this.pristineRestore = !!restore && !restore.resumeCommand

    const isWin = process.platform === 'win32'
    let shell = spec.shell ?? (isWin ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash')
    let args = spec.args ?? (isWin ? [] : ['-l'])
    // Remote pane (4/05): the pane process IS `ssh -tt [-p port] [user@]host` — arg
    // ARRAY, no shell interpolation; the user's ssh stack does all auth (ADR 0002).
    // Exit of ssh = pane exit (existing semantics). MOGGING_SSH_SHIM is a test-only
    // stand-in (a node script) so smokes never need a network.
    if (spec.remote) {
      const r = spec.remote
      const sshArgs = ['-tt', ...(r.port ? ['-p', String(r.port)] : []), (r.user ? r.user + '@' : '') + r.host]
      const shim = process.env.MOGGING_SSH_SHIM
      if (shim) {
        // Test shim: a batch/shell script — run via the PLATFORM shell (running it
        // through process.execPath would boot Electron's GUI, not a script).
        if (isWin) {
          shell = process.env.COMSPEC || 'cmd.exe'
          args = ['/c', shim, ...sshArgs]
        } else {
          shell = 'sh'
          args = [shim, ...sshArgs]
        }
      } else if (isWin) {
        shell = 'ssh.exe'
        args = sshArgs
      } else {
        shell = 'ssh'
        args = sshArgs
      }
    }
    // Inject this pane's identity + how to reach the daemon so a command inside the pane can
    // target ITSELF via `mogging notify` (Phase-2/04). Only the pane id + the endpoint FILE path
    // go in the env — never the auth token (that stays in the 0600 endpoint file), so the token
    // can't leak through env dumps / agent context (ADR 0002).
    this.proc = spawnPty(shell, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      // spec.env (Phase-8/08): per-pane env the APP resolved (vault service
      // keys) — merged into the process env only, NEVER typed into the pane, so
      // a secret never lands in scrollback/sessions.db. Source-agnostic: the
      // daemon knows nothing of the vault. MOGGING_PANE_ID wins (identity).
      // shellIntegrationEnv makes the shell REPORT its cwd (cmd.exe never did): per-pane
      // git follows a `cd`, and a hand-typed agent's session log can be found at all.
      env: {
        ...process.env,
        ...shellIntegrationEnv(shell),
        ...extraEnv,
        ...(spec.env ?? {}),
        MOGGING_PANE_ID: this.id
      } as Record<string, string>
    }).proc
    // Pane state = the ActivityTracker's verdict (the dot in the pane header). The
    // OSC parser feeds it explicit signals (133 C/D, 9/99/777, the bell) but no
    // longer drives the wire directly — on real setups those signals barely exist
    // (cmd.exe and Claude Code both emit no OSC 133), which left the dot frozen on
    // 'idle' forever. The tracker fuses them with OUTPUT ACTIVITY (streaming =
    // working, quiet = idle) and latches attention until the user answers
    // (tracker semantics + precedence: agent-state/activity.ts).
    this.tracker = new ActivityTracker((state) => {
      this.lastState = state
      for (const s of this.subs) s.state(state)
      // An activity EDGE is the cheap "a command started/ended here" signal the agent-process
      // detector spends its snapshot on. A streaming agent stays busy — one edge, not one per
      // chunk — so an idle wall of panes and a running agent both cost nothing.
      hooks.onCommandEdge()
    })
    const osc = new OscParser(
      (state) => this.tracker.notify(state),
      (ev) => {
        if (ev.kind === 'bell') this.tracker.bell()
        if (ev.kind === 'cwd' && ev.payload) {
          // De-duped on VALUE: a cmd.exe pane reports its cwd twice per prompt (OSC 9;9 +
          // OSC 7 — whichever survives ConPTY), and an unchanged cwd is not news.
          const cwd = fileUriToPath(ev.payload)
          if (cwd && cwd !== this.lastCwd) {
            this.lastCwd = cwd
            for (const s of this.subs) s.cwd(cwd)
          }
        }
      }
    )
    this.proc.onData((d) => {
      this.buffer = (this.buffer + d).slice(-SCROLLBACK_BYTES)
      this.tracker.data() // BEFORE the parse: a verdict in this chunk must land last
      osc.push(d)
      for (const s of this.subs) s.send(d)
      hooks.onChange()
    })
    this.proc.onExit(({ exitCode }) => {
      this.tracker.dispose()
      for (const s of this.subs) s.exit(exitCode)
      this.subs.clear()
      hooks.onExit()
    })
    // Fresh panes run their launch command. RESTORED panes repaint prior scrollback in a fresh
    // shell at the same cwd, and relaunch a known agent via its own resume (step 4) — never a
    // frozen process; a pane with no resumable agent just restores its shell.
    if (spec.run && !restore) this.proc.write(spec.run + '\r')
    else if (restore?.resumeCommand) this.proc.write(restore.resumeCommand + '\r')
  }

  get scrollback(): string {
    return this.buffer
  }
  /** The pane shell's pid — the root the agent-process detector walks from. */
  get pid(): number {
    return this.proc.pid
  }
  /** Remote panes run ssh locally — nothing in their local subtree is the agent. */
  get isRemote(): boolean {
    return !!this.remoteName
  }
  /** Detector verdict changed: resolve WHERE the agent runs, remember it (replayed on
   *  subscribe), and fan it out. The agent's own cwd is exact where the platform reports it
   *  (POSIX); on Windows it falls back to the pane's reported cwd — the OSC-7/9;9 prompt the
   *  shell now emits — and finally to the cwd the pane was spawned in. That path names the
   *  CLI's session log, so getting it right IS the feature. */
  applyAgentProc(det: DetectedAgentProc | null): void {
    this.lastAgent = det
      ? { agentId: det.agentId, cwd: det.cwd ?? this.lastCwd ?? this.cwd, sinceMs: det.sinceMs }
      : null
    for (const s of this.subs) s.agent?.(this.lastAgent?.agentId ?? null, this.lastAgent?.cwd, this.lastAgent?.sinceMs)
  }
  /** Still an untouched cold-start restore? (See `pristineRestore` — the app's cue that
   *  resume must type here.) */
  get restoredPristine(): boolean {
    return this.pristineRestore
  }
  info(): PaneInfo {
    return {
      id: this.id,
      gen: this.gen,
      cols: this.cols,
      rows: this.rows,
      title: this.command, // launch label only (e.g. "claude") — never a command line
      cwd: this.lastCwd ?? this.cwd,
      state: this.lastState,
      remoteName: this.remoteName
    }
  }
  /** Control API (Phase-3/01): the retained scrollback tail, capped at 10000 lines.
   *  Returned to the requesting client ONLY — never persisted beyond the session
   *  store's existing scrollback, never logged, never telemetry. */
  captureTail(lastLines?: number): string {
    const cap = Math.min(Math.max(1, Math.floor(lastLines ?? 1000)), 10000)
    const lines = this.buffer.split('\n')
    return lines.slice(-cap).join('\n')
  }
  snapshot(): PersistedPane {
    return {
      id: this.id,
      workspaceId: 'default',
      cwd: this.cwd,
      command: this.command,
      scrollback: this.buffer,
      updatedAt: Date.now()
    }
  }
  subscribe(s: PaneSubscriber): void {
    this.subs.add(s)
    s.state(this.lastState) // replay current agent-state to a (re)attaching client
    if (this.lastCwd) s.cwd(this.lastCwd) // ...and the last known cwd (only if OSC 7 reported one)
    // ...and the agent DETECTED in this pane: an app restart reattaches to a session the
    // daemon kept alive, and this replay is how the new app learns what runs in it — the
    // one path by which a hand-typed agent survives a restart with its identity intact.
    if (this.lastAgent) s.agent?.(this.lastAgent.agentId, this.lastAgent.cwd, this.lastAgent.sinceMs)
  }
  unsubscribe(s: PaneSubscriber): void {
    this.subs.delete(s)
  }
  /** `mogging notify` (Phase-2/04): map an explicit agent/hook event to a pane state and fan it
   *  out just like an OSC state change, so it flows through the same state -> attention pipeline
   *  (badge chip + workspace-tab ring). Replayed to (re)attaching clients via lastState. */
  applyNotify(event: string): void {
    // Routed through the tracker so notify keeps its latch/clear semantics (an
    // explicit busy/idle releases an attention latch; attention latches).
    this.tracker.notify(notifyEventToState(event))
    // Usage-limit (4/04): a DISTINCT signal alongside the attention state, so the
    // app can offer profile failover. Event label only — never content.
    if (event === 'usage-limit') for (const s of this.subs) s.limit?.()
  }
  write(data: string): void {
    // xterm's auto-replies (CPR/DA/focus/color reports — re-emitted for every query
    // in a reattach's scrollback replay) ride this same channel but are NOT a human
    // touching the pane: they must not clear the attention latch (a red pane went
    // yellow across every renderer reload) nor mark a pristine restore as touched.
    if (isTerminalReply(data)) {
      this.proc.write(data)
      return
    }
    this.pristineRestore = false // touched: from here on it's a live shell, not a restore
    this.tracker.input() // typing answers whatever the pane was blocked on
    // A submitted LINE is the most precise "a command is starting" signal there is — it beats
    // the output edge to the punch, so a hand-typed `claude` is detected as it boots.
    if (data.includes('\r') || data.includes('\n')) this.hooks.onCommandEdge()
    this.proc.write(data)
  }
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    try {
      this.proc.resize(cols, rows)
    } catch {
      /* pane may be exiting */
    }
  }
  kill(): void {
    this.tracker.dispose()
    try {
      this.proc.kill()
    } catch {
      /* already gone */
    }
  }
}

export class SessionManager {
  private panes = new Map<string, PaneSession>()
  /** Generation mint (v5): one stamp per PaneSession ever created by THIS daemon.
   *  Uniqueness within the daemon's lifetime is all clients need — a reconnecting
   *  client re-learns current gens from `welcome`/`spawned`, never from memory. */
  private nextGen = 1
  private persistTimer?: NodeJS.Timeout
  /** Swarm substrate (Phase-4/01): the daemon-owned mailbox + role manifest. */
  readonly mailbox = new Mailbox()
  /** Ownership ledger (Phase-4/02): claims die with their pane. */
  readonly ledger = new Ledger()
  /** Reviewer gate (Phase-4/03): branch sign-offs. Memory-only coordination data. */
  readonly approvals = new Map<string, Approval>()
  /** Typed-launch detection: ONE detector across all panes (one process snapshot per
   *  probe, edge-driven by pane output). Verdicts land on the pane and fan to clients. */
  private readonly agentProcs = new AgentProcessDetector((id, det) => this.panes.get(id)?.applyAgentProc(det))

  // extraEnv is injected into every pane's shell env (e.g. MOGGING_DAEMON_ENDPOINT for notify).
  constructor(
    private readonly store: SessionStore,
    private readonly extraEnv: Record<string, string> = {}
  ) {}

  has(id: string): boolean {
    return this.panes.has(id)
  }
  count(): number {
    return this.panes.size
  }
  list(): PaneInfo[] {
    return [...this.panes.values()].map((p) => ({ ...p.info(), role: this.mailbox.roleOf(p.id) }))
  }
  get(id: string): PaneSession | undefined {
    return this.panes.get(id)
  }
  snapshotAll(): PersistedPane[] {
    return [...this.panes.values()].map((p) => p.snapshot())
  }

  /** The current single default workspace + its (flat) layout. Steps 04/05 add real
   *  workspaces + a split tree; this persists the pane arrangement that exists today. */
  workspaces(): PersistedWorkspace[] {
    const layout: WorkspaceLayout = { v: 1, panes: [...this.panes.keys()] }
    return [{ id: 'default', name: 'Workspace', layout: JSON.stringify(layout), updatedAt: Date.now() }]
  }

  private persist(): void {
    this.store.savePanes(this.snapshotAll())
    this.store.saveWorkspaces(this.workspaces())
  }

  private hooks(id: string, self: () => PaneSession): PaneHooks {
    return {
      onExit: () => {
        // Identity-guarded: a killed pane's exit event lands ASYNC (the pty dies after
        // remove() already deleted it), and by then a reused id may hold a brand-new
        // session. An unguarded delete orphaned that live session from the map — and
        // wrongly cleared the NEW pane's role and claims.
        if (this.panes.get(id) === self()) {
          this.panes.delete(id)
          this.mailbox.clearRole(id)
          this.ledger.clearPane(id) // exits release territory immediately (4/02)
          this.agentProcs.untrack(id) // no pty, no subtree to watch
        }
        this.schedulePersist(500)
      },
      onChange: () => this.schedulePersist(2000),
      onCommandEdge: () => this.agentProcs.poke(id)
    }
  }

  /** Start watching a pane's subtree for agent processes. REMOTE panes are skipped: their
   *  agent runs on the far machine and the only thing in our local subtree is `ssh`. */
  private trackAgentProcs(pane: PaneSession): void {
    if (!pane.isRemote) this.agentProcs.track(pane.id, pane.pid)
  }

  /** Spawn or return the existing pane (id-guard across the process boundary — a
   *  reconnecting client re-requesting the same id ATTACHES, never duplicates). */
  ensure(id: string, spec: SpawnSpec): { pane: PaneSession; existed: boolean } {
    const existing = this.panes.get(id)
    if (existing) return { pane: existing, existed: true }
    // `pane` is referenced lazily by the hook (onExit fires long after construction).
    const pane: PaneSession = new PaneSession(id, this.nextGen++, spec, this.hooks(id, () => pane), undefined, this.extraEnv)
    this.panes.set(id, pane)
    this.trackAgentProcs(pane)
    this.schedulePersist(500)
    return { pane, existed: false }
  }

  /** Cold-start restore: re-create persisted panes (fresh shell at cwd + seeded scrollback).
   *  Only runs into an empty manager. Returns how many panes were restored. */
  restore(): number {
    if (this.panes.size > 0) return 0
    this.store.loadWorkspaces() // load persisted workspaces (layout consumed by the app in 04/05)
    const persisted = this.store.loadPanes()
    for (const p of persisted) {
      const spec: SpawnSpec = { cwd: p.cwd, run: p.command }
      // Relaunch a known agent via its own resume (step 4) — never a frozen process.
      const resumeCommand = resumeCommandFor(p.command)
      const pane: PaneSession = new PaneSession(p.id, this.nextGen++, spec, this.hooks(p.id, () => pane), { scrollback: p.scrollback, resumeCommand }, this.extraEnv)
      this.panes.set(p.id, pane)
      this.trackAgentProcs(pane)
    }
    return persisted.length
  }

  /** Coalesced background write (scrollback churns constantly). */
  schedulePersist(delayMs = 2000): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.persist()
    }, delayMs)
  }

  /** Flush synchronously (e.g. on graceful shutdown). */
  persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    this.persist()
  }

  remove(id: string): void {
    const p = this.panes.get(id)
    if (p) {
      p.kill()
      this.panes.delete(id)
      this.mailbox.clearRole(id) // pane ids get reused — a role never outlives its pane
      this.ledger.clearPane(id)
      this.agentProcs.untrack(id) // ...nor does an agent verdict
      this.schedulePersist(500)
    }
  }
  killAll(): void {
    for (const p of this.panes.values()) p.kill()
    this.panes.clear()
    this.agentProcs.dispose()
  }
}

export type { PaneSession }
