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

/** Agent CLIs whose LOCAL SESSION LOG is a source-verified context reading. EVERY one of them
 *  gets the gauge — including the two that already draw their own in the terminal. That used to
 *  be the argument against it ("the number would be stated twice"), and it was the wrong call:
 *  a pane's own footer is legible only in the pane you are LOOKING at, while the header gauge is
 *  what makes a wall of agents readable at a glance. Stating the same number twice costs
 *  nothing. Stating a DIFFERENT number twice would cost everything — so each provider's percent
 *  is computed with THAT CLI's formula, never with one of ours:
 *
 *    claude  used / window, over the window its statusline reports (h1n — what `/context` prints)
 *    codex   its own reserved-baseline formula (window.ts) — a plain used/window reads ~4 points
 *            low against the "% context left" printed in the very same pane
 *    gemini  promptTokenCount / tokenLimit(model) — what its own "N% used" footer divides
 *    opencode  the five token fields of the last assistant message, over the model's raw
 *            limit.context — what its sidebar sums (its COMPACTION formula differs; the user
 *            is not shown that one, so neither are we)
 *    aider   the only one that shows NO percentage anywhere: it prints 1k-ROUNDED token
 *            counts and computes a real figure only inside `/tokens`. So we read what
 *            `/tokens` reads — the exact prompt size aider logs for every call, over
 *            litellm's max_input_tokens — rather than round-tripping its own rounding
 *
 *  Anything else (a custom command) reports no usage at all. We never estimate a number we
 *  cannot read: no source, no digit. */
export const CONTEXT_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode', 'aider'] as const
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
  /** The percentage THAT CLI would display for this reading — computed with its formula, not
   *  ours (see CONTEXT_PROVIDERS above). Usually 0–100, but not by decree: gemini's ratio is
   *  unclamped and its footer says "101% used" once a prompt outgrows the window, so this may
   *  exceed 100 and the pane says so too. The disc simply stops at full. */
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
  /** The earliest this session's log can have been written (ms epoch). Typed-launch detection
   *  knows this exactly — when the agent's process was first seen, minus the detection lag —
   *  so the log matcher gets a true floor instead of the guess it makes for a launch (a few
   *  seconds' slack) or an adopted pane (a blind 30-minute window). Absent = use the guess. */
  since?: number
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
