// Protocol between the Electron app (client) and the detached PTY daemon (server).
// This is a versioned CONTRACT: the socket/pipe name embeds the version, so an app
// update never speaks an incompatible protocol to an old daemon (ADR 0006 — the
// tmux "kill-server on upgrade" pitfall). Depends on nothing (pure types + helpers).

import type { AgentState } from '../domain/agent'
import type { PaneCwdLocality, PaneCwdSource } from '../domain/cwd'
import type { RemotePaneTarget } from '../domain/remote'
import type { PersistedWorkspace } from '../ipc/workspace.ipc'
import type { PtyEmulation } from '../ipc/terminal.ipc'
import type { ReviewSnapshot } from '../ipc/review.ipc'

// v10: the swarm coordination verbs are pane-bound. `mail-send`, `claim` and `release`
// gained an optional `token` — the sender's own MOGGING_PANE_TOKEN — and the daemon now
// REFUSES a pane sender (from ≠ '0') that does not present it, exactly as `approve` and
// `cwd-report` already did. Pane ids are public (`mogging list` prints them) and every
// pane can read the 0600 endpoint file and authenticate, so `from` alone was a claim, not
// a fact: one agent could mail the swarm AS the reviewer, or `release --all` a sibling's
// territory. A v9 daemon would keep accepting those forged, unbound verbs until it retires,
// so the bump forces the hand-off (daemon-migrate.ts) rather than pretending the check is
// an additive add — a security boundary must not depend on which daemon happens to answer.
//
// v10 ALSO carries the daemon-lifecycle wire (one release, one bump): `hello` gained an
// optional client identity (daemon.log's "shutdown requested by …" names its requester)
// and `welcome` gained `otherClients` — the count the stamp-war retire guard needs before
// it may fire (daemon-client.ts ensureDaemon: a mismatched daemon with a live client is
// left running; retiring it starts a war that kills every pane's process each round).
export const DAEMON_PROTOCOL_VERSION = 10

// v9: burned by v0.11.1 to DELIVER a daemon-side behaviour fix (the tracker's done-chime
// grace — a finished turn's own bell no longer latches the pane red). The fix changed no
// wire at all, and that is the point of recording it: a surviving v8 daemon would have kept
// running the buggy tracker forever, and only a version burn could retire it. This burn is
// what motivated ADR 0012's split — DaemonEndpoint.build (the stamp, below) now answers
// "is the running daemon's CODE current?", so a behaviour fix never burns a version again.
// v8: AgentState grew `done` and `unknown` — states the DAEMON emits (the verdict law:
// green has exactly one source). A surviving v7 daemon would never emit `done`, so every
// green in the product would have quietly died for anyone who upgraded without a reboot —
// no error, no gate. The bump forces the migrate-and-retire hand-off; the wire-shape
// fingerprint in check-protocol-version.mjs landed alongside so an unbumped wire change
// of this class can never ship silently again.
// v7: pane-originated state is capability-bound. Cwd is a first-class declaration; every cwd
// event carries source, locality, and a per-generation revision, and `cwd-report` requires the
// session-only pane token. Reviewer sign-offs require that same pane credential AND bind to
// repository identity plus exact source/base commits (a branch-only approval cannot satisfy the
// review boundary). A v6 daemon would silently ignore cwd reports and accept unbound, branch-only
// approvals, so the version bump forces the normal session hand-off instead of pretending these
// are additive v6 assumptions.
// v6: the daemon KNOWS which agent CLI runs in each pane — it watches the pane's PTY subtree
// in the process table and reports it (`agent`), instead of knowing only what the app itself
// typed. That is what gives a hand-typed `claude` the same identity as a launched one (context
// gauge, provider mark, resume), and it is also why the bump exists rather than a
// backward-compatible add: the daemon SURVIVES app updates by design, so a v5 daemon — which
// has no detector and injects no shell-integration env — would keep every pane it owns blind
// to typed launches until the machine reboots. The bump retires it through the existing
// hand-off (daemon-migrate.ts): its live panes are captured, it shuts down, and the v6 daemon
// restores them with resume. Same enforcement reasoning as v5 and v4 below.
// v5: pane sessions are GENERATIONAL. Every pane-scoped server event (data/exit/state/cwd/
// limit) and every attach point (spawned/attached/welcome PaneInfo) carries the session's
// `gen` — a per-daemon monotonic stamp minted when the PaneSession is created. Pane IDS are
// reused (a split takes the lowest free slot), so id alone cannot distinguish a killed pane's
// in-flight events from its successor's: an untagged late exit printed "[process exited]"
// into a brand-new healthy pane and deleted its reconnect-replay spec, and an untagged
// subscription map made a reused id's session start with zero subscribers (the empty-terminal
// bug). A v4 daemon cannot stamp generations, so it must not be attached to — the bump is the
// enforcement, exactly as v4 did for pty emulation (defaulting the field would reintroduce
// the id-only inference this change deletes).
// v4: `spawned` carries the pty's emulation (ConPTY vs posix). A v3 daemon CANNOT answer that
// question — it never asked node-pty which backend it got — so it must not be reattached to. The
// version bump is the enforcement: the runtime dir + socket embed it, so a v3 daemon keeps running
// untouched and a v4 app spawns its own. Defaulting the field instead would reintroduce, in the
// one path nobody tests, exactly the renderer-side inference this change deletes.
// v3: Phase-4/01 swarm substrate — mailbox (mail-send/mail-read), per-pane roles
// (set-role, PaneInfo.role). v2: Phase-3/01 control API — send-key/capture + enriched
// PaneInfo. The version namespaces the runtime dir + socket, so older daemons keep
// running untouched (ADR 0006 anti-kill-server); the app + CLI speak their own version.

