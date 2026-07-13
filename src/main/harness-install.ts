import { USAGE_PROVIDERS, type CostScan } from '@contracts'
import { fakeAdapter, scanCost } from '@backend/features/usage'
import { installFaultHooks } from './fault-port'
import { installFixtures, type UpdateDriver, type UsageWorld } from './fixture-port'
import { maybeAsyncFault } from './async-audit-faults'
import { waitForMutationAudit } from './mutation-audit-faults'
import { consumeConsentSetFailure } from './browserzero-audit-faults'

// THE DEV SIDE OF THE PORTS (audit finding 41). Imported ONLY by src/main/index.dev.ts, which
// electron-vite uses for `serve` — so every module reachable from here (the *-audit-faults
// injectors, the FAKE usage adapter, the failing update feed) is in the DEV module graph and in
// no other. The production entry (src/main/index.ts) imports boot.ts alone, so the ports it links
// against stay inert and none of these strings exist in the shipped bundle.
//
// This is where the environment is READ. The production modules that used to read it — usage.ts,
// updater.ts, app-settings.ts, browser-dock.ts, and the eleven handlers behind maybeFault — now
// only call a null hook. Everything below is a MOVE, not a rewrite: same env names, same
// semantics, same lazy read-at-call (the smokes flip these vars at runtime, mid-run), same
// injected message text the gates assert on.

/** The updater's failing feed (UPDATEFAIL). What a dead/unreachable signed feed looks like. */
const driveFailedFeed: UpdateDriver = (push) => {
  push({ phase: 'checking', error: undefined })
  setTimeout(
    () =>
      push({
        phase: 'error',
        error: 'Could not reach the signed update feed. Check your connection and try again.',
        lastCheckedAt: Date.now()
      }),
    250
  )
}

/**
 * usage.ts's world (Phase-7/01, ADR 0007). The zero-network guarantee, unchanged and now
 * structural: a usage FIXTURE world holds only the FAKE adapter and a fixture status/cost world;
 * ANY OTHER gate holds no adapter and no status fetcher at all; and the real adapters — the real
 * network — are simply unreachable from here, because production asks the port and the port
 * answers null.
 *
 * Note `npm run dev` itself lands in the "any other gate" arm: prepareRuntime() sets
 * MOGGING_CHANNEL='dev', so `isSmoke` is true in a dev run. That is the long-standing behaviour
 * (usage polls nothing in dev) and it is preserved here verbatim.
 */
function usageWorld(): UsageWorld | null {
  const isSmoke = Object.keys(process.env).some((k) => k.startsWith('MOGGING_'))
  if (!isSmoke) return null // a real session: real adapters, real status, real cost, live prices
  const isFixtureWorld =
    Object.keys(process.env).some((k) => k.startsWith('MOGGING_USAGE')) ||
    !!process.env.MOGGING_SETUSAGE ||
    !!process.env.MOGGING_GALLERY ||
    !!process.env.MOGGING_UXMILESTONE // the 8.5/09 composed smoke shows Usage on the FAKE adapter — offline, like SETUSAGE

  const cadenceEnv = Number(process.env.MOGGING_USAGE_CADENCE_MS)
  const cadenceMsOverride =
    Number.isFinite(cadenceEnv) && cadenceEnv > 0 ? cadenceEnv : isFixtureWorld ? 400 : undefined

  if (!isFixtureWorld) {
    return {
      adapters: [],
      cadenceMsOverride,
      statusFetcher: null, // no endpoint may be touched
      costScan: (providerId) => ({
        providerId,
        days: [],
        currency: 'USD',
        reason: 'cost scan is disabled under smoke'
      })
    }
  }

  return {
    adapters: [fakeAdapter],
    cadenceMsOverride,
    statusRows: [{ id: 'fake', statusUrl: 'fixture://status' }],
    statusFetcher: async (): Promise<string> => {
      const s = process.env.MOGGING_USAGE_STATUS ?? 'operational'
      if (s === 'unknown') return 'not a status body'
      const indicator = s === 'outage' ? 'major' : s === 'degraded' ? 'minor' : 'none'
      const description =
        s === 'outage' ? 'Major Service Outage' : s === 'degraded' ? 'Partially Degraded Service' : 'All Systems Operational'
      return JSON.stringify({ status: { indicator, description } })
    },
    costScan: (providerId, windowDays): CostScan =>
      scanCost(
        providerId,
        process.env.MOGGING_USAGE_COSTDIR ?? null,
        windowDays !== undefined ? { windowDays } : {}
      )
  }
}

/** The PERSISTHEALTH gate's three broken moments. Read at CALL time — the smoke arms and disarms
 *  MOGGING_PERSIST_FAIL between phases of one run. */
const persistFault = (op: 'open' | 'load' | 'save'): string | null => {
  if (process.env.MOGGING_PERSIST_FAIL !== op) return null
  if (op === 'open') return 'injected workspace store open failure'
  if (op === 'load') return 'injected workspace load failure'
  return 'Injected workspace save failure.'
}

/**
 * Install every port. Called from src/main/index.dev.ts's module body, before bootMain() — so the
 * hooks are in place long before whenReady registers the handlers that consult them.
 */
export function installHarnessPorts(): void {
  installFaultHooks({
    channel: maybeAsyncFault, // reject / hang / delay a named channel (ASYNCSTATE)
    mutation: waitForMutationAudit, // hold grant/plan/profile pending (MUTATIONRACE)
    consentSet: consumeConsentSetFailure, // drop a consent write on purpose (BROWSERZERO)
    persist: persistFault // break open/load/save (PERSISTHEALTH)
  })

  installFixtures({
    usageWorld,
    // Armed by the gate's own var. Its PRESENCE is also what tells updater.ts the real feed is off.
    updateDriver: process.env.MOGGING_UPDATEFAIL ? driveFailedFeed : undefined,
    vaultDisabled: () => !!process.env.MOGGING_TEST_NO_VAULT,
    exportPath: () => process.env.MOGGING_PERSIST_EXPORT_PATH ?? null
  })
}
