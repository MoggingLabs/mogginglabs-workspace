// Protocol between the Electron app (client) and the detached PTY daemon (server).
// This is a versioned CONTRACT: the socket/pipe name embeds the version, so an app
// update never speaks an incompatible protocol to an old daemon (ADR 0006 — the
// tmux "kill-server on upgrade" pitfall). Depends on nothing (pure types + helpers).

import type { AgentState } from '../domain/agent'
import type { PersistedWorkspace } from '../ipc/workspace.ipc'

// v3: Phase-4/01 swarm substrate — mailbox (mail-send/mail-read), per-pane roles
// (set-role, PaneInfo.role). v2: Phase-3/01 control API — send-key/capture + enriched
// PaneInfo. The version namespaces the runtime dir + socket, so older daemons keep
// running untouched (ADR 0006 anti-kill-server); the app + CLI speak their own v3.
export const DAEMON_PROTOCOL_VERSION = 3

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
/** A reviewer sign-off for a branch. Memory-only coordination data — never
 *  persisted, never telemetered. The ROLE is resolved daemon-side from the pane
 *  binding; a client cannot claim reviewer-ness in a payload. */
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
}

export interface PaneInfo {
  id: string
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
  // Reviewer gate (Phase-4/03). `from` is the approver's pane binding; the daemon
  // checks THAT pane's role — payload role claims don't exist, by design.
  | { t: 'approve'; branch: string; from: string }
  | { t: 'approvals' }
  // App-side hook: a branch's worktree was removed -> its approval dies with it.
  | { t: 'unapprove'; branch: string }

/** daemon -> client */
export type ServerMessage =
  | { t: 'welcome'; v: number; panes: PaneInfo[]; workspaces: PersistedWorkspace[] }
  | { t: 'error'; reason: string }
  | { t: 'spawned'; id: string; existing: boolean; scrollback: string }
  | { t: 'attached'; id: string; scrollback: string }
  | { t: 'data'; id: string; data: string }
  | { t: 'exit'; id: string; code: number }
  | { t: 'state'; id: string; state: AgentState }
  | { t: 'cwd'; id: string; cwd: string }
  | { t: 'panes'; panes: PaneInfo[] }
  | { t: 'pong' }
  | { t: 'notified'; id: string; ok: boolean } // ack for a `notify` (ok=false: unknown pane id)
  | { t: 'limit'; id: string } // a pane's agent reported a usage limit (Phase-4/04 failover)
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
export type NotifyEvent = 'needs-input' | 'done' | 'attention' | 'busy' | 'idle'

/** Map a notify event to the pane state it raises. Unknown events default to `attention` (any
 *  explicit notify is worth surfacing) — only `busy`/`idle` are the softer, non-ringing states. */
export function notifyEventToState(event: string): AgentState {
  switch (event) {
    case 'busy':
      return 'busy'
    case 'idle':
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