// ── Release channel (dev/prod isolation) ───────────────────────────────────────────────
// A repo checkout and an installed release must be able to run SIDE BY SIDE with zero shared
// surfaces ("work on the app while using any release"). Version namespacing alone cannot give
// that: the moment a release ships the protocol version dev is on, run/v<N> collides again.
// So every per-user runtime surface is namespaced by CHANNEL as well:
//   prod:  …/MoggingLabs/run/v4      mogging://
//   dev:   …/MoggingLabs/run/dev-v4  mogging-dev://
// The channel is DERIVED once, in the app's main (packaged -> prod, repo checkout -> dev), and
// travels ONLY as the MOGGING_CHANNEL env var: the daemon inherits it at spawn, panes inherit it
// from the daemon (so `mogging` run inside a dev pane targets the dev channel with no flags), and
// the CLIs read it. A packaged app clears it at startup — channel is derived, never trusted up.
export type ReleaseChannel = 'prod' | 'dev'

/** The channel this PROCESS is in. Main sets/clears MOGGING_CHANNEL before anything reads it. */
export const channelFromEnv = (): ReleaseChannel => (process.env.MOGGING_CHANNEL === 'dev' ? 'dev' : 'prod')

/** The run/<segment> directory name. Keep in sync with bin/mogging.mjs + bin/mogging-mcp.mjs
 *  (plain Node, cannot import this) — scripts/check-protocol-version.mjs gates the drift. */
export const runtimeSegment = (channel: ReleaseChannel): string =>
  (channel === 'dev' ? 'dev-v' : 'v') + DAEMON_PROTOCOL_VERSION

/** The deep-link scheme. Separate per channel or the OS association is winner-takes-all: both
 *  apps re-register on every launch, so `mogging open` would land on whichever ran LAST. */
export const deepLinkScheme = (channel: ReleaseChannel): string => (channel === 'dev' ? 'mogging-dev' : 'mogging')

// ── Swarm substrate (Phase-4/01) ───────────────────────────────────────────────
export const SWARM_ROLES = ['architect', 'worker', 'reviewer'] as const
export type SwarmRole = (typeof SWARM_ROLES)[number]

