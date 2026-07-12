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

/** Windows LEARNED from the CLI itself. Claude Code's statusline states the window THIS
 *  session runs with (`context_window_size`), and the relay pushes it to us — but only for a
 *  pane the app launched, because only those carry `--settings`. A HAND-TYPED claude has no
 *  relay, and its transcript logs a model id that cannot settle the question: an Opus 4.8
 *  session logs `claude-opus-4-8` whether it is running the 200K window or the 1M one
 *  (dev-verified on this machine: the transcript says `claude-opus-4-8`, the statusline says
 *  `claude-opus-4-8[1m]` / 1,000,000). A table cannot know which.
 *
 *  So the app REMEMBERS: every relay reading teaches (model -> window) from the horse's mouth,
 *  and a transcript-only pane running that same model then uses the true window instead of the
 *  documented one. The table below stays as the answer for a model nothing has taught us yet. */
const LEARNED_WINDOWS = new Map<string, number>()

/** Teach the table from a statusline reading — the CLI's own `context_window_size`. Model ids
 *  differ between the two sources (`claude-opus-4-8[1m]` vs `claude-opus-4-8`), so BOTH the id
 *  as reported and its bare form are recorded: the transcript only ever states the bare one. */
export function learnClaudeWindow(modelId: string | undefined, windowTokens: number | undefined): void {
  if (!modelId || !windowTokens || !Number.isFinite(windowTokens) || windowTokens <= 0) return
  LEARNED_WINDOWS.set(modelId, windowTokens)
  const bare = modelId.replace(/\[[^\]]*\]$/, '') // strip a variant marker: `…-4-8[1m]` -> `…-4-8`
  if (bare !== modelId) LEARNED_WINDOWS.set(bare, windowTokens)
}

/** The window for a logged model id: what the CLI itself said, when it has ever said it; the
 *  documented window otherwise; null when neither knows. Null means "state no percentage" —
 *  never "guess one". */
export function claudeWindowForModel(modelId: string | undefined): number | null {
  if (!modelId) return null
  const learned = LEARNED_WINDOWS.get(modelId)
  if (learned) return learned
  for (const [prefix, tokens] of MODEL_WINDOWS) {
    if (modelId.startsWith(prefix)) return tokens
  }
  return null
}

// ── Codex ──────────────────────────────────────────────────────────────────────
// Codex does NOT show `used / window`. It reserves a fixed baseline — "prompts, tools and
// space to call compact" — and subtracts it from BOTH sides of the ratio, which is why a
// fresh session reads 100% left rather than 95%. Reproducing that is the whole point: a naive
// used/window disagrees with the footer in the same pane by ~4 points, and the gauge would be
// quietly, permanently wrong.
//
// Source (openai/codex, byte-identical copies in codex-rs/protocol/src/protocol.rs and
// codex-rs/tui/src/token_usage.rs):
//
//     const BASELINE_TOKENS: i64 = 12000;
//     pub fn percent_of_context_window_remaining(&self, context_window: i64) -> i64 {
//         if context_window <= BASELINE_TOKENS { return 0; }
//         let effective_window = context_window - BASELINE_TOKENS;
//         let used = (self.tokens_in_context_window() - BASELINE_TOKENS).max(0);
//         let remaining = (effective_window - used).max(0);
//         ((remaining as f64 / effective_window as f64) * 100.0).clamp(0.0, 100.0).round() as i64
//     }
//
// The window is read VERBATIM from the rollout: codex already scaled it by its
// `effective_context_window_percent` (95% by default — a 272K model logs 258,400) before
// writing it, so re-scaling would double-count.
const CODEX_BASELINE_TOKENS = 12_000

/** Percent of the context window USED, as codex would render it (its footer says "N% context
 *  left"; this is 100 - N, so the two can never disagree by a rounding step). Null when the
 *  rollout stated no window — codex itself then shows a token count instead of a percentage. */
export function codexPercentUsed(usedTokens: number, windowTokens: number | undefined): number | null {
  if (!windowTokens || windowTokens <= CODEX_BASELINE_TOKENS) return null
  const effective = windowTokens - CODEX_BASELINE_TOKENS
  const used = Math.max(usedTokens - CODEX_BASELINE_TOKENS, 0)
  const remaining = Math.max(effective - used, 0)
  const percentLeft = Math.min(100, Math.max(0, Math.round((remaining / effective) * 100)))
  return 100 - percentLeft
}

// ── Gemini ─────────────────────────────────────────────────────────────────────
// Gemini's footer IS `promptTokenCount / tokenLimit(model)`, rendered with .toFixed(0) — plain
// round-half-up, no reserve. Its limit table (packages/core/src/core/tokenLimits.ts, 0.50.0) is
// effectively flat: everything is 1,048,576 except the Gemma-4 models, which are 256,000.
const GEMINI_DEFAULT_LIMIT = 1_048_576
const GEMMA_4_LIMIT = 256_000

/** The token limit gemini divides by. Never null: the CLI's own table has a default branch, so
 *  an unknown model id gets the default there too — matching it is the point. */
export function geminiWindowForModel(modelId: string | undefined): number {
  return modelId?.toLowerCase().startsWith('gemma-4') ? GEMMA_4_LIMIT : GEMINI_DEFAULT_LIMIT
}
