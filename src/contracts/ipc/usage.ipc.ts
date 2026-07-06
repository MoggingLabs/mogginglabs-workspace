/**
 * Usage-meter IPC (Phase-7/01+03, ADR 0007). The renderer sees NORMALIZED
 * shapes only — no token, path, or account identifier crosses this seam, and
 * usage values never enter telemetry (ADR 0005).
 *
 *   usage:list      -> PlanUsageView[] (cached snapshot — instant, never fetches)
 *   usage:refresh   -> void            (poke the poller; results arrive via push)
 *   usage:changed    main -> renderer: PlanUsageView[] (pushed on change)
 *   usage:configGet -> UsageConfig     (per-provider enable + cadence)
 *   usage:configSet (UsageConfigPatch) -> void (persists + reschedules live)
 *   usage:cost      (providerId) -> CostScan  (7/07: on-demand LOCAL log scan)
 *   usage:history   ({ providerId, window }) -> number[] (7/07: OUR KV ring)
 */

import type { PlanUsage, PaceVerdict, UsageCadence } from '../usage'

/** Pace, PRE-FORMATTED by the one backend formatter (7/02) — the renderer
 *  displays these verbatim and never re-spells a verdict. Absent when the
 *  data can't be paced (error/unconfigured/unknown window) — surfaces render
 *  snapshot age instead. */
export interface PaceView {
  verdict: PaceVerdict
  /** THE binding wording from formatVerdict — rendered verbatim. */
  text: string
  /** "+12%" / "-3%" / "0%" from formatPaceDelta. */
  deltaText: string
  /** Severity ink class hint: warning | neutral | quiet. */
  severity: 'warning' | 'neutral' | 'quiet'
}

/** What the UI renders: the plan plus its pace view (worst window wins). */
export type PlanUsageView = PlanUsage & { pace?: PaceView }

export interface UsageConfig {
  providers: {
    id: string
    enabled: boolean
    cadence: UsageCadence
    /** Key slot KIND (ADR 0007.a) — presence only, never a value. */
    key?: 'keychain' | 'env-ref' | 'none'
    /** web-session browser store-read opt-in (ADR 0007.b), default false. */
    webRead?: boolean
  }[]
}

export interface UsageConfigPatch {
  providerId: string
  enabled?: boolean
  cadence?: UsageCadence
}

export type { PlanUsage, UsageWindow, UsageHealth, UsageCadence, CostScan, CostDay } from '../usage'