/** One coordination message. Body is USER/AGENT content: it lives in the daemon's
 *  in-memory ring buffer ONLY — never telemetry, logs, notify payloads, or disk. */
export interface MailMessage {
  id: number
  /** Sender pane id ('0' = external/human — no pane binding on that connection). */
  from: string
  role?: SwarmRole
  /** Recipient pane id, or 'all' (the default). */
  to: string
  body: string
  ts: number
}

export const MAIL_BODY_MAX = 16384 // 16 KB per message
export const MAIL_RING_MAX = 500 // ring buffer — coordination, not a database

// ── Exclusive file-ownership ledger (Phase-4/02) ───────────────────────────────
/** One live claim: a pane owns a repo-relative glob. In-memory; auto-released when
 *  the pane's session exits. Patterns are PATHS: local state only, never telemetry. */
export interface Claim {
  id: number
  paneId: string
  role?: SwarmRole
  pattern: string
  ts: number
}

export const CLAIM_PATTERN_MAX = 256

// ── Reviewer gate (Phase-4/03) ─────────────────────────────────────────────────
/** A reviewer sign-off for a branch. Memory-only coordination data — never persisted,
 *  never telemetered. The ROLE is resolved daemon-side from the pane manifest; a client
 *  cannot claim reviewer-ness in a payload. WHICH pane is speaking is proven by the
 *  approve message's mandatory `token` (that pane's env-only MOGGING_PANE_TOKEN) — the
 *  pane id alone is public (`mogging list` prints it), was on its own forgeable by any
 *  pane that shares the user's daemon, and is never identity proof. */
export interface Approval {
  snapshot: ReviewSnapshot
  /** Convenience display/index fields; must equal snapshot.branch/repoId. */
  branch: string
  repoId: string
  byPaneId: string
  byRole: SwarmRole
  ts: number
}

/** Validate + normalize a claim pattern: repo-relative glob, forward slashes, no
 *  `..`, no absolute/drive roots. Returns null when the shape is unacceptable. */
export function normalizeClaimPattern(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const p = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!p || p.length > CLAIM_PATTERN_MAX) return null
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null // absolute / drive root
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return null
  return p
}

/** Conservative glob-vs-glob overlap: only a PURE-LITERAL segment mismatch proves
 *  the branches diverge — `**`, `*`, partial wildcards, prefix containment all count
 *  as overlap. When in doubt, DENY (the ledger is a referee, not an oracle). */
export function claimsOverlap(a: string, b: string): boolean {
  const sa = a.split('/')
  const sb = b.split('/')
  for (let i = 0; ; i++) {
    const x = sa[i]
    const y = sb[i]
    if (x === undefined || y === undefined) return true // equal or prefix-contained
    if (x === '**' || y === '**') return true
    // Only a pure-literal mismatch proves divergence. A wildcard segment on either
    // side may or may not match — the walk continues as if it did, so a later
    // literal-vs-literal mismatch can still separate the branches; anything else
    // reaches the end and denies (the conservative default).
    if (!x.includes('*') && !y.includes('*') && x !== y) return false // proven divergence
  }
}

/** Discovery record the daemon writes and the client reads (mode 0600). */
export interface DaemonEndpoint {
  version: number
  address: string // named pipe path (Windows) or unix socket path (macOS/Linux)
  token: string // random per-daemon auth token; the client must present it in `hello`
  pid: number
  /** The BUILD STAMP: a hash of the daemon bundle this process was started from, self-taken at
   *  startup. The version above answers "can we speak?"; this answers the question the version
   *  was never fit to carry: "is the daemon that is ALREADY RUNNING built from the code I would
   *  spawn?" The daemon outlives the app (ADR 0006), so after an update the app reconnects to a
   *  process still running last release's code — same wire, stale behaviour. On a mismatch the
   *  app retires it gracefully IN PLACE (shutdown persists the store; the fresh spawn cold-start
   *  restores) — same dir, no version burned. Optional because daemons predating the stamp never
   *  wrote one; the app treats its absence as a mismatch, which is definitionally correct. */
  build?: string
}

