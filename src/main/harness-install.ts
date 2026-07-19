import type { CostScan } from '@contracts'
import { fakeAdapter, scanCost } from '@backend/features/usage'
import { installFaultHooks } from './fault-port'
import { installFixtures, type UpdateFeedFixture, type UsageWorld } from './fixture-port'
import { maybeAsyncFault } from './async-audit-faults'
import { waitForMutationAudit } from './mutation-audit-faults'
import { consumeConsentSetFailure } from './browserzero-audit-faults'
import { currentBoardGhWorld } from './boardgh-audit-fixture'

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

/**
 * The updater's fixture feeds — scripted check OUTCOMES, not renderer states, so what the
 * gates exercise is updater.ts's real offline-vs-broken classification and retry ladder.
 *
 * UPDATEFAIL: a feed that is REACHED and broken (the artifact-name bug's shape — every
 * check 404s). Must stay LOUD on every check, background included: that silence lasting
 * nine releases is why the rail row exists.
 *
 * UPDATEOFFLINE: the wake-from-sleep DNS blip (found live on v0.14.0 — updater.log shows
 * ERR_NAME_NOT_RESOLVED while the Wi-Fi re-associated, and the rail wore a red "Update
 * failed — retry" for hours on a healthy network). Outcomes are keyed on
 * MOGGING_UPDATE_OUTCOME read PER CHECK — the smoke flips it to 'ok' mid-run to end the
 * outage, so the choreography is deterministic under any timer interleaving. The compressed
 * ladder lets the gate watch the self-heal inside its timeout.
 */
const brokenFeed: UpdateFeedFixture = {
  next: () => ({
    kind: 'error',
    message: 'HttpError: 404 "https://github.com/MoggingLabs/mogginglabs-workspace/releases/latest.yml"'
  })
}
const offlineFeed: UpdateFeedFixture = {
  next: () =>
    process.env.MOGGING_UPDATE_OUTCOME === 'ok'
      ? { kind: 'ok' }
      : { kind: 'error', message: 'Error: net::ERR_NAME_NOT_RESOLVED' },
  retryDelaysMs: [1500]
}

/**
 * usage.ts's world (Phase-7/01, ADR 0007). The zero-network guarantee, unchanged and now
 * structural: a usage FIXTURE world holds only the FAKE adapter and a fixture status/cost world;
 * ANY OTHER gate holds no adapter and no status fetcher at all; and the real adapters — the real
 * network — are simply unreachable from here, because production asks the port and the port
 * answers null.
 *
 * `isSmoke` means A GATE IS DRIVING THIS BOOT — so the two MOGGING_ vars the app sets on
 * ITSELF every run (boot.ts sets MOGGING_CHANNEL='dev' on any unpackaged boot; cli-runtime
 * sets MOGGING_CLI when it manages a shim) must not count, or the check degenerates to
 * "is dev at all" and the real-session arm below is unreachable in dev. Excluding them,
 * a plain `npm run dev` gets the REAL adapters (dev is representative of the shipped app)
 * while every gate — each sets its own MOGGING_<GATE> var — keeps its fixture world.
 */
const SELF_SET_ENV = new Set(['MOGGING_CHANNEL', 'MOGGING_CLI'])

function usageWorld(): UsageWorld | null {
  const isSmoke = Object.keys(process.env).some((k) => k.startsWith('MOGGING_') && !SELF_SET_ENV.has(k))
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
    // Armed by each gate's own var. Its PRESENCE is also what tells updater.ts the real feed is off.
    updateFeed: process.env.MOGGING_UPDATEFAIL
      ? brokenFeed
      : process.env.MOGGING_UPDATEOFFLINE
        ? offlineFeed
        : undefined,
    vaultDisabled: () => !!process.env.MOGGING_TEST_NO_VAULT,
    exportPath: () => process.env.MOGGING_PERSIST_EXPORT_PATH ?? null,
    boardGhWorld: currentBoardGhWorld // armed only by the BOARDGH smoke's setBoardGhWorld
  })
}
