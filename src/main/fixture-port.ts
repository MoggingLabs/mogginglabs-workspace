import type { CostScan, UpdateState, UsageAdapter } from '@contracts'
import type { StatusFetcher, StatusProviderRow } from '@backend/features/usage'

// THE PRODUCTION SIDE OF THE HARNESS'S FIXTURE SEAMS (audit finding 41).
//
// Siblings of fault-port.ts, and a different animal: a fault makes production MISBEHAVE, a
// fixture REPLACES production data or IO with a fake. Both used to be decided inside the
// production module itself, and both therefore shipped.
//
// usage.ts was the worst of them. It read the environment directly — any MOGGING_USAGE* var, or
// MOGGING_SETUSAGE / MOGGING_UXMILESTONE / MOGGING_GALLERY — and, when it saw one, swapped the
// FAKE usage adapter in for the real ones. Which means the shipped app would, given an
// environment variable, show a user FABRICATED usage and spend numbers as if they were their own.
// updater.ts carried the same shape in MOGGING_UPDATEFAIL: a failing update feed, one env var
// away, inside a signed build.
//
// Inert here; src/main/index.dev.ts installs the real fixtures (src/main/harness-install.ts).

/** Everything usage.ts must do DIFFERENTLY under the harness. Null = the real world. */
export interface UsageWorld {
  /** Registered INSTEAD of the real adapters. Empty = none at all (a non-usage gate polls nothing). */
  adapters: UsageAdapter[]
  cadenceMsOverride?: number
  /** Omitted = the real catalog rows. */
  statusRows?: StatusProviderRow[]
  /** null = no status endpoint may be touched at all — structural, not a setting. */
  statusFetcher: StatusFetcher | null
  /** Replaces the on-disk cost scan (a seeded fixture dir, or a labeled refusal). */
  costScan: (providerId: string, windowDays?: number) => CostScan
}

/** Drives the whole update lifecycle to the renderer instead of the signed feed. */
export type UpdateDriver = (push: (patch: UpdateState) => void) => void

export interface FixtureHooks {
  /** Called once, per registerUsage(), AFTER the env is settled (prepareRuntime has run). */
  usageWorld?: () => UsageWorld | null
  /** Armed only by the UPDATEFAIL gate. Its presence also means "the real feed is off". */
  updateDriver?: UpdateDriver
  /** Force the vault-conditioned agent-web persistence OFF (manual dev/test affordance). */
  vaultDisabled?: () => boolean
  /** Skip the native save dialog and export straight to this path. */
  exportPath?: () => string | null
}

let hooks: FixtureHooks = {}

/** Dev/test entry ONLY (src/main/harness-install.ts). Production never calls it. */
export function installFixtures(next: FixtureHooks): void {
  hooks = next
}

/** The harness's usage world, or null — which is what a real, shipped session always gets. */
export function usageWorld(): UsageWorld | null {
  return hooks.usageWorld?.() ?? null
}

/** The harness's update driver, or null. Non-null also means the real feed must not run. */
export function updateDriver(): UpdateDriver | null {
  return hooks.updateDriver ?? null
}

export function vaultDisabled(): boolean {
  return hooks.vaultDisabled?.() ?? false
}

export function exportPathOverride(): string | null {
  return hooks.exportPath?.() ?? null
}