export interface SpawnSpec {
  shell?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
  /** A line typed into the pane right after spawn (e.g. to launch an agent CLI). */
  run?: string
  /** Extra per-pane environment merged into the PTY's process env (Phase-8/08).
   *  The app resolves vault SERVICE KEYS here, pre-spawn, so api-key MCP servers
   *  read them from the env — the value NEVER rides `run`/scrollback (which
   *  persists), so a SECRET never rests in plaintext (ADR 0008.h). The daemon is
   *  source-agnostic: it merges the map into `pty.spawn` and knows nothing of
   *  the vault (no version bump — an optional field on the existing message). */
  env?: Record<string, string>
  /** Remote pane (Phase-4/05): the RESOLVED host row (the daemon stays db-free) — the
   *  ONE shared pointer shape (domain/remote.ts; PersistedPane.remote is the same one). */
  remote?: RemotePaneTarget
}

export interface PaneInfo {
  id: string
  /** Session generation (v5): minted per PaneSession, monotonic per daemon lifetime.
   *  Distinguishes a reused pane id's CURRENT session from a dead predecessor's
   *  in-flight events — clients gate every pane-scoped event on it. */
  gen: number
  cols: number
  rows: number
  /** The pane's launch label (e.g. "claude") — a label only, never a full command line. */
  title?: string
  /** Last known working directory (spawn cwd, refined by OSC 7). */
  cwd?: string
  cwdRevision?: number
  cwdSource?: PaneCwdSource
  cwdLocality?: PaneCwdLocality
  /** Live agent state (idle / busy / attention). */
  state?: AgentState
  /** Swarm role, when the pane has one (Phase-4/01). */
  role?: SwarmRole
  /** Remote pane's host display name (Phase-4/05). */
  remoteName?: string
}

/** Who a daemon connection belongs to — OPTIONAL and additive (old clients send none, old
 *  daemons ignore it). Diagnosis-only: it names the requester in daemon.log when a client
 *  asks for `shutdown`, which is the difference between "the daemon restarted six times last
 *  night" being an archaeology project and being one grep. Never used for authorization —
 *  the token is the only credential, and a self-reported pid proves nothing. */
export interface ClientIdentity {
  pid?: number
  /** Short role label: 'app' (the relay), 'retire', 'probe', 'migrate', 'cli', … */
  kind?: string
}

