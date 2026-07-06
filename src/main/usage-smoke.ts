import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setFakeMode, computePace, formatVerdict, PACE_GOLDENS } from '@backend/features/usage'
import { getUsageService } from './usage'

// Env-gated usage-seam smoke (MOGGING_USAGE, Phase-7/01). Runs entirely on the
// FAKE adapter (the registry holds nothing else under this env — zero network
// is structural). Cadence is shortened via the registerUsage override (400ms)
// so real timers exercise the real scheduler:
//   1. snapshot shape: all seven fixture states present, usedPct in [0,100]
//   2. cadence: fetch count advances across ticks
//   3. stale-after-error: fake flips to error -> fresh tiles become stale WITH
//      the old fetchedAt kept + a human reason; backoff delay grows past base
//   4. hidden: setVisible(false) freezes the fetch count; true resumes it
//   5. grep-clean: no token-shaped key or value anywhere in the snapshot
export function runUsageSmoke(_win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000) // safety net
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'usage-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      const svc = getUsageService()
      if (!svc) throw new Error('usage service not registered')

      // 1 ── first poll lands (first read is scheduled ~immediately)
      let tries = 0
      while (svc.list().length === 0 && tries++ < 50) await sleep(200)
      const snap = svc.list()
      const healths = new Set(snap.map((p) => p.health))
      const profileIds = new Set(snap.map((p) => p.profileId))
      const pctOk = snap.every((p) => p.windows.every((w) => w.usedPct >= 0 && w.usedPct <= 100))
      const shapeOk =
        snap.length === 7 &&
        healths.has('fresh') &&
        healths.has('stale') &&
        healths.has('error') &&
        healths.has('unconfigured') &&
        profileIds.has('near-limit') &&
        profileIds.has('exhausted') &&
        profileIds.has('fresh-reset') &&
        pctOk

      // 2 ── cadence: the scheduler keeps polling (400ms base under this env)
      const f0 = svc.debug().providers.fake.fetches
      await sleep(1400)
      const f1 = svc.debug().providers.fake.fetches
      const cadenceOk = f1 > f0

      // 3 ── stale-after-error + backoff growth
      const freshBefore = svc.list().find((p) => p.profileId === 'default')
      setFakeMode('error')
      let stale: (typeof snap)[number] | undefined
      tries = 0
      while (!stale && tries++ < 60) {
        await sleep(200)
        stale = svc.list().find((p) => p.profileId === 'default' && p.health === 'stale')
      }
      // Let the errors stack so backoff visibly exceeds the 400ms base.
      await sleep(1600)
      const dbg = svc.debug().providers.fake
      const staleOk =
        !!stale &&
        stale.fetchedAt === freshBefore?.fetchedAt && // old data kept, old stamp kept
        typeof stale.reason === 'string' &&
        stale.reason.length > 0
      const backoffOk = dbg.errors >= 2 && dbg.lastDelayMs > 500 // > jittered base
      setFakeMode('ok')

      // 4 ── hidden pauses the poller; visible resumes it
      svc.setVisible(false)
      await sleep(400) // let any in-flight poll drain
      const h0 = svc.debug().providers.fake.fetches
      await sleep(1400)
      const h1 = svc.debug().providers.fake.fetches
      const hiddenOk = h1 === h0 && svc.debug().visible === false
      svc.setVisible(true)
      tries = 0
      while (svc.debug().providers.fake.fetches === h1 && tries++ < 40) await sleep(200)
      const resumeOk = svc.debug().providers.fake.fetches > h1

      // 5 ── grep-clean: nothing token-shaped in the snapshot payload
      const flat = JSON.stringify(svc.list()).toLowerCase()
      const grepClean = !/accesstoken|refreshtoken|"token"|sk-ant|bearer/.test(flat)

      // 6 ── the golden pace table (7/02): verdict + rounded delta + EXACT
      // wording for every fixture; any drift — math or words — fails the gate.
      const goldenFails: string[] = []
      for (const g of PACE_GOLDENS) {
        const report = computePace(g.window, g.now, g.opts)
        if (g.expect === null) {
          if (report !== null) goldenFails.push(`${g.name}: expected refusal, got ${report.verdict}`)
          continue
        }
        if (!report) {
          goldenFails.push(`${g.name}: expected ${g.expect.verdict}, engine refused`)
          continue
        }
        if (report.verdict !== g.expect.verdict)
          goldenFails.push(`${g.name}: verdict ${report.verdict} != ${g.expect.verdict}`)
        if (Math.round(report.paceDelta) !== g.expect.deltaRounded)
          goldenFails.push(`${g.name}: delta ${Math.round(report.paceDelta)} != ${g.expect.deltaRounded}`)
        const text = formatVerdict(report, g.window.label)
        if (text !== g.expect.text) goldenFails.push(`${g.name}: wording "${text}" != "${g.expect.text}"`)
      }
      const goldenOk = goldenFails.length === 0

      const pass = shapeOk && cadenceOk && staleOk && backoffOk && hiddenOk && resumeOk && grepClean && goldenOk
      result = { pass, shapeOk, cadenceOk, staleOk, backoffOk, hiddenOk, resumeOk, grepClean, goldenOk, goldenFails, goldens: PACE_GOLDENS.length, tiles: snap.length, debug: svc.debug() }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  void run()
}
