/**
 * The workspace brain over IPC (ADR 0018) — the LAWS, before any graph exists.
 * One deterministic index per PROJECT (the board-v2 identity rule: worktrees
 * share it, folders get their own), derived state under the app data dir,
 * answers stamped with freshness, refusals typed. This file is step 02's whole
 * outward shape: 03 adds the graph, 04 the freshness law, 05+ the readers —
 * every one of them answers in these types and adds no new verbs lightly.
 */

// Caps, as consts so every consumer refuses at the SAME line (ADR 0018.a: an
// index, not an oracle — a project that cannot be indexed deterministically and
// affordably is refused `too-large`, never half-indexed in silence).
export const BRAIN_MAX_FILES = 50_000
export const BRAIN_MAX_FILE_BYTES = 1_048_576

/** WHY the brain has no answer — a closed enum, never free text (nothing here can
 *  carry a path or a symbol into telemetry, ADR 0005; `detail` is for the UI/smoke
 *  and stays local):
 *  `missing`   the root does not exist;
 *  `invalid`   junk shape, a relative path, or a non-directory;
 *  `too-large` the project exceeds BRAIN_MAX_FILES (03 enforces it at walk time);
 *  `busy`      the store cannot be opened right now (locked/corrupt db). */
export type BrainRefusalReason = 'missing' | 'invalid' | 'too-large' | 'busy'

export interface BrainRefusal {
  ok: false
  reason: BrainRefusalReason
  /** Local color for the refusal row / smoke diagnostics — never telemetry. */
  detail?: string
}

/** The whole outward shape of "what does the brain know about this project". */
export interface BrainStatus {
  ok: true
  /** Canonical PROJECT identity — the board-v2 rule, the same resolver (ADR 0018.c). */
  projectKey: string
  /** Every root the ONE brain answers for: the main checkout + its linked worktrees. */
  roots: string[]
  /** Monotonic index generation; moves on every accepted rebuild. Freshness is a law
   *  (ADR 0018.d): every answer stamps it, so staleness is visible, never silent. */
  generation: number
  /** TRUE when the index is known stale. 04 owns raising it; nothing may hide it. */
  dirty: boolean
  /** Zeroed until 03's graph lands — a real answer from a real (empty) index. */
  files: number
  nodes: number
  edges: number
  languages: string[]
  /** TRUE while the worker is rebuilding — answers stay served (from the old bytes). */
  indexing: boolean
}

export type BrainAnswer = BrainStatus | BrainRefusal

/** `brain:status` / `brain:rebuild` request: the root the caller stands in. */
export interface BrainRootRequest {
  root: string
}

/** `brain:changed` push: enough to re-ask, never the answer itself. */
export interface BrainChangedEvent {
  projectKey: string
  generation: number
  dirty: boolean
}
