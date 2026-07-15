import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setFakeMode, computePace, formatVerdict, PACE_GOLDENS, readCodex, API_KEY_SPECS, fetchVertex, fetchBedrock, scanCost, appendHistory, readHistory, HISTORY_MAX, normalizeStatusBody, createStatusService, createUsageService, evaluateThresholds } from '@backend/features/usage'
import { USAGE_PROVIDERS, UsageChannels, AllChannels, type PlanUsageView } from '@contracts'
import { getUsageService, getUsageStatusService } from './usage'
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
//   (…7/07: 13. the LOCAL cost scan sums seeded Codex/Claude JSONL fixtures
//   EXACTLY — dedupe honored, absent dirs degrade labeled, zero network;
//   14. the history ring accumulates, truncates at HISTORY_MAX, and the REAL
//   poller feeds it from the fake adapter's own samples)
//   (…7/08: 16. status feed — normalization goldens (statuspage + generic +
//   junk->unknown), enabled-only polling, unreachable->unknown+backoff,
//   hidden-pause, and the APP flow: a fixture OUTAGE relabels a failing
//   tile "provider outage" through the real renderer, arms the ONE-glyph
//   icon overlay + tile chip, and disarms on recovery)
//   (…7/09: 17. plans × profiles — the fan-out reads every profile lane
//   (3 profiles -> 3 tiles, service-level); the threshold engine single-fires
//   per (provider, profile, window-epoch) with the 7/02 verdict line
//   VERBATIM, re-arms across a simulated reset, spends both levels on one
//   jump, persists spent state in the KV, and arms the failover suggestion
//   ONLY for the active lane with an idle sibling)
export function runUsageSmoke(win: BrowserWindow): void {
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
        snap.length === 11 &&
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
        profileIds.has('spend') &&
        // credit fixture carries a balance; multi-lane carries three windows;
        // the 7/07 spend fixture carries a current-window spend
        !!snap.find((p) => p.profileId === 'credits')?.credits &&
        snap.find((p) => p.profileId === 'multi-lane')?.windows.length === 3 &&
        snap.find((p) => p.profileId === 'spend')?.spend?.amount === 12.34 &&
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
      // Wait for the fetch count to STABILIZE before opening the observation
      // window — a slow/contended runner can land an in-flight poll well after a
      // fixed drain, corrupting h0 (the documented poller-pause flake). Once the
      // count stops moving, the pause has taken; then confirm it stays put.
      let drainPrev = -1
      for (let i = 0; i < 20; i++) {
        const c = svc.debug().providers.fake.fetches
        if (c === drainPrev) break
        drainPrev = c
        await sleep(300)
      }
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
        // 7/08 guardrail: a statusUrl is a PLAIN https endpoint — never auth,
        // never a query that could smuggle a key.
        if (def.statusUrl && (!def.statusUrl.startsWith('https://') || def.statusUrl.includes('?')))
          catalogFails.push(`${def.id}: statusUrl not a plain https endpoint`)
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

      // 13 ── the LOCAL cost scan (7/07): seeded JSONL fixtures in the two
      //       dev-verified log shapes sum EXACTLY; zero network by construction.
      //       Timestamps are LOCAL-midday so day bucketing is TZ-proof.
      const midday = (daysAgo: number): string => {
        const d = new Date(Date.now() - daysAgo * 86_400_000)
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).toISOString()
      }
      const croot = mkdtempSync(join(tmpdir(), 'mog-cost-'))
      mkdirSync(join(croot, 'codex', '2026', '07'), { recursive: true })
      writeFileSync(
        join(croot, 'codex', '2026', '07', 'rollout-fixture.jsonl'),
        [
          JSON.stringify({ timestamp: midday(2), type: 'session_meta', payload: { cli_version: '0.133.0', cwd: 'C:\\work\\projA' } }),
          'not json — a malformed line is skipped, never thrown',
          JSON.stringify({ timestamp: midday(2), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 500, total_tokens: 1500 } } } }),
          JSON.stringify({ timestamp: midday(1), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2000, cached_input_tokens: 100, output_tokens: 1000, total_tokens: 3000 } } } })
        ].join('\n')
      )
      const cdxScan = scanCost('codex', join(croot, 'codex'))
      // cli 0.133 logs name no model -> priced at gpt-5 (the Codex default,
      // CodexBar's rule) and LABELED so: day0 (1000·1.25 + 500·10)/1e6,
      // day1 ((2000−100)·1.25 + 100·0.125 + 1000·10)/1e6.
      const codexScanOk =
        cdxScan.days.length === 2 &&
        cdxScan.days[0].tokens === 1500 &&
        cdxScan.days[1].tokens === 3000 &&
        Math.abs(cdxScan.days[0].spend - 0.00625) < 1e-6 &&
        Math.abs(cdxScan.days[1].spend - 0.0123875) < 1e-6 && // day spend rounds to 6 decimals

        /gpt-5 rates/.test(cdxScan.reason ?? '') &&
        cdxScan.models?.length === 1 &&
        cdxScan.models[0].model === 'gpt-5 (assumed)' &&
        // per-project cut: session_meta.cwd's basename carries both turns
        cdxScan.projects?.length === 1 &&
        cdxScan.projects[0].project === 'projA' &&
        cdxScan.projects[0].tokens === 4500
      // The incremental file cache: an untouched tree re-scans to the SAME
      // result (served from the per-file contributions, not a re-parse)…
      const cdxAgain = scanCost('codex', join(croot, 'codex'))
      const cacheStableOk = JSON.stringify(cdxAgain) === JSON.stringify(cdxScan)
      // …and a LIVE price row (models.dev shape, passed as data) outranks the
      // built-ins AND busts the cache via pricesRev: day0 = (1000·2.5 + 500·20)/1e6.
      const cdxLive = scanCost('codex', join(croot, 'codex'), { prices: [['gpt-5', { inPerMTok: 2.5, outPerMTok: 20 }]], pricesRev: 'live-test' })
      const livePriceOk = Math.abs((cdxLive.days[0]?.spend ?? 0) - 0.0125) < 1e-6
      // claude-shaped: streamed chunks DUPLICATE a requestId -> dedupe holds;
      // spend prices exactly off the table (opus 4.8 $5/$25, cache 0.1x/1.25x)
      mkdirSync(join(croot, 'claude', 'proj'), { recursive: true })
      const cu = { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 } }
      writeFileSync(
        join(croot, 'claude', 'proj', 'session-fixture.jsonl'),
        [
          JSON.stringify({ type: 'user', timestamp: midday(1) }),
          JSON.stringify({ type: 'assistant', requestId: 'req_1', timestamp: midday(1), message: { model: 'claude-opus-4-8', usage: cu } }),
          JSON.stringify({ type: 'assistant', requestId: 'req_1', timestamp: midday(1), message: { model: 'claude-opus-4-8', usage: cu } }),
          JSON.stringify({ type: 'assistant', requestId: 'req_2', timestamp: midday(1), message: { model: 'claude-opus-4-8', usage: { input_tokens: 400, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
        ].join('\n')
      )
      const clScan = scanCost('claude', join(croot, 'claude'))
      // req_1 = (100·5 + 200·25 + 10000·0.5 + 1000·6.25)/1e6 = 0.01675; req_2 = 0.0045
      const clDay = clScan.days[0]
      const claudeScanOk =
        clScan.days.length === 1 && !!clDay && clDay.tokens === 11800 && Math.abs(clDay.spend - 0.02125) < 1e-9 && clScan.currency === 'USD' &&
        clScan.models?.length === 1 && clScan.models[0].model === 'claude-opus-4-8' && clScan.models[0].tokens === 11800
      // absent dir / unknown provider degrade LABELED — never a throw
      const missingScan = scanCost('codex', join(croot, 'nope'))
      const nullScan = scanCost('gemini', null)
      const costDegrades =
        missingScan.days.length === 0 && typeof missingScan.reason === 'string' && nullScan.days.length === 0 && typeof nullScan.reason === 'string'

      // 13b ── fork-aware deltas + the archived root (CodexBar parity). A forked
      // session's totals CONTINUE the parent's counters: the first token_count
      // must bill only its own turn (last_token_usage), later ones the total
      // DIFFERENCES — never the 6.2k cumulative. And archived_sessions counts.
      const croot2 = mkdtempSync(join(tmpdir(), 'mog-cost2-'))
      mkdirSync(join(croot2, 'sessions'), { recursive: true })
      mkdirSync(join(croot2, 'archived_sessions'), { recursive: true })
      const tc = (daysAgo: number, totals: Record<string, number> | null, last: Record<string, number>): string =>
        JSON.stringify({ timestamp: midday(daysAgo), type: 'event_msg', payload: { type: 'token_count', info: { ...(totals ? { total_token_usage: totals } : {}), last_token_usage: last } } })
      writeFileSync(
        join(croot2, 'sessions', 'fork.jsonl'),
        [
          JSON.stringify({ timestamp: midday(1), type: 'session_meta', payload: { model: 'gpt-5', forked_from_id: 'parent-1', cwd: 'C:\\w\\forky\\.mogging\\worktrees\\7466ee88' } }),
          tc(1, { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 1000, total_tokens: 6000 }, { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, total_tokens: 150 }),
          tc(1, { input_tokens: 5100, cached_input_tokens: 0, output_tokens: 1100, total_tokens: 6200 }, { input_tokens: 100, cached_input_tokens: 0, output_tokens: 100, total_tokens: 200 })
        ].join('\n')
      )
      writeFileSync(
        join(croot2, 'archived_sessions', 'old.jsonl'),
        [
          JSON.stringify({ timestamp: midday(3), type: 'session_meta', payload: { model: 'gpt-5' } }),
          tc(3, null, { input_tokens: 400, cached_input_tokens: 0, output_tokens: 100, total_tokens: 500 })
        ].join('\n')
      )
      const forkScan = scanCost('codex', [join(croot2, 'sessions'), join(croot2, 'archived_sessions')])
      const forkTok = forkScan.days.reduce((a, d) => a + d.tokens, 0)
      // fork day = 150 + 200 (total-diffs), archived day = 500; spend on the fork
      // day prices the DELTA components: (100·1.25+50·10 + 100·1.25+100·10)/1e6 = 0.00175.
      const forkDay = forkScan.days.find((d) => d.tokens === 350)
      const forkOk = forkTok === 850 && forkScan.days.length === 2 && !!forkDay && Math.abs(forkDay.spend - 0.00175) < 1e-6
      const archivedOk = forkScan.days.some((d) => d.tokens === 500)
      // ephemeral worktrees FOLD into their parent project — the slug never shows
      const worktreeFoldOk = forkScan.projects?.some((p) => p.project === 'forky') === true && !forkScan.projects?.some((p) => p.project === '7466ee88')

      // 13c ── byte-offset resume: a newline-terminated file that GROWS re-parses
      // only its tail (the carry-over model keeps pricing the appended turn) —
      // asserted by result equality: the rescan must equal head + tail exactly.
      const groot = mkdtempSync(join(tmpdir(), 'mog-cost3-'))
      mkdirSync(join(groot, 'sessions'), { recursive: true })
      const growFile = join(groot, 'sessions', 'grow.jsonl')
      writeFileSync(
        growFile,
        [
          JSON.stringify({ timestamp: midday(1), type: 'session_meta', payload: { model: 'gpt-5', cwd: 'C:\\w\\growproj' } }),
          tc(1, null, { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200, total_tokens: 1200 })
        ].join('\n') + '\n'
      )
      const growA = scanCost('codex', join(groot, 'sessions'))
      appendFileSync(growFile, tc(0, null, { input_tokens: 500, cached_input_tokens: 0, output_tokens: 300, total_tokens: 800 }) + '\n')
      const growB = scanCost('codex', join(groot, 'sessions'))
      const growTokA = growA.days.reduce((a, d) => a + d.tokens, 0)
      const growTokB = growB.days.reduce((a, d) => a + d.tokens, 0)
      const byteResumeOk =
        growTokA === 1200 && growTokB === 2000 && growB.days.length === 2 && growB.projects?.length === 1 && growB.projects[0].tokens === 2000

      // risk model sanity: mid-window at ~pace → a rounded, bounded estimate
      const rr = computePace({ label: 'Weekly', usedPct: 52, resetsAt: '2026-01-12T00:00:00Z' }, Date.parse('2026-01-08T12:00:00Z'), { windowMs: 604_800_000 })
      const riskOk = !!rr && typeof rr.runOutRiskPct === 'number' && rr.runOutRiskPct >= 5 && rr.runOutRiskPct <= 95 && rr.runOutRiskPct % 5 === 0
      const costOk = codexScanOk && claudeScanOk && costDegrades && cacheStableOk && livePriceOk && forkOk && archivedOk && worktreeFoldOk && byteResumeOk && riskOk

      // 14 ── the history ring (7/07): accumulate -> truncate at HISTORY_MAX,
      //       clamp junk, and the REAL poller has been ringing the fake
      //       provider's own samples since boot (counts only, 0..100).
      const kvStore = getSettingsStore()
      const hkv = { get: (k: string): string | null => kvStore?.getSetting(k) ?? null, set: (k: string, v: string): void => kvStore?.setSetting(k, v) }
      for (let i = 0; i < HISTORY_MAX + 7; i++) appendHistory(hkv, 'histtest', 'Session (5h)', i % 100)
      const series = readHistory(hkv, 'histtest', 'Session (5h)')
      const ringTruncOk = series.length === HISTORY_MAX && series[0] === 7 && series[series.length - 1] === (HISTORY_MAX + 6) % 100
      appendHistory(hkv, 'histtest', 'Clamp', 250)
      appendHistory(hkv, 'histtest', 'Clamp', -5)
      const clampSeries = readHistory(hkv, 'histtest', 'Clamp')
      const ringClampOk = clampSeries.length === 2 && clampSeries[0] === 100 && clampSeries[1] === 0
      const polled = readHistory(hkv, 'fake', 'Session (5h)')
      const ringPolledOk = polled.length > 0 && polled.length <= HISTORY_MAX && polled.every((n) => n >= 0 && n <= 100)
      const histOk = ringTruncOk && ringClampOk && ringPolledOk

      // 15 ── the 7/07 channels exist on the allowlist (cost/history are
      //       read-only render payloads; the no-getter regexes above stay clean)
      const costChannelsOk = AllChannels.includes('usage:cost') && AllChannels.includes('usage:history')

      // 16 ── provider status feed (7/08). (a) normalization goldens — pure,
      //       zero network: statuspage indicators, generic up/down, junk.
      const N = (b: string): string => normalizeStatusBody(b).state
      const statusNormOk =
        N(JSON.stringify({ status: { indicator: 'none', description: 'All Systems Operational' } })) === 'operational' &&
        N(JSON.stringify({ status: { indicator: 'minor', description: 'Partial System Degradation' } })) === 'degraded' &&
        N(JSON.stringify({ status: { indicator: 'major', description: 'Major outage' } })) === 'outage' &&
        N(JSON.stringify({ status: { indicator: 'critical' } })) === 'outage' &&
        N(JSON.stringify({ status: 'ok' })) === 'operational' &&
        N(JSON.stringify({ status: 'down' })) === 'outage' &&
        N(JSON.stringify({ ok: true })) === 'operational' &&
        N('<html>a status PAGE, not an API</html>') === 'unknown' &&
        N(JSON.stringify({ surprise: 1 })) === 'unknown' &&
        normalizeStatusBody(JSON.stringify({ status: { indicator: 'minor', description: 'Partially Degraded Service' } })).note === 'Partially Degraded Service'

      // (b) fixture service: ENABLED-only on one pass; unreachable -> unknown
      //     with polite backoff (the next pass SKIPS, no hammer); hidden pauses.
      const polledUrls: string[] = []
      let statusChanges = 0
      let fxThrow = false
      const fxStatus = createStatusService({
        providers: () => [{ id: 'alpha', statusUrl: 'fx://alpha' }, { id: 'beta', statusUrl: 'fx://beta' }, { id: 'gamma' }],
        isEnabled: (id) => id !== 'beta', // beta disabled; gamma declares no statusUrl
        fetcher: async (url) => {
          polledUrls.push(url)
          if (fxThrow) throw new Error('fixture: unreachable')
          return JSON.stringify({ status: { indicator: 'none' } })
        },
        onChange: () => statusChanges++,
        cadenceMsOverride: 120_000 // passes driven by hand below
      })
      await fxStatus.refresh()
      const enabledOnlyOk =
        polledUrls.join(',') === 'fx://alpha' &&
        fxStatus.list().length === 1 &&
        fxStatus.list()[0].providerId === 'alpha' &&
        fxStatus.list()[0].state === 'operational' &&
        statusChanges === 1
      fxThrow = true
      await fxStatus.refresh()
      const unknownAfterFail = fxStatus.list()[0]?.state === 'unknown' && statusChanges === 2
      await fxStatus.refresh() // inside alpha's backoff window -> fetch SKIPPED
      const backoffSkipOk = polledUrls.length === 2 && (fxStatus.debug().errors.alpha ?? 0) === 1
      fxStatus.stop()
      let hiddenPolls = 0
      const fxHidden = createStatusService({
        providers: () => [{ id: 'h', statusUrl: 'fx://h' }],
        isEnabled: () => true,
        fetcher: async () => {
          hiddenPolls++
          return JSON.stringify({ ok: true })
        },
        onChange: () => {},
        cadenceMsOverride: 120_000
      })
      await fxHidden.refresh()
      fxHidden.setVisible(false)
      await fxHidden.refresh()
      const statusHiddenOk = hiddenPolls === 1 && fxHidden.debug().visible === false
      fxHidden.setVisible(true)
      await fxHidden.refresh()
      const statusResumeOk = hiddenPolls === 2
      fxHidden.stop()
      const statusSvcOk = enabledOnlyOk && unknownAfterFail && backoffSkipOk && statusHiddenOk && statusResumeOk

      // (c) the APP flow, full renderer round-trip: fixture OUTAGE -> the
      //     failing tile relabels "provider outage" (pace muted), the icon
      //     overlay arms, the popover chip shows — then recovery disarms.
      const EJ = <T>(js: string): Promise<T> => win.webContents.executeJavaScript(js, true) as Promise<T>
      process.env.MOGGING_USAGE_STATUS = 'outage'
      const appStatus = getUsageStatusService()
      await appStatus?.refresh()
      const appOutageOk = !!appStatus
        ?.list()
        .find((s) => s.providerId === 'fake' && s.state === 'outage' && /Major Service Outage/.test(s.note ?? ''))
      setFakeMode('error')
      svc.refresh()
      let outageRelabeled = false
      tries = 0
      while (!outageRelabeled && tries++ < 60) {
        await sleep(200)
        const views = await EJ<{ health: string; reason?: string; pace?: unknown }[]>(`window.bridge.invoke('usage:list')`)
        outageRelabeled = views.some(
          (p) => (p.health === 'stale' || p.health === 'error') && /provider outage — Major Service Outage/.test(p.reason ?? '') && !p.pace
        )
      }
      let overlayOk = false
      tries = 0
      while (!overlayOk && tries++ < 40) {
        await sleep(200)
        overlayOk = await EJ<boolean>(`(() => { const i = document.querySelector('.usage-incident'); return !!i && i.hidden === false })()`)
      }
      await EJ(`(window.__mogging.usage && window.__mogging.usage.open(), 1)`)
      await sleep(300)
      const chipOk = await EJ<boolean>(`!!document.querySelector('.usage-tile .usage-status.is-outage')`)
      await EJ(`(window.__mogging.usage.close(), 1)`)
      process.env.MOGGING_USAGE_STATUS = 'operational'
      await appStatus?.refresh()
      setFakeMode('ok')
      svc.refresh()
      let overlayCleared = false
      tries = 0
      while (!overlayCleared && tries++ < 40) {
        await sleep(200)
        overlayCleared = await EJ<boolean>(`document.querySelector('.usage-incident').hidden === true`)
      }
      const statusAppOk = appOutageOk && outageRelabeled && overlayOk && chipOk && overlayCleared
      const statusChannelsOk = AllChannels.includes('usage:status') && AllChannels.includes('usage:statusChanged')

      // 17 ── plans × profiles (7/09). (a) the FAN-OUT: a perProfile adapter
      //       reads EVERY profile lane — three profiles, three plan tiles.
      const fanKv = new Map<string, string>()
      const fanProfiles = [
        { id: 'lane-a', name: 'Lane A', provider: 'fanout', env: {}, order: 0 },
        { id: 'lane-b', name: 'Lane B', provider: 'fanout', env: {}, order: 1 },
        { id: 'lane-c', name: 'Lane C', provider: 'fanout', env: {}, order: 2 }
      ]
      const fanSvc = createUsageService({
        adapters: [
          {
            id: 'fanout',
            perProfile: true,
            detect: async () => ({ ok: true }),
            fetch: async (_home, profileId) => [
              { providerId: 'fanout', profileId, planLabel: `Plan ${profileId}`, windows: [{ label: 'Session (5h)', usedPct: 10 }], fetchedAt: Date.now(), health: 'fresh' as const }
            ]
          }
        ],
        profiles: () => fanProfiles,
        kv: { get: (k) => fanKv.get(k) ?? null, set: (k, v) => void fanKv.set(k, v) },
        onChange: () => {},
        cadenceMsOverride: 600_000
      })
      fanSvc.refresh()
      tries = 0
      while (fanSvc.list().length < 3 && tries++ < 50) await sleep(100)
      const fanoutOk =
        fanSvc.list().length === 3 &&
        fanSvc
          .list()
          .map((p) => p.profileId)
          .sort()
          .join(',') === 'lane-a,lane-b,lane-c'
      fanSvc.stop()

      // (b) the threshold engine (phase-11 rebuild): EVERY window evaluates,
      //     prune-on-descent re-arms, boundaries compare with tolerance,
      //     credits floors + spend caps alert, failover judges worst-window.
      const tMem = new Map<string, string>()
      const tkv = { get: (k: string): string | null => tMem.get(k) ?? null, set: (k: string, v: string): void => void tMem.set(k, v) }
      const tProfiles = [
        { id: 'p0', name: 'Main', provider: 'prov', env: {}, order: 0 },
        { id: 'p1', name: 'Backup', provider: 'prov', env: {}, order: 1 }
      ]
      const tcfg = { quiet: 80, warn: 95, confetti: false }
      const E1 = new Date(Date.now() + 3_600_000).toISOString()
      const E2 = new Date(Date.now() + 7_200_000).toISOString()
      const EW = new Date(Date.now() + 3 * 86_400_000).toISOString()
      // The fixture is MULTI-WINDOW by construction — the audit found the old
      // single-window mk() made the windows[0]-only defect undetectable by
      // every threshold assert in this file.
      const mk = (profileId: string, pct: number, resetsAt: string, weeklyPct = 10): PlanUsageView => ({
        providerId: 'prov',
        profileId,
        planLabel: `Prov (${profileId})`,
        windows: [
          { label: 'Session (5h)', usedPct: pct, resetsAt, windowMs: 5 * 3_600_000 },
          { label: 'Weekly', usedPct: weeklyPct, resetsAt: EW, windowMs: 7 * 86_400_000 }
        ],
        fetchedAt: Date.now(),
        health: 'fresh'
      })
      // first sight below every threshold arms silently
      const armedSilently = evaluateThresholds([mk('p0', 50, E1)], tcfg, tProfiles, tkv).length === 0
      // quiet fires ONCE; the body is the 7/02 formatter line VERBATIM and the
      // title names the READING (a user at 85% is not told "80% used")
      const paceReport = computePace({ label: 'Session (5h)', usedPct: 85, resetsAt: E1, windowMs: 5 * 3_600_000 }, Date.now(), { windowMs: 5 * 3_600_000 })
      const verdictLine = paceReport ? formatVerdict(paceReport, 'Session (5h)') : ''
      const mkQuiet = mk('p0', 85, E1)
      const quietView: PlanUsageView = paceReport
        ? { ...mkQuiet, windows: [{ ...mkQuiet.windows[0], pace: { verdict: paceReport.verdict, text: verdictLine, deltaText: '+5%', severity: 'warning' } }, mkQuiet.windows[1]] }
        : mkQuiet
      const expectQuietBody = paceReport ? verdictLine : '85% of Session (5h) used'
      const q1 = evaluateThresholds([quietView], tcfg, tProfiles, tkv)
      const quietFiredOk =
        q1.length === 1 && q1[0].kind === 'threshold' && q1[0].level === 'quiet' && q1[0].body === expectQuietBody && q1[0].title === 'Prov (p0) — 85% of Session (5h) used'
      const singleFireOk = evaluateThresholds([quietView], tcfg, tProfiles, tkv).length === 0
      // THE WEEKLY LANE ALERTS (the audit's headline defect): a cool session
      // with a hot weekly fires on the weekly, labeled as the weekly.
      const kvW = new Map<string, string>()
      const wv = evaluateThresholds([mk('p0', 20, E1, 93)], tcfg, tProfiles, { get: (k) => kvW.get(k) ?? null, set: (k, v) => void kvW.set(k, v) })
      const weeklyFiredOk = wv.length === 1 && wv[0].windowLabel === 'Weekly' && wv[0].title === 'Prov (p0) — 93% of Weekly used'
      // an EXPIRED session lane mutes only itself — the weekly still speaks
      const kvX = new Map<string, string>()
      const EPAST = new Date(Date.now() - 60_000).toISOString()
      const xv = evaluateThresholds([mk('p0', 99, EPAST, 93)], tcfg, tProfiles, { get: (k) => kvX.get(k) ?? null, set: (k, v) => void kvX.set(k, v) })
      const expiredLaneScopedOk = xv.length === 1 && xv[0].windowLabel === 'Weekly'
      // warn on the ACTIVE lane + an idle sibling -> the failover suggestion
      const w1 = evaluateThresholds([mk('p0', 96, E1), mk('p1', 10, E1)], tcfg, tProfiles, tkv)
      const warnFailoverOk = w1.length === 1 && w1[0].level === 'warn' && w1[0].failover?.profileId === 'p1' && w1[0].failover?.profileName === 'Backup'
      const warnOnceOk = evaluateThresholds([mk('p0', 96, E1), mk('p1', 10, E1)], tcfg, tProfiles, tkv).length === 0
      // a NON-active lane crossing warn never suggests a switch
      const kvB = new Map<string, string>()
      const n1 = evaluateThresholds([mk('p1', 96, E1), mk('p0', 10, E1)], tcfg, tProfiles, { get: (k) => kvB.get(k) ?? null, set: (k, v) => void kvB.set(k, v) })
      const nonActiveNoSuggest = n1.length === 1 && n1[0].level === 'warn' && !n1[0].failover
      // a sibling is judged on its WORST window: session 10% but weekly 60%
      // blocks the suggestion (the old rule offered exhausted accounts)
      const kvC = new Map<string, string>()
      const hot1 = evaluateThresholds([mk('p0', 96, E1), mk('p1', 10, E1, 60)], tcfg, tProfiles, { get: (k) => kvC.get(k) ?? null, set: (k, v) => void kvC.set(k, v) })
      const siblingHotNoSuggest = hot1.length === 1 && hot1[0].level === 'warn' && !hot1[0].failover
      // a 0->97 jump costs ONE toast (both levels spent)
      const kvD = new Map<string, string>()
      const dkv = { get: (k: string): string | null => kvD.get(k) ?? null, set: (k: string, v: string): void => void kvD.set(k, v) }
      const j1 = evaluateThresholds([mk('p0', 97, E1)], tcfg, tProfiles, dkv)
      const j2 = evaluateThresholds([mk('p0', 85, E1)], tcfg, tProfiles, dkv)
      const oneToastPerJump = j1.length === 1 && j1[0].level === 'warn' && j2.length === 0
      // RESETS_AT CHURN (the audit's live Claude bug): the same window served
      // with a drifting boundary (<2min) must not re-arm, reset-toast, or
      // re-fire — ever. A drift is the SAME window.
      const churn1 = evaluateThresholds([mk('p0', 85, new Date(Date.parse(E1) + 30_000).toISOString())], tcfg, tProfiles, tkv)
      const churn2 = evaluateThresholds([mk('p0', 85, new Date(Date.parse(E1) + 90_000).toISOString())], tcfg, tProfiles, tkv)
      const churnQuietOk = churn1.length === 0 && churn2.length === 0
      // reset: the boundary ADVANCES past tolerance on a lane the user was
      // warned about -> ONE "fresh window", then quiet, then re-armable
      const r1 = evaluateThresholds([mk('p0', 5, E2)], tcfg, tProfiles, tkv)
      const r2 = evaluateThresholds([mk('p0', 5, E2)], tcfg, tProfiles, tkv)
      const q2 = evaluateThresholds([mk('p0', 85, E2)], tcfg, tProfiles, tkv)
      const resetRearmOk = r1.length === 1 && r1[0].kind === 'reset' && r1[0].windowLabel === 'Session (5h)' && r2.length === 0 && q2.length === 1 && q2[0].level === 'quiet'
      // a REGRESSED boundary is a stale sample: the lane says nothing and
      // keeps its state (Codex serves old rollouts after a quit)
      const stale1 = evaluateThresholds([mk('p0', 99, E1)], tcfg, tProfiles, tkv)
      const staleRegressOk = stale1.length === 0
      // restart safety is the KV itself: the spent state survives as app state
      const thrPersistOk = (tMem.get('usage.thr.prov.p0') ?? '').includes(E2)
      // PRUNE-ON-DESCENT re-arms a STATIC lane (no resetsAt — rolling credit
      // windows): 96 fires, 40 prunes, 96 fires AGAIN. The old epoch:'static'
      // fired once per install, permanently.
      const sMem = new Map<string, string>()
      const skv = { get: (k: string): string | null => sMem.get(k) ?? null, set: (k: string, v: string): void => void sMem.set(k, v) }
      const mkStatic = (pct: number): PlanUsageView => ({
        providerId: 'prov',
        profileId: 'p0',
        planLabel: 'Prov (p0)',
        windows: [{ label: 'Credits', usedPct: pct, windowMs: 0 }],
        fetchedAt: Date.now(),
        health: 'fresh'
      })
      const s1 = evaluateThresholds([mkStatic(96)], tcfg, tProfiles, skv)
      const s2 = evaluateThresholds([mkStatic(40)], tcfg, tProfiles, skv)
      const s3 = evaluateThresholds([mkStatic(96)], tcfg, tProfiles, skv)
      const staticRearmOk = s1.length === 1 && s1[0].level === 'warn' && s2.length === 0 && s3.length === 1 && s3[0].level === 'warn'
      // the CREDITS FLOOR: a denominator-free balance alerts at the user's
      // number, once, and re-arms only after a real top-up
      const cMem = new Map<string, string>()
      const ckv = { get: (k: string): string | null => cMem.get(k) ?? null, set: (k: string, v: string): void => void cMem.set(k, v) }
      const mkCredits = (remaining: number): PlanUsageView => ({
        providerId: 'prov',
        profileId: 'p0',
        planLabel: 'Prov (p0)',
        windows: [],
        credits: { label: 'USD', remaining },
        fetchedAt: Date.now(),
        health: 'fresh'
      })
      const fcfg = { ...tcfg, floors: { prov: 5 } }
      const c1 = evaluateThresholds([mkCredits(3)], fcfg, tProfiles, ckv)
      const c2 = evaluateThresholds([mkCredits(3)], fcfg, tProfiles, ckv)
      const c3 = evaluateThresholds([mkCredits(10)], fcfg, tProfiles, ckv) // top-up re-arms silently
      const c4 = evaluateThresholds([mkCredits(4)], fcfg, tProfiles, ckv)
      const creditsFloorOk = c1.length === 1 && /3 USD left/.test(c1[0].title) && c2.length === 0 && c3.length === 0 && c4.length === 1
      // the SPEND CAP: dollars against a limit alert like a window, named in money
      const spMem = new Map<string, string>()
      const spkv = { get: (k: string): string | null => spMem.get(k) ?? null, set: (k: string, v: string): void => void spMem.set(k, v) }
      const mkSpend = (amount: number): PlanUsageView => ({
        providerId: 'prov',
        profileId: 'p0',
        planLabel: 'Prov (p0)',
        windows: [],
        spend: { amount, currency: 'USD', limit: 200 },
        fetchedAt: Date.now(),
        health: 'fresh'
      })
      const sp1 = evaluateThresholds([mkSpend(190)], tcfg, tProfiles, spkv)
      const sp2 = evaluateThresholds([mkSpend(190)], tcfg, tProfiles, spkv)
      const spendCapOk = sp1.length === 1 && sp1[0].level === 'warn' && /\$190\.00 of \$200\.00/.test(sp1[0].title) && sp2.length === 0
      // PROFILE FLIP: login auto-discovery renames 'default' -> 'login-<id>';
      // the new lane ADOPTS the old state instead of re-firing everything
      const aMem = new Map<string, string>()
      const akv = { get: (k: string): string | null => aMem.get(k) ?? null, set: (k: string, v: string): void => void aMem.set(k, v) }
      const mkLane = (profileId: string): PlanUsageView => ({ ...mk(profileId, 85, E1), profileId })
      const a1 = evaluateThresholds([mkLane('default')], tcfg, tProfiles, akv)
      const a2 = evaluateThresholds([mkLane('login-prov')], tcfg, tProfiles, akv)
      const profileFlipAdoptsOk = a1.length === 1 && a2.length === 0
      // the PREDICTIVE tap: a runs-out projection UNDER the warn pct fires once
      // per window (the verdict line verbatim as the body), then stays quiet.
      const pMem = new Map<string, string>()
      const pkv = { get: (k: string): string | null => pMem.get(k) ?? null, set: (k: string, v: string): void => void pMem.set(k, v) }
      const mkPace = mk('p0', 60, E1)
      const paceView: PlanUsageView = {
        ...mkPace,
        windows: [{ ...mkPace.windows[0], pace: { verdict: 'runs-out', text: 'Ahead of pace — runs out ~Tue 12:00 at this rate', deltaText: '+20%', severity: 'warning' } }, mkPace.windows[1]]
      }
      // A forecast is not a missed crossing: it fires on FIRST sight (unlike
      // the pct arms-silently rule), then never again for this window.
      const pa1 = evaluateThresholds([paceView], tcfg, tProfiles, pkv)
      const pa2 = evaluateThresholds([paceView], tcfg, tProfiles, pkv)
      const paceAlertOk = pa1.length === 1 && pa1[0].kind === 'pace' && /runs out/.test(pa1[0].body) && pa2.length === 0
      const thrOk =
        armedSilently && quietFiredOk && singleFireOk && weeklyFiredOk && expiredLaneScopedOk && warnFailoverOk && warnOnceOk && nonActiveNoSuggest && siblingHotNoSuggest && oneToastPerJump && churnQuietOk && resetRearmOk && staleRegressOk && thrPersistOk && staticRearmOk && creditsFloorOk && spendCapOk && profileFlipAdoptsOk && paceAlertOk
      const alertChannelsOk =
        AllChannels.includes('usage:alert') &&
        AllChannels.includes('usage:alertDrain') &&
        AllChannels.includes('usage:alertAck') &&
        AllChannels.includes('usage:alertCfgGet') &&
        AllChannels.includes('usage:alertCfgSet')

      const pass =
        shapeOk && cadenceOk && staleOk && backoffOk && hiddenOk && resumeOk && grepClean && goldenOk && catalogOk && codexOk && codexDegrades && keysOk && noGetterOk && specsOk && cloudOk && costOk && histOk && costChannelsOk && statusNormOk && statusSvcOk && statusAppOk && statusChannelsOk && fanoutOk && thrOk && alertChannelsOk
      result = { pass, shapeOk, cadenceOk, staleOk, backoffOk, hiddenOk, resumeOk, grepClean, goldenOk, goldenFails, catalogOk, catalogFails, codexOk, codexDegrades, vaultAvailable, keysOk, cipherOk, dbBytesOk, roundtripOk, replaceOk, clearOk, refusalOk, envRefOk, envLiteralRefusedOk, noGetterOk, specsOk, cloudOk, costOk, codexScanOk, claudeScanOk, costDegrades, cacheStableOk, livePriceOk, forkOk, archivedOk, worktreeFoldOk, byteResumeOk, riskOk, paceAlertOk, histOk, ringTruncOk, ringClampOk, ringPolledOk, costChannelsOk, statusNormOk, statusSvcOk, enabledOnlyOk, unknownAfterFail, backoffSkipOk, statusHiddenOk, statusResumeOk, statusAppOk, appOutageOk, outageRelabeled, overlayOk, chipOk, overlayCleared, statusChannelsOk, fanoutOk, thrOk, armedSilently, quietFiredOk, singleFireOk, weeklyFiredOk, expiredLaneScopedOk, warnFailoverOk, warnOnceOk, nonActiveNoSuggest, siblingHotNoSuggest, oneToastPerJump, churnQuietOk, resetRearmOk, staleRegressOk, thrPersistOk, staticRearmOk, creditsFloorOk, spendCapOk, profileFlipAdoptsOk, alertChannelsOk, providers: USAGE_PROVIDERS.length, goldens: PACE_GOLDENS.length, tiles: snap.length, debug: svc.debug() }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  void run()
}
