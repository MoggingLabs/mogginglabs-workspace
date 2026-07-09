// Per-pane agent CONTEXT usage. How full is the conversation window of the agent running
// in this pane? Strictly READ-ONLY, and strictly COUNTS: the backend tails the JSONL session
// log the CLI already writes for itself, at its KNOWN location (ADR 0007 rule 3 — known
// locations only, never a crawl), and reports two integers. No prompt text, no tool output,
// no file content, and no credential ever crosses this wire — only `usedTokens`,
// `windowTokens`, and the model id the CLI logged.
//
// WHY the session log and not the terminal. The obvious source is the CLI's own footer, but
// Claude Code only prints "Context left until auto-compact" once context runs LOW, so a
// scraped bar would sit blank for most of a session and then appear, already half full. The
// session log is written on every single turn — so the bar is always current, by construction.

import type { PaneId } from '../domain/pane'

/** Agent CLIs whose LOCAL SESSION LOG is a dev-verified context source (see
 *  @backend/features/context) — what this wire CAN serve. What the pane SHOWS is a
 *  separate, narrower decision the context feature makes: codex and gemini paint
 *  their own "% context left" gauge in the terminal (dev-verified strings in both),
 *  so rendering ours beside theirs would state the number twice — only claude,
 *  whose CLI shows nothing until context runs LOW, gets the header bar. Anything
 *  else (custom commands) reports no usage at all. We never estimate a number we
 *  cannot read. */
export const CONTEXT_PROVIDERS = ['claude', 'codex'] as const
export type ContextProvider = (typeof CONTEXT_PROVIDERS)[number]

export const isContextProvider = (id: string): id is ContextProvider =>
  (CONTEXT_PROVIDERS as readonly string[]).includes(id)

/** One reading of a pane's agent-session context window. */
export interface ContextUsage {
  provider: ContextProvider
  /** Tokens currently IN the model's context. For claude this is the CLI's own
   *  display sum (input + cache_read + cache_creation of the last main-chain turn,
   *  output excluded), so the bar always matches what `/context` reports. */
  usedTokens: number
  /** The model's context window. Claude: the session's own window as pushed by the
   *  statusline relay (`context_window_size`), falling back to the model's DOCUMENTED
   *  window (sourced table in @backend/features/context/window.ts); codex: stated on
   *  every token_count line. Never guessed — no source, no reading. */
  windowTokens: number
  /** `usedTokens / windowTokens`, clamped to 0–100 and rounded — the CLI's own
   *  rounding (h1n), so the percent agrees with `/context` digit-for-digit. */
  usedPct: number
  /** The model id the CLI logged (e.g. "claude-opus-4-8"). A label — never a credential. */
  model?: string
  /** An APPROXIMATION, stated as one: before a session's first response its log has
   *  no usage line, so the baseline is seeded from a previous session's opening turn
   *  in the same project (same system prompt/tools assembly — what `/context` shows
   *  pre-chat). The first real reading replaces it and this flag disappears. */
  approx?: boolean
  /** When this reading was taken (ms epoch). */
  at: number
}

/** UI -> backend: track this pane's agent session; `context:change` events follow.
 *  `provider` is the launched CLI's id and `cwd` is where it launched (the session log
 *  is located from those two). `profileId` names the launch profile so a relocated
 *  config home (CLAUDE_CONFIG_DIR et al.) is honored — the ID only; env values stay
 *  main-side (ADR 0002). `adopted` marks a pane reattached to the detached daemon:
 *  its session began BEFORE this watch, so the log matcher may look back in time. */
export interface ContextWatchRequest {
  paneId: PaneId
  provider: string
  cwd: string
  profileId?: string
  adopted?: boolean
}

/** UI -> backend: stop tracking a pane (it was disposed, or its agent exited). */
export interface ContextUnwatchRequest {
  paneId: PaneId
}

/** backend -> UI: a pane's context usage changed. `null` = nothing to show (no agent,
 *  unsupported provider, or no readable session log yet) — the pane hides its bar. */
export interface ContextUsageEvent {
  paneId: PaneId
  usage: ContextUsage | null
}
