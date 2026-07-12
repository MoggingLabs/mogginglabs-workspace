// Protocol between the Electron app (client) and the detached PTY daemon (server).
// This is a versioned CONTRACT: the socket/pipe name embeds the version, so an app
// update never speaks an incompatible protocol to an old daemon (ADR 0006 — the
// tmux "kill-server on upgrade" pitfall). Depends on nothing (pure types + helpers).

import type { AgentState } from '../domain/agent'
import type { PersistedWorkspace } from '../ipc/workspace.ipc'
import type { PtyEmulation } from '../ipc/terminal.ipc'

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
export const DAEMON_PROTOCOL_VERSION = 5

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
 *  approve message's `token` (that pane's env-only MOGGING_PANE_TOKEN) when the sender
 *  has one — the pane id alone is public (`mogging list` prints it) and was, on its own,
 *  forgeable by any pane that shares the user's daemon. */
export interface Approval {
  branch: string
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
    const literalX = !x.includes('*')
    const literalY = !y.includes('*')
    if (literalX && literalY && x !== y) return false // proven divergence
    if (!literalX || !literalY) {
      // a wildcard segment may or may not match — conservative: keep walking as if
      // it matched; a later literal divergence can still separate the branches only
      // when neither side has wildcards there, so effectively this often denies.
      continue
    }
  }
}

/** Discovery record the daemon writes and the client reads (mode 0600). */
export interface DaemonEndpoint {
  version: number
  address: string // named pipe path (Windows) or unix socket path (macOS/Linux)
  token: string // random per-daemon auth token; the client must present it in `hello`
  pid: number
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
  /** Remote pane (Phase-4/05): the RESOLVED host row (the daemon stays db-free).
   *  Connection pointers only — the user's ssh stack does all auth (ADR 0002). */
  remote?: { name: string; host: string; user?: string; port?: number }
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
  /** Live agent state (idle / busy / attention). */
  state?: AgentState
  /** Swarm role, when the pane has one (Phase-4/01). */
  role?: SwarmRole
  /** Remote pane's host display name (Phase-4/05). */
  remoteName?: string
}

/** client -> daemon */
export type ClientMessage =
  | { t: 'hello'; v: number; token: string }
  | { t: 'spawn'; id: string; spec?: SpawnSpec }
  | { t: 'attach'; id: string }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'kill'; id: string }
  | { t: 'list' }
  | { t: 'ping' }
  | { t: 'shutdown' }
  // `mogging notify` (Phase-2/04): an agent/hook inside a pane raises that pane's attention.
  // Carries an event label (+ optional short message) ONLY — never PTY content or credentials.
  | { t: 'notify'; id?: string; event: string; message?: string }
  // Control API (Phase-3/01): named-key press — `key` is a NAME from CONTROL_KEYS;
  // the daemon maps it to bytes (allowlist — clients never synthesize escapes).
  | { t: 'send-key'; id: string; key: string }
  // Control API (Phase-3/01): return the retained scrollback tail (≤ 10000 lines).
  | { t: 'capture'; id: string; lastLines?: number }
  // Swarm mailbox (Phase-4/01). `from` is the sender's own pane binding (env
  // MOGGING_PANE_ID inside a pane; omitted = external/human -> '0'). The mailbox
  // never pushes into a PTY — readers PULL with mail-read.
  | { t: 'mail-send'; body: string; to?: string; from?: string }
  // Messages for `for` (its own id, or omitted = the human view: everything),
  // with id > since.
  | { t: 'mail-read'; since?: number; for?: string }
  // Swarm manifest: name a pane's role (validated against SWARM_ROLES).
  | { t: 'set-role'; id: string; role: string }
  // Ownership ledger (Phase-4/02). `from` = the claimant pane's own binding
  // (MOGGING_PANE_ID). The ledger ADVISES — it never blocks PTY writes or file I/O.
  | { t: 'claim'; pattern: string; from: string }
  | { t: 'release'; pattern?: string; all?: boolean; from: string }
  | { t: 'owners' }
  // Reviewer gate (Phase-4/03). `from` names the approver's pane and the daemon checks
  // THAT pane's role — a payload can never claim a role. `token` is the pane's own
  // MOGGING_PANE_TOKEN (minted per session, injected into that pane's env and nowhere
  // else): it PROVES the sender is running inside `from`. Optional on the wire only so a
  // pane the daemon restored cold — env re-created, no token in hand — and any older CLI
  // keep working; when it IS present the daemon enforces it, so the shipped CLI (which
  // always sends it from a real pane) cannot be impersonated by a pane that sends its own.
  | { t: 'approve'; branch: string; from: string; token?: string }
  | { t: 'approvals' }
  // App-side hook: a branch's worktree was removed -> its approval dies with it.
  | { t: 'unapprove'; branch: string }

/** daemon -> client. Every pane-scoped EVENT carries the session's `gen` (v5): a pane id
 *  is reused the moment a slot is re-opened, so consumers gate on (id, gen) — an event
 *  stamped with a dead generation must never touch the living session's pane. */
export type ServerMessage =
  | { t: 'welcome'; v: number; panes: PaneInfo[]; workspaces: PersistedWorkspace[] }
  | { t: 'error'; reason: string }
  // `restored` narrows `existing`: a cold-start restore (fresh shell + repainted
  // scrollback, untouched since) rather than a continuously-live session — the app
  // types resume into the former and must keep its hands off the latter (v5).
  | { t: 'spawned'; id: string; gen: number; existing: boolean; restored: boolean; scrollback: string; pty: PtyEmulation }
  | { t: 'attached'; id: string; gen: number; scrollback: string }
  | { t: 'data'; id: string; gen: number; data: string }
  | { t: 'exit'; id: string; gen: number; code: number }
  | { t: 'state'; id: string; gen: number; state: AgentState }
  | { t: 'cwd'; id: string; gen: number; cwd: string }
  | { t: 'panes'; panes: PaneInfo[] }
  | { t: 'pong' }
  | { t: 'notified'; id: string; ok: boolean } // ack for a `notify` (ok=false: unknown pane id)
  | { t: 'limit'; id: string; gen: number } // a pane's agent reported a usage limit (Phase-4/04 failover)
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
  // swallow the main's premature verdicts (a `done` fired while it's merely parked on
  // its subagents, a quiet terminal, an idle prompt). They never author a pane state.
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

/** Map a notify event to the pane state it raises. `done` is a turn ENDING — it lands as
 *  `idle`, which the UI's attention port turns into the sticky green "finished" story
 *  (halo until the pane is clicked). It must NOT ring `attention`: red is reserved for
 *  "blocked on you" (needs-input), and a done that rang red made finished and blocked
 *  indistinguishable — and left the green finished layer unreachable. Unknown events
 *  still default to `attention` (any explicit notify is worth surfacing). */
export function notifyEventToState(event: string): AgentState {
  switch (event) {
    case 'busy':
    case 'turn-start':
    case 'subagent-start':
    case 'subagent-stop': // stateless fallback only — the tracker owns the real counter
      return 'busy'
    case 'idle':
    case 'done':
    case 'idle-prompt': // a parked prompt is idle, never blocked (the tracker gates it)
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