/** client -> daemon */
export type ClientMessage =
  | { t: 'hello'; v: number; token: string; client?: ClientIdentity }
  | { t: 'spawn'; id: string; spec?: SpawnSpec }
  | { t: 'attach'; id: string }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'kill'; id: string }
  | { t: 'list' }
  | { t: 'verify-pane'; requestId: number; id: string; token: string }
  | { t: 'ping' }
  | { t: 'shutdown' }
  // `mogging notify` (Phase-2/04): an agent/hook inside a pane raises that pane's attention.
  // Carries an event label (+ optional short message) ONLY — never PTY content or credentials.
  | { t: 'notify'; id?: string; event: string; message?: string }
  // Active-context declaration. Endpoint auth proves same-user; the pane token proves THIS pane.
  // `observedAt` orders independent short-lived reporter processes without trusting arrival order.
  | { t: 'cwd-report'; id: string; token: string; cwd: string; observedAt: number }
  // Control API (Phase-3/01): named-key press — `key` is a NAME from CONTROL_KEYS;
  // the daemon maps it to bytes (allowlist — clients never synthesize escapes).
  | { t: 'send-key'; id: string; key: string }
  // Control API (Phase-3/01): return the retained scrollback tail (≤ 10000 lines).
  | { t: 'capture'; id: string; lastLines?: number }
  // Swarm mailbox (Phase-4/01). `from` is the sender's own pane binding (env
  // MOGGING_PANE_ID inside a pane; omitted = external/human -> '0'). The mailbox
  // never pushes into a PTY — readers PULL with mail-read.
  //
  // `token` binds a PANE sender to the pane it names, the same proof `approve` demands:
  // pane ids are public (`mogging list` prints them) and every pane can read the 0600
  // endpoint file and authenticate, so `from` alone was a claim, not a fact — one agent
  // could mail the swarm AS the reviewer, or release another agent's territory. A pane
  // sender without its exact MOGGING_PANE_TOKEN is refused; the human sender ('0',
  // outside any pane) has no token and stays open — the boundary is inter-AGENT trust.
  | { t: 'mail-send'; body: string; to?: string; from?: string; token?: string }
  // Messages for `for` (its own id, or omitted = the human view: everything),
  // with id > since.
  | { t: 'mail-read'; since?: number; for?: string }
  // Swarm manifest: name a pane's role (validated against SWARM_ROLES).
  | { t: 'set-role'; id: string; role: string }
  // Ownership ledger (Phase-4/02). `from` = the claimant pane's own binding
  // (MOGGING_PANE_ID), proven by `token` (see mail-send). The ledger ADVISES — it
  // never blocks PTY writes or file I/O.
  | { t: 'claim'; pattern: string; from: string; token?: string }
  | { t: 'release'; pattern?: string; all?: boolean; from: string; token?: string }
  | { t: 'owners' }
  // Reviewer gate (Phase-4/03). `from` names the approver's pane and the daemon checks
  // THAT pane's role — a payload can never claim a role. `token` is the pane's own
  // MOGGING_PANE_TOKEN (minted per session, injected into that pane's env and nowhere
  // else): it PROVES the sender is running inside `from`. A missing token is an unbound,
  // forgeable pane-id claim and is refused exactly like a mismatched token — compatibility
  // cannot outrank the human-review boundary. The approval binds to a ReviewSnapshot
  // (repo identity + exact source/base commits), not to a bare branch name.
  | { t: 'approve'; snapshot: ReviewSnapshot; from: string; token: string }
  | { t: 'approvals' }
  // App-side hook: a branch's worktree was removed -> its approval dies with it.
  | { t: 'unapprove'; repoId: string; branch: string }

/** daemon -> client. Every pane-scoped EVENT carries the session's `gen` (v5): a pane id
 *  is reused the moment a slot is re-opened, so consumers gate on (id, gen) — an event
 *  stamped with a dead generation must never touch the living session's pane. */
