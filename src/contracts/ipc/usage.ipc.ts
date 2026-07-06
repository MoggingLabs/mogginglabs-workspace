/**
 * Usage-meter IPC (Phase-7/01, ADR 0007). The renderer sees NORMALIZED shapes
 * only (@contracts/usage) — no token, path, or account identifier crosses this
 * seam, and usage values never enter telemetry (ADR 0005).
 *
 *   usage:list    -> PlanUsage[]  (the cached snapshot — instant, never fetches)
 *   usage:refresh -> void         (poke the poller; results arrive via the push)
 *   usage:changed  main -> renderer: PlanUsage[] (pushed whenever the snapshot moves)
 */

export type { PlanUsage, UsageWindow, UsageHealth, UsageCadence } from '../usage'
