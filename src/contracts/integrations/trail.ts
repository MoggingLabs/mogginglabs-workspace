// The agent activity trail (Phase-8/01 shape; 8/05 gives it a store — the
// audit trail FINDINGS §4.5 calls non-negotiable). ONE entry shape for all
// three sources. Entries are REFS, never content: no page text, no tool args,
// no eval bodies, no payloads, no webhook URLs. The trail is LOCAL — it exists
// so the user can audit "what did agents do as me", and it never leaves the
// machine (ADR 0005).

/** Where the act came from: an agent web act (04), an MCP write (03), or a
 *  bridge delivery (10). */
export type TrailSource = 'web' | 'mcp' | 'bridge'

/** `ok` = performed · `refused` = blocked (ungated origin, blocklist, revoked
 *  grant — `reason` says why) · `confirmed` = performed after the human's
 *  session-scoped confirm. */
export type TrailOutcome = 'ok' | 'refused' | 'confirmed'

export interface TrailEntry {
  /** Epoch ms. */
  ts: number
  source: TrailSource
  workspaceId: string
  /** The acting pane's id, when the act came from a pane-bound session. */
  pane?: string
  /** The verb performed (a tool/act name — e.g. "browser_click", "send_to_pane"). */
  verb: string
  /** A REF, structurally: an ORIGIN (web) · a pane/card ref (mcp) · a webhook
   *  LABEL (bridge — never the URL, it may embed a secret). */
  target: string
  outcome: TrailOutcome
  /** Human wording for refused/confirmed, rendered verbatim. */
  reason?: string
}

// Ring caps for the per-workspace JSONL store (05): append-only, oldest-half
// rewrite on overflow. Defaults live in the contracts, not consumers.
export const TRAIL_MAX_ENTRIES = 2000
export const TRAIL_MAX_BYTES = 1_048_576