export type ServerMessage =
  // `otherClients` (additive, v9-era): how many OTHER authed connections this daemon holds at
  // the moment of THIS welcome. It is what lets a build-stamp retire distinguish "stale daemon
  // nobody is using — replace it" from "a DIFFERENT build's live session is attached — backing
  // off beats a retire war that kills every pane's process each round" (daemon-client.ts,
  // ensureDaemon). Old daemons omit it; the client then keeps today's retire behaviour.
  | { t: 'welcome'; v: number; panes: PaneInfo[]; workspaces: PersistedWorkspace[]; otherClients?: number }
  | { t: 'error'; reason: string; id?: string }
  // `restored` narrows `existing`: a cold-start restore (fresh shell + repainted
  // scrollback, untouched since) rather than a continuously-live session — the app
  // types resume into the former and must keep its hands off the latter (v5).
  | { t: 'spawned'; id: string; gen: number; existing: boolean; restored: boolean; scrollback: string; pty: PtyEmulation }
  | { t: 'attached'; id: string; gen: number; scrollback: string }
  | { t: 'data'; id: string; gen: number; data: string }
  | { t: 'exit'; id: string; gen: number; code: number }
  | { t: 'state'; id: string; gen: number; state: AgentState }
  | {
      t: 'cwd'
      id: string
      gen: number
      cwd: string
      rev: number
      source: PaneCwdSource
      locality: PaneCwdLocality
    }
  | { t: 'panes'; panes: PaneInfo[] }
  | { t: 'pong' }
  | { t: 'notified'; id: string; ok: boolean } // ack for a `notify` (ok=false: unknown pane id)
  | { t: 'cwd-reported'; id: string; gen: number; cwd: string; rev: number }
  | { t: 'limit'; id: string; gen: number } // a pane's agent reported a usage limit (Phase-4/04 failover)
  // Typed-launch detection: an agent CLI process appeared in (or vanished from) the pane's
  // PTY subtree — the daemon KNOWS this from the process table, not from output heuristics.
  // `agentId` is an adapter id ('claude', …) or null (the agent exited); `cwd` is where the
  // agent itself runs (it names the session log); `sinceMs` floors how far back a context
  // watch may look for that log. Replayed on (re)attach, so an app restart re-learns a
  // hand-typed session it never launched. Ids only, never a command line (ADR 0002/0005).
  | { t: 'agent'; id: string; gen: number; agentId: string | null; cwd?: string; sinceMs?: number }
  | { t: 'sent'; id: string; ok: boolean } // ack for a `send-key` (ok=false: unknown pane/key)
  | { t: 'captured'; id: string; data: string } // reply to `capture` — CALLER's stdout only
  | { t: 'mailed'; id: number } // ack for a mail-send (the assigned message id)
  | { t: 'mail'; messages: MailMessage[] } // reply to mail-read — CALLER only
  | { t: 'role-set'; id: string; ok: boolean } // ack for set-role (ok=false: unknown pane/role)
  | { t: 'claimed'; id: number } // claim granted
  | { t: 'claim-denied'; pattern: string; ownerPaneId: string } // overlap — owner named
  | { t: 'released'; count: number } // ack for release
  | { t: 'owners'; claims: Claim[] } // reply to `owners` + PUSHED to all clients on change
  | { t: 'approved'; branch: string; byPaneId: string; byRole: string } // sign-off ack
  | { t: 'approvals'; list: Approval[] } // reply to `approvals`
  | { t: 'pane-verified'; requestId: number; id: string; valid: boolean }

/** Notify events an agent/hook can raise via `mogging notify` (Phase-2/04). A small, closed
 *  vocabulary that maps to a pane AgentState — a label only, never PTY content (ADR 0002). */
export type NotifyEvent =
  | 'needs-input'
  | 'done'
  | 'attention'
  | 'busy'
  | 'idle'
  // Subagent lifecycle (Claude Code SubagentStart/SubagentStop hooks). A GATE, never a
  // source: alerts are the MAIN agent's story, and these only hold the pane busy and
  // DEFER the main's premature verdicts. They never author a pane state.
  // Handled statefully by the tracker (session.applyNotify routes them; see
  // agent-state/activity.ts) — notifyEventToState is only their stateless fallback.
  | 'subagent-start'
  | 'subagent-stop'
  // Claude Code's "Claude is waiting for your input" notice. Fired on an idle TIMER, not
  // by a block — so it NEVER rings red (that turned a finished pane's green halo red a
  // minute after it finished). It settles the pane instead, and is dropped outright while
  // subagents are pending or a real block is latched.
  | 'idle-prompt'
  // UserPromptSubmit: a new turn. Resets the pending-subagent counter, so a stop event
  // lost to a hard kill can't swallow every future done and strand the pane on busy.
  | 'turn-start'
  // The turn DIED without a verdict: Claude Code's StopFailure (an API error ended the
  // turn — its docs promise the hook command still runs even though its output is
  // ignored) or OpenCode's session.error. Without it the pane is stuck on `busy`
  // forever: no `done` and no `idle` will ever arrive from a turn that is gone. It
  // settles the pane like a shell prompt does — never a green (nothing completed) and
  // never a red (nothing is asking) — and it clears the dead turn's leftovers.
  // Handled statefully by the tracker (session.applyNotify -> turnFailed()).
  | 'turn-failed'
  // A notification whose TYPE the hook script does not recognize. A guess, deliberately
  // distinct from `needs-input`: the daemon routes it to the tracker's notice() — swallowed
  // mid-turn (a busy pane's real blocks arrive as explicit needs-input on the same channel,
  // so an unknown type there is certainly not one; it also retracts its own raw-BEL twin),
  // swallowed on a done pane, and held for contradiction like any chime everywhere else.
  // Unrecognized types used to default to needs-input, and the /goal system's new
  // notification types latched four freshly-FINISHED panes red (2026-07-15) — Claude fires
  // notifications mostly for unfocused panes, so it hit exactly the agents nobody was
  // watching. Deliberately NOT in notifyEventToState below: no stateless AgentState is
  // honest for a guess (idle/busy would clear a real latch, attention would be the bug
  // reborn), so only the tracker may route it.
  | 'notice'
  // The pane's agent reported a provider usage limit (Phase-4/04 failover). Handled
  // statefully by the daemon (session.applyNotify fans a DISTINCT `limit` server event
  // to subscribers so the app can offer profile failover) — it still rings attention
  // via the stateless map's default arm, which is the honest reading of "your quota is
  // spent". This member existed on the wire (mogging notify --event usage-limit, the
  // PROFILES gate drives it) long before the union admitted it.
  | 'usage-limit'

