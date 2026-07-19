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
/** One symbol write's payload cap (ADR 0018 step 07). A body/text past this is a
 *  `too-large` refusal — a symbol edit is a scalpel, never a file dump. */
export const BRAIN_WRITE_MAX_BODY_BYTES = 65_536

// ── Libraries (ADR 0018 step 08): version truth + docs custody ───────────────
/** Stored README cap per (name, version) doc row — disk or registry alike. */
export const BRAIN_LIBDOC_README_CAP = 65_536
/** Distilled type-signature lines kept per doc row. */
export const BRAIN_LIBDOC_SIG_CAP = 200
/** Direct deps the disk scan doc-indexes per resolve (transitives never are). */
export const BRAIN_LIBDOC_SCAN_CAP = 150
/** The ONE network verb's response byte ceiling — reads past it are cut and the
 *  stored README is truncated at BRAIN_LIBDOC_README_CAP, flagged, never silent. */
export const BRAIN_LIBFETCH_BYTE_CAP = 1_048_576

/** The ecosystems the resolver speaks. Closed — a new one is a code change. */
export const BRAIN_LIB_ECOSYSTEMS = ['npm', 'py', 'go', 'cargo'] as const
export type BrainLibEcosystem = (typeof BRAIN_LIB_ECOSYSTEMS)[number]

/** One resolved dependency row: the LOCKFILE truth (or the manifest's honest
 *  range when nothing pins), plus what is actually ON DISK. `version` is a
 *  range string exactly when `pinned` is false — ranges are reported AS ranges,
 *  never resolved by guesswork. `installed` means the PINNED version sits on
 *  disk; `installedVersion` is what the disk actually holds ('' = absent). */
export interface BrainLibDep {
  ecosystem: BrainLibEcosystem
  name: string
  version: string
  pinned: boolean
  direct: boolean
  installed: boolean
  installedVersion: string
}

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
  /** Real counts across every partition of the project's db (zero until built). */
  files: number
  nodes: number
  edges: number
  languages: string[]
  /** TRUE while the worker is rebuilding — answers stay served (from the old bytes). */
  indexing: boolean
  /** The LAST build's reference fidelity (ADR 0018.d: reported, never faked):
   *  a resolved reference became an edge; an ambiguous one was DROPPED and counted. */
  resolvedRefs: number
  droppedRefs: number
  /** The LAST build's parse-cache economics — a second worktree of identical bytes
   *  should read as all hits, and the BRAINGRAPH gate asserts exactly that. */
  cacheHits: number
  cacheMisses: number
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

/**
 * `brain:read` — the Brain VIEW's door onto the serve layer's read verbs (the
 * same dispatch the agent wire runs: same caps, same envelopes, same typed
 * refusals). Reads are free (ADR 0008) and the human's own window is a reader
 * like any other; writes have no channel here at all.
 */
export interface BrainReadRequest {
  root: string
  /** A `brain.*` READ verb (serve.ts's closed dispatch — junk answers `invalid`). */
  verb: string
  args?: Record<string, unknown>
}

/** One ecosystem's presence in the caller's lockfile truth (brain:overview). */
export interface BrainEcosystemCount {
  ecosystem: BrainLibEcosystem
  deps: number
}

/**
 * `brain:overview` — the status card's extras: numbers the store already holds
 * that BrainStatus does not carry. Same request shape as `brain:status`, same
 * refusal register.
 */
export interface BrainOverview {
  ok: true
  /** Distinct written memory slugs across the project's roots (freshest-copy law). */
  memories: number
  /** Distinct `[[wikilink]]` targets no memory is written for — wanted knowledge. */
  danglingLinks: number
  /** Lockfile-truth dependency counts for the caller's partition, per ecosystem. */
  ecosystems: BrainEcosystemCount[]
}

export type BrainOverviewAnswer = BrainOverview | BrainRefusal
