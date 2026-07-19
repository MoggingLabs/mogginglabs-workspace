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

// ── The repomap budget (ADR 0018 step 06) ────────────────────────────────────
// CHARACTER budgets (deterministic and CLI-neutral, never tokens). Moved here
// from the render layer in revision D: the launch seam's SHARED injection
// budget IS the map's default — the renderer needs the same constant the
// serve layer clamps by, and one number typed twice is how drift starts.
export const REPOMAP_DEFAULT_BUDGET = 4000
export const REPOMAP_MAX_BUDGET = 16000
export const REPOMAP_MIN_BUDGET = 200

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
 * `brain:semCfgGet` — the semantic lens's per-workspace target (ADR 0018
 * revision A, the lens law). BYO only: both fields are EMPTY until the human
 * sets them — no default endpoint exists, no model is bundled, and no request
 * ever leaves for anywhere but this endpoint. The key never rides any channel:
 * `keySlot` is the ADR 0007a presence story (vault ciphertext or an env-ref
 * NAME at rest; set / clear / presence — no getter exists).
 */
export interface BrainSemConfig {
  endpoint: string
  model: string
  keySlot: { kind: 'keychain' } | { kind: 'env-ref'; envRef: string } | { kind: 'none' }
}

// ── Dual memory, auto-captured (ADR 0018 revision C) ─────────────────────────
// Drafts are STRUCTURED memories the app captures from signals it already owns
// (a pane's command-block ladder on session end, a review merge, a board card
// reaching Done). They land quarantined in `.memory/drafts/<slug>.md` — second-
// class BY CONSTRUCTION until a granted promote — and retention is honest:
// capped, oldest-out, every eviction counted.

/** Draft retention caps — contracts, not tunables (the cap posture). */
export const BRAIN_MAX_DRAFTS = 200
export const BRAIN_DRAFT_MAX_AGE_DAYS = 30

/** One completed command block from a pane's ladder (OSC 133 truth): the
 *  command line, its exit code, and how long it ran. SIGNALS, never scraped
 *  pane text — the block vocabulary is the whole capture surface. */
export interface BrainCaptureBlock {
  command: string
  exitCode?: number
  durationMs?: number
}

/** `brain:captureSession` — a pane's ladder at session end (process exit or
 *  pane close). Fire-and-forget: main validates, redacts, and lands a draft
 *  only when the ladder carries signal. */
export interface BrainCaptureSessionRequest {
  pane: string
  blocks: BrainCaptureBlock[]
}

/** Where a draft came from — the closed provenance set. */
export type BrainDraftSource = 'session' | 'merge' | 'card'

/** One draft row (`brain:drafts`) — list-light; `brain:draftGet` adds the body. */
export interface BrainDraftRow {
  slug: string
  name: string
  description: string
  tags: string[]
  source: BrainDraftSource | ''
  distilled: boolean
  mtime: number
  root: string
}

export type BrainDraftsAnswer = { ok: true; drafts: BrainDraftRow[]; evicted: number } | BrainRefusal

/** `brain:distillGet` — the optional distillation lens's per-workspace knobs:
 *  consent (default OFF) and the chat model. The endpoint and key are revision
 *  A's BYO embed target — one endpoint, two adapters, zero new custody. */
export interface BrainDistillConfig {
  on: boolean
  model: string
}

/** `.memory/` files the scan refused to index, summed across the project's
 *  roots (ADR 0018 revision B) — counted honestly, shown only when nonzero. */
export interface BrainMemorySkips {
  /** Non-slug filenames, unreadable frontmatter, binaries. */
  invalid: number
  /** Files past the per-file byte cap. */
  tooLarge: number
  /** Non-`.md` entries and subdirectories (an Obsidian vault drops these). */
  foreign: number
  /** TRUE when any root's flat-dir scan hit its file cap. */
  capped: boolean
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
  /** Honest `.memory/` skip counts (revision B) — the "skipped" row's truth. */
  memorySkips: BrainMemorySkips
  /** Quarantined drafts across the project's roots (revision C). */
  drafts: number
  /** Drafts evicted by retention (cap / max age) — counted, never silent. */
  draftsEvicted: number
}

export type BrainOverviewAnswer = BrainOverview | BrainRefusal

// ── The RECALL organ (ADR 0018 revision D): memory reaches the agent ─────────
// `recall_memories` ranks CURATED memories against a task's text — the read a
// cold pane is pre-briefed with and a working agent asks "what do we know?"
// through. Deterministic by default (FTS bm25 + fixed-weight tag and backlink
// boosts, breakdown served); the semantic lens's consent upgrades the blend to
// hybrid, labeled. Drafts are excluded ALWAYS (revision C's quarantine is
// table topology, not a filter).

/** Recall page caps — small by design: a pre-brief, never a dump. */
export const MEMORY_RECALL_DEFAULT_LIMIT = 5
export const MEMORY_RECALL_MAX_LIMIT = 20

/**
 * `brain:recall` — the launch seam's door (and the smoke's): the same serve
 * verb the MCP tool answers, keyed by an explicit root. `workspaceId` names
 * whose semantic-lens consent may upgrade the blend to hybrid — absent (or
 * unconsenting) stays exact, and a failed embed FALLS BACK to exact, labeled
 * truthfully in the reply's `mode` (recall is a garnish, never a blocker).
 */
export interface BrainRecallRequest {
  root: string
  task: string
  workspaceId?: string
  limit?: number
}

/** One curated memory's usage truth (`brain:memUsage`) — plain integers the
 *  HUMAN reads to prune dead memories. Counted, never decayed: the app has no
 *  automatic forgetting and never deletes a curated memory (revision D). */
export interface BrainMemoryUsageRow {
  slug: string
  name: string
  description: string
  /** Times this memory rode a recall answer (tool, CLI, or spawn injection). */
  recalls: number
  /** Times an agent read it in full over the wire (`get_memory`). */
  reads: number
  root: string
}

export type BrainMemoryUsageAnswer = { ok: true; rows: BrainMemoryUsageRow[] } | BrainRefusal