/**
 * Map a notify event to the pane state it raises.
 *
 * `done` LANDS AS `done`, and that is the whole point. It used to land as plain `idle`, which
 * destroyed the one fact that mattered: by the time the UI's attention port derived "finished"
 * from the busy->idle EDGE, it could no longer tell an explicit `Stop` hook from "the terminal
 * went quiet for 1.5 seconds". A 2.5s duration floor was the only thing standing between that
 * inference and nonsense, and its entire safety margin was about one second of repaint. `done`
 * is now a state of its own, so green has exactly one source and it is a verdict.
 *
 * `idle` and `idle-prompt` therefore CANNOT green a pane, which is correct — neither of them
 * claims anything finished. `idle-prompt` in particular is fired on a 60-second timer, not by
 * a completion; reading it as one would green a pane that had merely gone quiet.
 *
 * `done` must also never ring `attention`: red is reserved for "blocked on you" (needs-input),
 * and a done that rang red made finished and blocked indistinguishable. Unknown events still
 * default to `attention` — any explicit notify is worth surfacing, and interrupting you is the
 * safe direction to be wrong in.
 */
export function notifyEventToState(event: string): AgentState {
  switch (event) {
    case 'busy':
    case 'turn-start':
    case 'subagent-start':
    case 'subagent-stop': // stateless fallback only — the tracker owns the real counter
      return 'busy'
    case 'done':
      return 'done'
    case 'idle':
    case 'idle-prompt': // a parked prompt is idle, never blocked AND never finished
    case 'turn-failed': // a dead turn settled nothing — stateless fallback; the tracker owns the reset
      return 'idle'
    default:
      return 'attention'
  }
}

/**
 * Named keys the control API may press (Phase-3/01). A CLOSED allowlist mapped to
 * bytes here — the `mogging send-key` argument is only ever a NAME from this table;
 * arbitrary escape synthesis from a CLI arg is rejected by the daemon.
 */
export const CONTROL_KEYS: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  escape: '\x1b',
  backspace: '\x7f',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  'page-up': '\x1b[5~',
  'page-down': '\x1b[6~',
  'c-c': '\x03',
  'c-d': '\x04',
  'c-z': '\x1a',
  'c-l': '\x0c',
  'c-u': '\x15',
  'c-r': '\x12'
}

/** Bytes for a named key, or null when the name is not in the allowlist. */
export function keyToBytes(key: string): string | null {
  return Object.prototype.hasOwnProperty.call(CONTROL_KEYS, key) ? CONTROL_KEYS[key] : null
}

/** Newline-delimited JSON framing (JSON escapes any embedded newline, so this is safe). */
export function encodeMessage(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg) + '\n'
}

/** Stateful decoder for partial socket chunks. Returns a fn to feed chunks into. */
export function createLineFramer(onMessage: (obj: unknown) => void): (chunk: string) => void {
  let buf = ''
  return (chunk: string): void => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line) continue
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      onMessage(obj)
    }
  }
}
