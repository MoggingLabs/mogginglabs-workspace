import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setFakeMode, computePace, formatVerdict, PACE_GOLDENS, readCodex, API_KEY_SPECS, fetchVertex, fetchBedrock } from '@backend/features/usage'
import { USAGE_PROVIDERS, UsageChannels, AllChannels } from '@contracts'
import { getUsageService } from './usage'
import { keySetPlaintext, keySetEnvRef, keyClear, keySlot, resolveKey, setKeyAvailabilityProbeForSmoke, isKeyVaultAvailable } from './usage-keys'
import { getSettingsStore } from './app-settings'

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
        snap.length === 10 &&
        healths.has('fresh') &&
        healths.has('stale') &&
        healths.has('error') &&
        healths.has('unconfigured') &&
        profileIds.has('near-limit') &&
        profileIds.has('exhausted') &&
        profileIds.has('fresh-reset') &&
        profileIds.has('credits') &&
        profileIds.has('daily') &&
        profileIds.has('multi-lane') &&
        // credit fixture carries a balance; multi-lane carries three windows
        !!snap.find((p) => p.profileId === 'credits')?.credits &&
        snap.find((p) => p.profileId === 'multi-lane')?.windows.length === 3 &&
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

      // 7 ── catalog integrity (7/04): valid klass, ≥1 window or credits,
      //      unique ids, valid verifiedAt when present.
      const KLASSES = new Set(['cli-store', 'api-key', 'cloud-cli', 'web-session', 'local'])
      const ids = new Set<string>()
      const catalogFails: string[] = []
      for (const def of USAGE_PROVIDERS) {
        if (!KLASSES.has(def.klass)) catalogFails.push(`${def.id}: bad klass ${def.klass}`)
        if (ids.has(def.id)) catalogFails.push(`${def.id}: duplicate id`)
        ids.add(def.id)
        if (def.windows.length === 0 && !def.credits) catalogFails.push(`${def.id}: no window or credits`)
        if (def.verifiedAt && Number.isNaN(Date.parse(def.verifiedAt))) catalogFails.push(`${def.id}: bad verifiedAt`)
      }
      const catalogOk = catalogFails.length === 0

      // 8 ── the REAL Codex reader normalizes a FIXTURE session log (zero
      //      network — the exact shape captured on the dev machine 2026-07-06).
      const cdir = mkdtempSync(join(tmpdir(), 'mog-codex-'))
      mkdirSync(join(cdir, 'sessions', '2026', '05'), { recursive: true })
      writeFileSync(join(cdir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'FIXTURE_SECRET' } }))
      const resetsPrimary = Math.floor(Date.now() / 1000) + 3600
      const resetsSecondary = Math.floor(Date.now() / 1000) + 3 * 86400
      writeFileSync(
        join(cdir, 'sessions', '2026', '05', 'rollout-x.jsonl'),
        [
          JSON.stringify({ type: 'message', payload: { text: 'hi' } }),
          JSON.stringify({
            type: 'turn',
            payload: {
              rate_limits: {
                primary: { used_percent: 22, window_minutes: 300, resets_at: resetsPrimary },
                secondary: { used_percent: 42, window_minutes: 10080, resets_at: resetsSecondary },
                plan_type: 'prolite'
              }
            }
          })
        ].join('\n')
      )
      const codexPlan = await readCodex(cdir, 'default', new AbortController().signal)
      const codexOk =
        codexPlan.health === 'fresh' &&
        codexPlan.planLabel === 'Codex (prolite)' &&
        codexPlan.windows.length === 2 &&
        codexPlan.windows[0].usedPct === 22 &&
        codexPlan.windows[0].windowMs === 300 * 60_000 &&
        codexPlan.windows[1].usedPct === 42 &&
        !!codexPlan.windows[0].resetsAt &&
        // the token NEVER rides the normalized shape
        !JSON.stringify(codexPlan).includes('FIXTURE_SECRET')
      // absent store degrades, never throws
      const codexAbsent = await readCodex(join(cdir, 'nope'), 'default', new AbortController().signal)
      const codexDegrades = codexAbsent.health === 'unconfigured' && typeof codexAbsent.reason === 'string'

      // 9 ── keys at rest (7/05, ADR 0007.a): paste-once ciphertext, WRITE-ONLY.
      //      Vault-dependent PROBES are platform-conditioned (a keyring-less
      //      Linux CI has no real vault: basic_text counts as unavailable and
      //      the claim holds via REFUSAL) — the CLAIM never weakens.
      const SECRET = 'sk-or-v1-SMOKEONLY-0123456789abcdef0123456789abcdef'
      const SECRET2 = 'sk-or-v1-SMOKEONLY-fedcba9876543210fedcba9876543210'
      const vaultAvailable = isKeyVaultAvailable()
      let cipherOk = true
      let dbBytesOk = true
      let roundtripOk = true
      let replaceOk = true
      let clearOk = true
      if (vaultAvailable) {
        const set1 = keySetPlaintext('openrouter', SECRET)
        const rawCipher = getSettingsStore()?.getSetting('usage.keycipher.openrouter') ?? ''
        cipherOk = set1.ok && rawCipher.length > 0 && !rawCipher.includes(SECRET) && keySlot('openrouter').kind === 'keychain'
        // the settings DB bytes (incl. WAL) never contain the plaintext
        const udata = app.getPath('userData')
        let dbBytes = ''
        for (const f of ['app-settings.db', 'app-settings.db-wal']) {
          const fp = join(udata, f)
          if (existsSync(fp)) dbBytes += readFileSync(fp, 'latin1')
        }
        dbBytesOk = dbBytes.length > 0 && !dbBytes.includes(SECRET)
        // roundtrip via the ADAPTER path (internal, not a channel), replace, clear
        roundtripOk = resolveKey('openrouter') === SECRET
        const set2 = keySetPlaintext('openrouter', SECRET2)
        const cipher2 = getSettingsStore()?.getSetting('usage.keycipher.openrouter') ?? ''
        replaceOk = set2.ok && cipher2 !== rawCipher && resolveKey('openrouter') === SECRET2
        keyClear('openrouter')
        clearOk = keySlot('openrouter').kind === 'none' && resolveKey('openrouter') === null
      } else {
        console.warn('⚠ usage-smoke: no REAL key vault here (basic_text/none) — cipher probes skipped; refusal path asserted instead')
        const natural = keySetPlaintext('openrouter', SECRET)
        cipherOk = !natural.ok && /env-ref/i.test(natural.reason ?? '') && keySlot('openrouter').kind === 'none'
      }
      // encryption unavailable -> REFUSED with the env-ref hint (never plaintext at rest)
      setKeyAvailabilityProbeForSmoke(() => false)
      const refused = keySetPlaintext('openrouter', SECRET)
      setKeyAvailabilityProbeForSmoke(null)
      const refusalOk = !refused.ok && /env-ref/i.test(refused.reason ?? '') && keySlot('openrouter').kind === 'none'
      // env-ref: NAME accepted + resolves from env; secret-shaped LITERAL refused
      process.env.MOGGING_SMOKE_KEYVAR = 'resolved-from-env'
      const envSet = keySetEnvRef('openrouter', '${MOGGING_SMOKE_KEYVAR}')
      const envRefOk = envSet.ok && keySlot('openrouter').kind === 'env-ref' && resolveKey('openrouter') === 'resolved-from-env'
      const envLit = keySetEnvRef('openrouter', SECRET)
      const envLiteralRefusedOk = !envLit.ok
      keyClear('openrouter')
      delete process.env.MOGGING_SMOKE_KEYVAR
      const keysOk = cipherOk && dbBytesOk && roundtripOk && replaceOk && clearOk && refusalOk && envRefOk && envLiteralRefusedOk

      // 10 ── no-getter is STRUCTURAL: the channel allowlist has set/clear and
      //       nothing that could read a key back.
      const usageChannelNames = Object.values(UsageChannels)
      const noGetterOk =
        usageChannelNames.includes('usage:keySet') &&
        usageChannelNames.includes('usage:keyClear') &&
        !AllChannels.some((c) => /usage:key(get|read|reveal|show|list)/i.test(c))

      // 11 ── api-key spec parses (fixture bodies, zero network) + shape-drift throws
      let specsOk = true
      try {
        const or = API_KEY_SPECS.openrouter.parse({ data: { total_credits: 10, total_usage: 2.5 } }, Date.now(), 'default')
        specsOk &&= or.credits?.remaining === 7.5 && or.windows[0].usedPct === 25 && or.health === 'fresh'
        const el = API_KEY_SPECS.elevenlabs.parse(
          { character_count: 5000, character_limit: 10000, next_character_count_reset_unix: Math.floor(Date.now() / 1000) + 86400, tier: 'creator' },
          Date.now(),
          'default'
        )
        specsOk &&= el.windows[0].usedPct === 50 && !!el.windows[0].resetsAt && el.planLabel === 'ElevenLabs (creator)'
        const ds = API_KEY_SPECS.deepseek.parse({ balance_infos: [{ currency: 'USD', total_balance: 12.34 }] }, Date.now(), 'default')
        specsOk &&= ds.credits?.remaining === 12.34
        let threw = false
        try {
          API_KEY_SPECS.openrouter.parse({ nope: true }, Date.now(), 'default')
        } catch {
          threw = true
        }
        specsOk &&= threw
      } catch {
        specsOk = false
      }

      // 12 ── cloud-cli absent-CLI ladder (injected fake bins — deterministic on
      //       every machine incl. CI images that ship real cloud CLIs; zero network)
      const vx = await fetchVertex('default', 'mog-definitely-absent-gcloud')
      const bd = await fetchBedrock('default', 'mog-definitely-absent-aws')
      const cloudOk =
        vx.health === 'unconfigured' && /gcloud/.test(vx.reason ?? '') && bd.health === 'unconfigured' && /aws/i.test(bd.reason ?? '')

      const pass =
        shapeOk && cadenceOk && staleOk && backoffOk && hiddenOk && resumeOk && grepClean && goldenOk && catalogOk && codexOk && codexDegrades && keysOk && noGetterOk && specsOk && cloudOk
      result = { pass, shapeOk, cadenceOk, staleOk, backoffOk, hiddenOk, resumeOk, grepClean, goldenOk, goldenFails, catalogOk, catalogFails, codexOk, codexDegrades, vaultAvailable, keysOk, cipherOk, dbBytesOk, roundtripOk, replaceOk, clearOk, refusalOk, envRefOk, envLiteralRefusedOk, noGetterOk, specsOk, cloudOk, providers: USAGE_PROVIDERS.length, goldens: PACE_GOLDENS.length, tiles: snap.length, debug: svc.debug() }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  void run()
}
