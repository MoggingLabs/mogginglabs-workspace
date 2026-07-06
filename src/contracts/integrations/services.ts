// Service-adapter seam (Phase-8/01; 12 ships FAKE + GitHub). Mirrors
// `@contracts/usage` deliberately: adapters ride the session the user's own
// tool already holds (`gh auth token` — in memory, one request, never
// persisted/logged/shown, ADR 0008.d), normalize to closed shapes, and
// degrade to LABELED states, never throws into the UI. NOTHING here may
// carry a credential.

/** Snapshot freshness — the usage discipline verbatim: `stale` = last good
 *  data re-served after an error; `unconfigured` = the tool isn't there
 *  (a labeled state, not an error). */
export type LinkHealth = 'fresh' | 'stale' | 'error' | 'unconfigured'

export type ServiceLinkKind = 'pr' | 'issue'

/** Per-link poll cadence (12: jittered, backoff, paused while hidden). */
export const SERVICE_LINK_CADENCES = ['manual', '1m', '5m', '15m'] as const
export type ServiceLinkCadence = (typeof SERVICE_LINK_CADENCES)[number]
export const SERVICE_LINK_CADENCE_DEFAULT: ServiceLinkCadence = '5m'
export const SERVICE_LINK_CADENCE_MS: Record<Exclude<ServiceLinkCadence, 'manual'>, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000
}

/** A board card's link to one service object. `ref` is a REF, structurally
 *  ("owner/repo#123") — repo names/URLs stay out of telemetry (ADR 0005). */
export interface ServiceLink {
  id: string
  /** Adapter id (e.g. "github"; the smoke world registers only "fake"). */
  service: string
  cardId: string
  kind: ServiceLinkKind
  /** Normalized "owner/repo#123" — parsed from a pasted URL or shorthand. */
  ref: string
  cadence: ServiceLinkCadence
}

export type ServiceLinkState = 'open' | 'draft' | 'merged' | 'closed'
export type ServiceReviewDecision = 'approved' | 'changes-requested' | 'review-required'
export type ServiceChecksState = 'passing' | 'failing' | 'pending' | 'none'

/** One normalized status snapshot — the chip/detail unit. Stale keeps the
 *  OLD `fetchedAt` (the usage discipline); `reason` renders verbatim. */
export interface LinkStatus {
  linkId: string
  health: LinkHealth
  state?: ServiceLinkState
  reviewDecision?: ServiceReviewDecision
  checks?: ServiceChecksState
  /** The PR/issue title — UI only, never telemetry (ADR 0005). */
  title?: string
  /** Epoch ms of the fetch that produced this data. */
  fetchedAt: number
  reason?: string
}

/** A service adapter, mirroring `UsageAdapter`: detect the user's own tool,
 *  fetch one bounded request per refresh. Throws only Error(reason) — the
 *  seam maps it to `error`/`stale`; a token NEVER rides an error. */
export interface ServiceAdapter {
  id: string
  /** Is the riding tool available (e.g. `gh` on PATH + logged in enough to
   *  try)? false + reason -> `unconfigured`. */
  detect(): Promise<{ ok: boolean; reason?: string }>
  /** Fetch + normalize one link's status. Read-only, one bounded request. */
  fetch(link: ServiceLink, signal: AbortSignal): Promise<LinkStatus>
}
