import { isAgentCliId, type AgentCliId } from './agent-cli'

/**
 * A pane's launch INTENT — the composer's input, persisted, so a restore can re-compose
 * rather than re-parse.
 *
 * THE BUG THIS EXISTS FOR: a pane's launch state was persisted as the composer's OUTPUT —
 * one opaque shell line like `cd /d "…" && set "CLAUDE_CONFIG_DIR=…" && claude --settings …`
 * — and restore tried to recover the agent from it by matching `command.split(/\s+/)[0]`
 * against a two-entry table. The first token of every command the app builds is `cd`
 * (features/agents/launch.ts cdPrefix), so the match failed for EVERY pane ever launched,
 * and each one cold-restored as a bare shell. Measured on a real store: 0 of 34 panes
 * resumed; 13 carried a profile pointer that nothing could read back.
 *
 * An output must be re-parsed. An input can simply be re-composed. That is the whole idea.
 *
 * The shape deliberately mirrors the rich composer's input set (`AgentCommandRequest`), so
 * a restore is not a second code path — it is the same composer called with `resume: true`.
 * There is nothing to keep in sync because there is only one function.
 *
 * WHAT IS NOT HERE, ON PURPOSE: the composed command string, `--settings`/`--mcp-config`
 * paths, bell/title args, and the full env map. Those are DERIVED artifacts with their own
 * invalidation rules — the generated settings overlay is content-addressed by digest and
 * bakes in the daemon protocol version, so persisting its path is how you resurrect a
 * dead-channel statusline days later. Persist inputs; regenerate outputs.
 *
 * `configDir` is the exception because it is IDENTITY, not derivation: it is the resolved
 * provider home (HOME_POINTER[agentId] — CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME),
 * and it is the evidence that survives a profile being renamed, moved, or deleted between
 * sessions. A pointer path only, never a credential (ADR 0002); profile env is already
 * deny-listed at the save boundary.
 */
export const LAUNCH_INTENT_VERSION = 1

/** How we learned a pane's launch identity. Governs precedence: a `declared` intent carries
 *  the profile and session id that `detected` can never know, so it is never overwritten by
 *  a detection of the SAME agent. `legacy` marks an intent derived from a pre-migration
 *  command string, which the composer re-homes onto a real profile before use. */
export type PaneLaunchSource = 'declared' | 'detected' | 'legacy'

export interface PaneLaunchIntent {
  /** LAUNCH_INTENT_VERSION at write time. */
  v: number
  agentId: AgentCliId
  cwd: string
  profileId?: string
  /** The RESOLVED provider config home at launch (see the note above). */
  configDir?: string
  /** The exact session to continue, when the app knew it. */
  sessionId?: string
  source: PaneLaunchSource
  at: number
}

const SOURCES: readonly PaneLaunchSource[] = ['declared', 'detected', 'legacy']

/** Profile ids are app-minted slugs; same shape the remote contract pins for its ids. */
const PROFILE_ID_SHAPE = /^[\w.-]{1,64}$/

/** The only session-id shape a typed command line ever carries (UUID — claude and codex
 *  both use it). Kept in step with features/agents/launch.ts RESUME_SESSION_ID: an id that
 *  cannot be typed is an id not worth persisting. */
const SESSION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Paths arrive from a sqlite row, a socket payload, or a legacy parse. Cap them and refuse
 *  control characters: these are TYPED into an interactive shell downstream. */
const PATH_MAX = 4096
const isPlainPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= PATH_MAX && !/[\x00-\x1f\x7f]/.test(value)

/**
 * Validate untrusted rows, socket payloads, and legacy-derived intents at one shared
 * boundary — the twin of `normalizeRemoteConnection`, and for the same reason: the
 * fail-closed guard is built on this returning null.
 *
 * A row that names an agent but whose intent does not normalize must degrade VISIBLY, never
 * fall through to a plain shell. That is why the store carries `agent_id` as its own column
 * beside this blob: with the agent id folded in here, an unreadable intent would be
 * indistinguishable from "this pane was always just a shell", and there would be nothing to
 * fail closed ON.
 */
export function normalizeLaunchIntent(raw: unknown): PaneLaunchIntent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>

  // An intent written by a NEWER build is refused rather than guessed at: a downgrade shows
  // a degraded pane that says so, which is the honest outcome. Older versions get an upgrade
  // step here when a v2 exists — refusing them silently would be the same bug one layer up.
  if (r.v !== LAUNCH_INTENT_VERSION) return null
  if (!isAgentCliId(r.agentId)) return null
  if (!isPlainPath(r.cwd)) return null
  if (typeof r.source !== 'string' || !SOURCES.includes(r.source as PaneLaunchSource)) return null
  if (typeof r.at !== 'number' || !Number.isFinite(r.at) || r.at < 0) return null

  const out: PaneLaunchIntent = {
    v: LAUNCH_INTENT_VERSION,
    agentId: r.agentId,
    cwd: r.cwd,
    source: r.source as PaneLaunchSource,
    at: Math.floor(r.at)
  }
  if (r.profileId !== undefined) {
    if (typeof r.profileId !== 'string' || !PROFILE_ID_SHAPE.test(r.profileId)) return null
    out.profileId = r.profileId
  }
  if (r.configDir !== undefined) {
    if (!isPlainPath(r.configDir)) return null
    out.configDir = r.configDir
  }
  if (r.sessionId !== undefined) {
    if (typeof r.sessionId !== 'string' || !SESSION_ID_SHAPE.test(r.sessionId)) return null
    out.sessionId = r.sessionId.toLowerCase()
  }
  return out
}

/**
 * Precedence when a pane's detected agent meets its recorded intent. PURE and separate from
 * the detector on purpose — the rules below are policy, and policy that lives inside an
 * event handler cannot be unit-tested.
 */
export function launchIntentPrecedence(
  current: PaneLaunchIntent | undefined,
  detected: { agentId: string; cwd: string } | null,
  now: number
): PaneLaunchIntent | undefined {
  // INTENT IS NOT PRESENCE. Detection goes null the moment the agent exits, but the pane is
  // still a claude pane whose session should come back. Clearing intent here would re-create
  // the original bug for every agent that ever exits cleanly.
  if (!detected) return current
  if (!isAgentCliId(detected.agentId)) return current
  // `declared` is strictly richer than `detected` — it carries the profile and session id a
  // process listing cannot see. Same rule the renderer already applies for the same reason.
  if (current && current.agentId === detected.agentId && current.source === 'declared') return current
  if (current && current.agentId === detected.agentId && current.source === 'detected') return current
  if (!isPlainPath(detected.cwd)) return current
  // A different agent means the user quit one and started another: replace.
  return {
    v: LAUNCH_INTENT_VERSION,
    agentId: detected.agentId,
    cwd: detected.cwd,
    source: 'detected',
    at: now
  }
}
