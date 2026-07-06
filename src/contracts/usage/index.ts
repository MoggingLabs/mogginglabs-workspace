// Usage-meter contracts (Phase-7/01, ADR 0007). Pure data shapes shared by the
// backend seam and the UI. NOTHING here may carry a credential: adapters read
// tokens in memory for one request and return ONLY these normalized shapes.

/** Snapshot freshness. `stale` = last good data re-served after an error;
 *  `unconfigured` = the CLI/store isn't there (labeled state, not an error). */
export type UsageHealth = 'fresh' | 'stale' | 'error' | 'unconfigured'

/** One metered window (e.g. the 5h session window, the weekly window). */
export interface UsageWindow {
  label: string
  /** 0–100. Clamped by the seam; adapters normalize provider units to this. */
  usedPct: number
  /** ISO timestamp of the window reset, when the provider exposes it. */
  resetsAt?: string
  /** Provider's own wording for this window, when it helps ("resets Tue 14:00"). */
  raw?: string
}

/** Usage for one plan on one (provider, profile) pair — the tile unit. */
export interface PlanUsage {
  providerId: string
  /** Phase-4 profile id, or 'default' when no profile targets the provider. */
  profileId: string
  planLabel: string
  windows: UsageWindow[]
  /** Credit-style balance where a provider has one (label + remaining units). */
  credits?: { label: string; remaining: number }
  /** Epoch ms of the fetch that produced this data (stale keeps the OLD stamp). */
  fetchedAt: number
  health: UsageHealth
  /** Human reason for error/unconfigured/stale — UI renders it verbatim. */
  reason?: string
}

/** A provider usage adapter. `home` is the RESOLVED config home for the profile
 *  being read (pointer env or the per-OS default) — adapters never resolve
 *  profiles themselves and never look outside `home` + their known endpoint. */
export interface UsageAdapter {
  id: string
  /** Is this provider readable at `home`? false + reason -> `unconfigured`. */
  detect(home: string): Promise<{ ok: boolean; reason?: string }>
  /** Fetch + normalize. May return several plans. Throws only Error(reason) —
   *  the seam maps it to health 'error'/'stale'; a token NEVER rides an error. */
  fetch(home: string, profileId: string, signal: AbortSignal): Promise<PlanUsage[]>
}

export const USAGE_CADENCES = ['manual', '1m', '2m', '5m', '15m'] as const
export type UsageCadence = (typeof USAGE_CADENCES)[number]

export const USAGE_CADENCE_MS: Record<Exclude<UsageCadence, 'manual'>, number> = {
  '1m': 60_000,
  '2m': 120_000,
  '5m': 300_000,
  '15m': 900_000
}
