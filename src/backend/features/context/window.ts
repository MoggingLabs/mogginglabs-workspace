// Claude context-window resolution. Claude Code's session log records what each turn
// USED but never the model's window, so the window comes from two places, in order:
//
//   1. THE STATUSLINE RELAY (authoritative, per session): Claude Code itself reports
//      `context_window.context_window_size` on every statusline update — whatever
//      window THIS session actually runs with. The monitor prefers it whenever the
//      relay is active (see monitor.ts). No table can beat the horse's mouth.
//   2. THE MODEL'S DOCUMENTED WINDOW (fallback, transcript-only panes): the table
//      below, keyed on the `message.model` id the CLI logged. SOURCE: Anthropic's
//      model catalog (platform.claude.com/docs/en/about-claude/models/overview —
//      snapshot dated 2026-06-24 via the claude-api reference skill; the live query
//      is the Models API's `max_input_tokens`). Per that catalog: Fable 5, Mythos 5,
//      Opus 4.8/4.7/4.6, Sonnet 5 and Sonnet 4.6 are ALL 1M-context models — Opus
//      4.8 explicitly "1M context window at standard API pricing" — and Haiku 4.5
//      is 200K. Older 4.x/3.x models were 200K.
//
// A model id the table doesn't know yields NO window — the pane then shows the
// pending "–" until the relay states the real one. We never invent a number: an
// unsourced denominator produces a percentage that contradicts /context, which is
// exactly the failure this file exists to prevent.

/** Documented context windows (tokens) by model-id PREFIX, most specific first —
 *  date-suffixed ids (e.g. claude-haiku-4-5-20251001) match their alias row. */
const MODEL_WINDOWS: Array<[prefix: string, tokens: number]> = [
  ['claude-fable-5', 1_000_000],
  ['claude-mythos-5', 1_000_000],
  ['claude-opus-4-8', 1_000_000],
  ['claude-opus-4-7', 1_000_000],
  ['claude-opus-4-6', 1_000_000],
  ['claude-sonnet-5', 1_000_000],
  ['claude-sonnet-4-6', 1_000_000],
  ['claude-haiku-4-5', 200_000],
  // Legacy tiers (all 200K standard, per the same catalog's legacy tables).
  ['claude-opus-4-5', 200_000],
  ['claude-opus-4-1', 200_000],
  ['claude-opus-4-2', 200_000],
  ['claude-opus-4-0', 200_000],
  ['claude-opus-4-', 200_000],
  ['claude-sonnet-4-5', 200_000],
  ['claude-sonnet-4-0', 200_000],
  ['claude-sonnet-4-', 200_000],
  ['claude-3-', 200_000]
]

/** The documented window for a logged model id, or null when the id is unknown —
 *  null means "state no percentage", never "guess one". */
export function claudeWindowForModel(modelId: string | undefined): number | null {
  if (!modelId) return null
  for (const [prefix, tokens] of MODEL_WINDOWS) {
    if (modelId.startsWith(prefix)) return tokens
  }
  return null
}
