import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEntitlements } from '@backend'
import { FREE_ENTITLEMENTS } from '@contracts'
import { FakeIdp } from '@backend/features/account/fake-idp'
import { FakeEntitleIssuer } from '@backend/features/account/fake-entitle'
import { deleteDeviceKey, probeDeviceKey } from '@backend/platform/device-key'
import { setDeviceKeyNameForSmoke } from '@backend/platform/dpop-key'
import {
  accountStatus,
  dpopCustodyForSmoke,
  dpopJktForSmoke,
  dropDpopKeyMemoryForSmoke,
  login,
  logout,
  resetAccountForSmoke,
  setAccountConfigForSmoke,
  setBrowserOpenerForSmoke,
  whenSettledForSmoke
} from '../account'
import { vaultClearKey } from '../vault'
import {
  cachedDeviceIdForSmoke,
  dropMemoryCacheForSmoke,
  ensureDeviceJktForSmoke,
  refreshEntitlements,
  resetEntitlementsForSmoke,
  setEntitleClockForSmoke,
  setEntitleConfigForSmoke
} from '../entitlements'
import { canonicalTamperManifestForSmoke, configureTamperCheckForSmoke, runTamperSelfCheck } from '../native-preflight'
import { remoteQuotaRefusal } from '../remotes'
import { getSettingsStore } from '../app-settings'
import { getCliRuntime } from '../cli-runtime'
import { helperRuntime } from '../node-helper'
import { softFps, softGapMs } from './smoke-shell'
import { sleep, waitUntil, writeResult } from './kit'

// Env-gated PRODUCT MILESTONE for the paid tier (MOGGING_PRODMILESTONE,
// phase-accounts/10) — THE authority on "phase-accounts done". ONE composed run, on
// FAKE services only (FAKE IdP + FAKE MoR/entitlement issuer + fixture integrity
// manifest; every server is an in-process 127.0.0.1 loopback — zero external network,
// zero vendor CLIs, by construction), proving the WHOLE promise in journey order:
//
//   A0  the anon FREE app opens OFFLINE — no account, no config, nothing to talk to —
//       and the scriptable wedge works: `mogging list`, `send`, `capture` against the
//       live daemon through the standalone helper (ADR 0017), account-less;
//   A1  login: OAuth 2.1 Authorization Code + PKCE against the FAKE IdP, DPoP-bound to
//       the device key (REAL platform key store under SMOKE-NAMED keys when the machine
//       has one — deleted at teardown; the honest software fallback otherwise, and the
//       verdict says which world it proved). Authed ≠ paid: the plan badge stays Free;
//   A2  subscribe: a FAKE MoR webhook (HMAC-signed; a FORGED one is refused and flips
//       nothing) activates the subscription SERVER-side → the next refresh lands a
//       device-bound, watermarked Pro entitlement → a previously-capped feature
//       (saved SSH hosts at the Free cap) unlocks;
//   A3  pull the network (the issuer stops): Pro HOLDS through the grace window — and
//       the session survives the outage too (unreachable ≠ rejected) — then past the
//       window the app degrades to Free, quietly; the CLI and the renderer never brick;
//   A4  the copied install: the same vault presented as a DIFFERENT device reads Free
//       the moment the device is known, and CANNOT re-license — the AS rejects the
//       foreign-key proof, no new grant is minted, the cache is not overwritten;
//   A5  tamper: a modified unpacked shim flips the self-check → PAID is withheld while
//       the FREE app keeps running (`mogging list` under the flag); fixing it restores
//       Pro — a revocation trigger, not a brick;
//   A6  logout returns the machine to anon-FREE in one gesture (the cached entitlement
//       goes with the session), and the free wedge still works, untouched;
//   B   both budgets ON the composed surface: 16 panes + the account/entitlement
//       machinery live, write torrent + workspace switches — worst gap ≤ 150ms,
//       avg fps ≥ 30, heap ≤ 300MB (I7: nothing here bought perf).
//
// The Settings › Account panel is asserted along the way (authed email, the Pro badge,
// the ONE quiet degradation line) so the renderer's story and the engine's cannot
// drift. Verdict: out/prodmilestone-result.json — claims and booleans only; no token,
// no JWT, no thumbprint ever lands in it.

const BUDGET = { maxFrameGapMs: softGapMs(150), minAvgFps: softFps(30), maxHeapMB: 300 }
const ACCOUNT_ID = 'acct_prodmilestone_01'
const WEDGE_MARK = 'PRODM_WEDGE_4242'

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export function runProdMilestoneSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 400000) // safety net
  const wc = win.webContents
  wc.setBackgroundThrottling(false)
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>

  // Every `mogging` verb runs the shipped way: the standalone helper hosting the CLI
  // entry (ADR 0017) — no ELECTRON_RUN_AS_NODE anywhere in this smoke.
  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> =>
    new Promise((resolveCli) => {
      execFile(
        helperRuntime().executable,
        [getCliRuntime().cliEntry, ...args],
        { env: { ...process.env, ...extraEnv }, timeout: 20000, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? ((err as unknown as { code?: number }).code ?? 1) : 0
          resolveCli({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) })
        }
      )
    })

  /** The Settings › Account panel, read off the live DOM (opens Settings, reads, backs
   *  out) — the renderer's claims-only mirror, asserted against the engine's truth. */
  const panelState = async (): Promise<{ status: string; badge: string; reason: string; noteHidden: boolean }> => {
    await ES(`document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click()`)
    await sleep(350)
    await ES(`window.__mogging.settingsTab('account')`)
    await sleep(450)
    const state = (await ES(`(() => {
      const note = document.querySelector('.account-note')
      return {
        status: document.querySelector('.account-status')?.textContent ?? '',
        badge: document.querySelector('.plan-badge')?.textContent ?? '',
        reason: note?.dataset.reason ?? '',
        noteHidden: !note || note.hidden
      }
    })()`)) as { status: string; badge: string; reason: string; noteHidden: boolean }
    await ES(`document.querySelector('.settings-back')?.click()`)
    await sleep(300)
    return state
  }

  const run = async (): Promise<void> => {
    let result: { pass: boolean } & Record<string, unknown> = { pass: false }
    const NAME_A = `MoggingSmoke.prodm.A.${process.pid}`
    const NAME_B = `MoggingSmoke.prodm.B.${process.pid}`
    const idp = new FakeIdp({ email: 'founder@mogginglabs.example', plan: 'free', accessTtlSec: 3600 })
    let issuer: FakeEntitleIssuer | null = null
    let nativeLeg = false
    let tmp = ''
    const savedRemotes: string[] = []
    try {
      tmp = mkdtempSync(join(tmpdir(), 'mogging-prodm-'))
      resetAccountForSmoke()
      resetEntitlementsForSmoke()

      // ── A0. Anon, free, OFFLINE: no account, no config, and the wedge works ──────
      const anonAtBoot = accountStatus().state === 'anon'
      const snapBoot = getEntitlements().snapshot()
      const freeAtBoot = snapBoot.plan === 'free' && snapBoot.reason === undefined
      // Nothing is wired: login cannot even start, a refresh has nothing to talk to.
      const unwiredHonest = (await login()).ok === false && (await refreshEntitlements()) === false

      await ES(
        '(function(){var m=window.__mogging;' +
          'if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Wedge"});return 1;})()'
      )
      await sleep(4000)
      const base = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100
      const pane1 = base + 1
      const list0 = await cli(['list'])
      const sent = await cli(['send', String(pane1), `echo ${WEDGE_MARK}`])
      let captured = ''
      const captureOk = await waitUntil(async () => {
        const cap = await cli(['capture', String(pane1), '--lines', '30'])
        captured = cap.stdout
        return cap.code === 0 && captured.includes(WEDGE_MARK)
      }, 25000, 800)
      const cliWedgeAnon = list0.code === 0 && /^\d+\s+\d+x\d+/m.test(list0.stdout) && sent.code === 0 && captureOk

      // ── A1. Login: PKCE against the FAKE IdP, DPoP-bound to the device key ───────
      // REAL platform key store when the machine offers one, under smoke-named keys the
      // teardown deletes — the machine's true device identity is never touched.
      const probe = await probeDeviceKey()
      nativeLeg = probe.backend !== 'none'
      setDeviceKeyNameForSmoke(NAME_A)
      await idp.start()
      const wireAccount = (): void => {
        setAccountConfigForSmoke({
          metadata: idp.metadata,
          clientId: idp.clientId,
          resource: 'https://entitlements.mogginglabs.example',
          scopes: ['openid', 'email', 'entitlements']
        })
        setBrowserOpenerForSmoke(async (url) => {
          const { redirectTo } = await idp.consent(url)
          await fetch(redirectTo)
        })
      }
      wireAccount()
      await login()
      const afterLogin = (await whenSettledForSmoke()) ?? accountStatus()
      const jktA = (await dpopJktForSmoke()) ?? ''
      // Which custody the login actually landed on: a probed key store can still refuse
      // persistence (an unsigned macOS dev run, a SEP-less VM) — the fallback world runs
      // then, honestly, and the verdict says so.
      const custody = await dpopCustodyForSmoke()
      const deviceLeg = custody !== null && custody.backend !== 'software'
      const authed = afterLogin.state === 'authed' && afterLogin.email === 'founder@mogginglabs.example'
      // Authed is NOT paid: the panel shows the session, and the badge still says Free.
      const panelAuthed = await panelState()
      const authedNotPaid = authed && panelAuthed.status === 'founder@mogginglabs.example' && panelAuthed.badge === 'Free'

      // ── A2. Subscribe: the FAKE MoR webhook flips the plan SERVER-side ───────────
      const clock = { t: Date.now() }
      const nowFn = (): number => clock.t
      const MOR_SECRET = 'mor-fixture-secret-4242'
      issuer = new FakeEntitleIssuer({
        accountId: ACCOUNT_ID,
        morWebhookSecret: MOR_SECRET,
        proLimits: { maxPanes: 16, maxConnections: 25, maxSwarmRoles: 16, maxRemotes: 25 },
        ttlSec: 48 * 3600,
        clock: nowFn
      })
      await issuer.start()
      setEntitleClockForSmoke(nowFn)
      setEntitleConfigForSmoke({ baseUrl: issuer.baseUrl, verifyKeyPem: issuer.publicKeyPem })

      // Before any webhook: the server says free, so the client fetches free.
      const preFetch = await refreshEntitlements()
      const preWebhookFree = preFetch === true && getEntitlements().snapshot().plan === 'free'

      // The previously-capped feature, AT the Free cap: the 11th saved host is refused
      // with the visible upgrade reason.
      const store = getSettingsStore()
      for (let i = 1; i <= FREE_ENTITLEMENTS.limits.maxRemotes; i++) {
        const id = `h-prodm-${i}`
        store?.saveRemote({ id, name: `box${i}`, host: `box${i}.example` })
        savedRemotes.push(id)
      }
      const refusal = remoteQuotaRefusal('h-prodm-11')
      const cappedBeforePro = typeof refusal === 'string' && /free plan/i.test(refusal) && /upgrade/i.test(refusal)

      // The MoR contract's signature: the Stripe shape — t inside the signed bytes.
      const signHook = (raw: string): string => {
        const t = Math.floor(nowFn() / 1000)
        return `t=${t},v1=${createHmac('sha256', MOR_SECRET).update(`${t}.${raw}`).digest('hex')}`
      }

      // A FORGED webhook (wrong signature) is refused and flips nothing.
      const forgedBody = JSON.stringify({ id: 'evt_forged_1', type: 'subscription.activated', accountId: ACCOUNT_ID })
      const forged = await fetch(`${issuer.baseUrl}/mor/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mor-signature': 'deadbeef' },
        body: forgedBody
      })
      await refreshEntitlements()
      const forgedWebhookRefused = forged.status === 401 && issuer.webhookRefusals === 1 && getEntitlements().snapshot().plan === 'free'

      // The REAL webhook: timestamped HMAC over the raw body, exactly the MoR contract.
      const body = JSON.stringify({ id: 'evt_fixture_1', type: 'subscription.activated', accountId: ACCOUNT_ID, plan: 'pro' })
      const hookSig = signHook(body)
      const okHook = await fetch(`${issuer.baseUrl}/mor/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mor-signature': hookSig },
        body
      })
      // The SAME delivery again (a captured request replayed, or a MoR redelivery):
      // acked 200 — never an error, or retries pile up — and it flips NOTHING twice.
      const replayed = await fetch(`${issuer.baseUrl}/mor/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mor-signature': hookSig },
        body
      })
      const replayIgnored = replayed.status === 200 && issuer.webhookReplays === 1 && issuer.webhookDeliveries === 1
      const fetchedPro = await refreshEntitlements()
      const snapPro = getEntitlements().snapshot()
      const subscribedPro =
        okHook.status === 200 && issuer.webhookDeliveries === 1 && fetchedPro && snapPro.plan === 'pro' && snapPro.graceState === 'fresh'
      // Device-bound (attested to OUR key) + watermarked (the activation names its account).
      const deviceBound = cachedDeviceIdForSmoke() === jktA && issuer.lastProofJkt === jktA
      const authnRode = issuer.lastAuthOk === true && issuer.lastAthOk === true && issuer.nonceChallenges >= 1
      // Pro unlocks the previously-capped feature: the same 11th host now passes.
      const proUnlocksCapped = remoteQuotaRefusal('h-prodm-11') === null
      const panelPro = await panelState()
      const panelShowsPro = panelPro.badge === 'Pro' && panelPro.noteHidden

      // ── A3. Pull the network: grace holds, then Free — and nothing bricks ────────
      const t0 = nowFn()
      await issuer.stop() // the entitlement service is GONE; the IdP stays (A4 needs a live AS to refuse)
      clock.t = t0 + 60 * 3_600_000 // past the 48h exp, inside the 14d window
      const offlineRefresh = await refreshEntitlements() // fails, changes nothing
      const snapGrace = getEntitlements().snapshot()
      const graceHolds = offlineRefresh === false && snapGrace.plan === 'pro' && snapGrace.graceState === 'grace'
      const panelGrace = await panelState()
      const panelGraceLine = panelGrace.reason === 'grace' && !panelGrace.noteHidden && panelGrace.badge === 'Pro'

      clock.t = t0 + 15 * 86_400_000 // past the window
      const snapExpired = getEntitlements().snapshot()
      const stillOffline = await refreshEntitlements()
      const listOffline = await cli(['list'])
      const rendererAlive = (await ES<string>(`document.getElementById('root') ? 'alive' : 'gone'`)) === 'alive'
      const degradesNeverBricks =
        stillOffline === false &&
        snapExpired.plan === 'free' &&
        snapExpired.graceState === 'expired' &&
        snapExpired.reason === 'grace_expired' &&
        listOffline.code === 0 &&
        rendererAlive
      // The outage did NOT end the session (unreachable ≠ rejected): the paying user
      // comes back online still signed in, like they kept their grace-window plan.
      const offlineKeepsSession = accountStatus().state === 'authed'

      // ── A4. The copied install: same vault, DIFFERENT device — inert ─────────────
      clock.t = t0 + 3_600_000 // back inside the claim's own validity: on device A this
      // cache would be honored again — which is exactly what makes B's refusal a
      // DEVICE story, not an expiry story.
      let foreignDeviceFree = true
      if (deviceLeg) {
        setDeviceKeyNameForSmoke(NAME_B)
        dropDpopKeyMemoryForSmoke()
        dropMemoryCacheForSmoke()
        const deviceB = await ensureDeviceJktForSmoke()
        const snapB = getEntitlements().snapshot()
        foreignDeviceFree =
          deviceB !== null && deviceB !== jktA && snapB.plan === 'free' && snapB.reason === 'device_mismatch' && cachedDeviceIdForSmoke() === jktA
      } else {
        // Software custody: NOTHING in the vault decrypts off-machine — the copy has no
        // key and no cached claim either (safeStorage is machine-bound; DEVICEKEY owns
        // that per-OS law). Model the WHOLE loss: clearing only the key left the cached
        // claim readable with no device identity to judge it against, and the engine's
        // honest provisional honor read as a gate failure — a state no real foreign
        // machine can reach (first linux/mac contact, run 29547052949). The refresh
        // token deliberately stays, so the no-key path proves the unusable-grant law:
        // a clean drop to anon, never a re-license.
        vaultClearKey('account.dpopKey')
        vaultClearKey('entitlements.cache')
        dropDpopKeyMemoryForSmoke()
        dropMemoryCacheForSmoke()
      }
      // No re-license, against a LIVE AS: the refresh proof signs with the wrong (or no)
      // key, the AS refuses, no grant is minted, the cache is not overwritten.
      const issuedBefore = idp.issuedRefresh.length
      const relicense = await refreshEntitlements()
      const noRelicense =
        relicense === false &&
        idp.issuedRefresh.length === issuedBefore &&
        getEntitlements().snapshot().plan === 'free' &&
        accountStatus().state === 'anon' &&
        // Hardware custody: the cache RIDES ALONG inert (the device-mismatch story
        // reads it). Software custody: the cache was vault ciphertext, so the foreign
        // machine holds nothing — absent is that custody's honest shape.
        (deviceLeg ? cachedDeviceIdForSmoke() === jktA : cachedDeviceIdForSmoke() === null)

      // ── A5. Back on device A, re-licensed — then a TAMPERED build ────────────────
      setDeviceKeyNameForSmoke(NAME_A)
      dropDpopKeyMemoryForSmoke()
      dropMemoryCacheForSmoke()
      wireAccount()
      await login()
      const reauthed = ((await whenSettledForSmoke()) ?? { state: 'anon' }).state === 'authed'
      await issuer.start() // the service returns (same signer, fresh port)
      setEntitleConfigForSmoke({ baseUrl: issuer.baseUrl, verifyKeyPem: issuer.publicKeyPem })
      clock.t = Date.now()
      const refetched = await refreshEntitlements()
      const backOnAPro = reauthed && refetched && getEntitlements().snapshot().plan === 'pro'

      // The runtime self-check on a fixture "unpacked bin/" + a SIGNED manifest
      // (operator key injected as a parameter — never the environment; ORIGINPIN).
      const binDir = join(tmp, 'bin')
      mkdirSync(binDir)
      const shim = join(binDir, 'mogging.mjs')
      writeFileSync(shim, '#!/usr/bin/env node\n// fixture shim\n')
      const manifest = { v: 1, files: { 'mogging.mjs': createHash('sha256').update(readFileSync(shim)).digest('hex') } }
      const pair = generateKeyPairSync('ed25519')
      const sig = sign(null, Buffer.from(canonicalTamperManifestForSmoke(manifest)), pair.privateKey)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      const manifestPath = join(tmp, 'integrity-manifest.json')
      writeFileSync(manifestPath, JSON.stringify({ manifest, sig }))
      configureTamperCheckForSmoke({
        manifestPath,
        verifyKeyPem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        baseDir: binDir
      })
      const cleanCheck = runTamperSelfCheck()
      const cleanNoWithhold = cleanCheck.ran && !cleanCheck.tampered && getEntitlements().snapshot().plan === 'pro'
      writeFileSync(shim, '#!/usr/bin/env node\n// fixture shim — PATCHED BY A FORK\n')
      const tamperCheck = runTamperSelfCheck()
      const snapTampered = getEntitlements().snapshot()
      const listTampered = await cli(['list'])
      const panelTampered = await panelState()
      const tamperWithholdsProFreeRuns =
        tamperCheck.tampered &&
        snapTampered.plan === 'free' &&
        snapTampered.reason === 'tampered' &&
        accountStatus().state === 'authed' && // the SESSION is not the build's fault
        listTampered.code === 0 &&
        panelTampered.reason === 'tampered'
      writeFileSync(shim, '#!/usr/bin/env node\n// fixture shim\n')
      const recheck = runTamperSelfCheck()
      const tamperRecovers = !recheck.tampered && getEntitlements().snapshot().plan === 'pro'

      // ── B. Both budgets ON the composed surface (16 panes + the machinery live) ──
      await ES(`window.__mogging.workspace.create({ name: 'Torrent' })`)
      await sleep(500)
      await ES(`window.__mogging.layout.apply(16)`)
      await waitUntil(async () => Number(await ES(`window.__mogging.layout.paneCount()`)) === 16, 20000, 400)
      await sleep(2500)
      const torrentIdx = Number(await ES(`window.__mogging.workspace.count()`)) - 1
      const wedgeIdx = torrentIdx - 1
      const phaseB = (await ES(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const ESCC = String.fromCharCode(27)
        const m = window.__mogging
        const act = m.workspace.active()
        const b = act.ordinal * 100
        const panes = (m.panes || []).filter((p) => p.id > b && p.id <= b + 16)
        const chunk = (id, t) => { let s = ''; for (let l = 0; l < 6; l++) s += ESCC + '[3' + ((l % 7) + 1) + 'm p' + id + ' t' + t + ' ' + 'x'.repeat(90) + ESCC + '[0m\\r\\n'; return s }
        let ticks = 0
        const writer = setInterval(() => { ticks++; for (const p of panes) p.term.write(chunk(p.id, ticks)) }, 50)
        const gaps = []; let last = performance.now(); let on = true
        const tick = (now) => { gaps.push(now - last); last = now; if (on) requestAnimationFrame(tick) }
        requestAnimationFrame(tick)
        const seq = [${wedgeIdx}, ${torrentIdx}, ${wedgeIdx}, ${torrentIdx}]
        for (let i = 0; i < seq.length; i++) { await sleep(650); m.workspace.switchByIndex(seq[i]) }
        await sleep(400); on = false; clearInterval(writer)
        const total = gaps.reduce((a, c) => a + c, 0)
        return {
          frames: gaps.length,
          avgFps: Math.round((gaps.length / (total / 1000)) * 10) / 10,
          maxGapMs: Math.round(Math.max.apply(null, gaps) * 10) / 10,
          heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0,
          livePanes: (m.panes || []).length
        }
      })()`)) as { frames: number; avgFps: number; maxGapMs: number; heapMB: number; livePanes: number }
      const budgetsHold =
        phaseB.maxGapMs <= BUDGET.maxFrameGapMs && phaseB.avgFps >= BUDGET.minAvgFps && phaseB.heapMB <= BUDGET.maxHeapMB && phaseB.livePanes >= 12

      // ── A6. Logout: one gesture back to anon-FREE, wedge untouched ───────────────
      await logout()
      const afterLogout = accountStatus()
      const snapOut = getEntitlements().snapshot()
      const panelOut = await panelState()
      const logoutAnonFree =
        afterLogout.state === 'anon' &&
        snapOut.plan === 'free' &&
        (store?.getSetting('entitlements.cache') ?? '') === '' &&
        panelOut.status === 'Not signed in' &&
        panelOut.badge === 'Free' &&
        panelOut.noteHidden
      const listEnd = await cli(['list'])
      const cliUngatedThroughout = listEnd.code === 0 && /^\d+\s+\d+x\d+/m.test(listEnd.stdout)

      const pass =
        anonAtBoot &&
        freeAtBoot &&
        unwiredHonest &&
        cliWedgeAnon &&
        authed &&
        authedNotPaid &&
        preWebhookFree &&
        cappedBeforePro &&
        forgedWebhookRefused &&
        subscribedPro &&
        replayIgnored &&
        deviceBound &&
        authnRode &&
        proUnlocksCapped &&
        panelShowsPro &&
        graceHolds &&
        panelGraceLine &&
        degradesNeverBricks &&
        offlineKeepsSession &&
        foreignDeviceFree &&
        noRelicense &&
        reauthed &&
        backOnAPro &&
        cleanNoWithhold &&
        tamperWithholdsProFreeRuns &&
        tamperRecovers &&
        budgetsHold &&
        logoutAnonFree &&
        cliUngatedThroughout

      result = {
        pass,
        // The world this run proved — read these before comparing across machines.
        backend: probe.backend,
        hardwareBacked: probe.hardwareBacked,
        deviceLeg,
        anonAtBoot,
        freeAtBoot,
        unwiredHonest,
        cliWedgeAnon,
        authed,
        authedNotPaid,
        preWebhookFree,
        cappedBeforePro,
        forgedWebhookRefused,
        subscribedPro,
        replayIgnored,
        deviceBound,
        authnRode,
        proUnlocksCapped,
        panelShowsPro,
        graceHolds,
        panelGraceLine,
        degradesNeverBricks,
        offlineKeepsSession,
        foreignDeviceFree,
        noRelicense,
        reauthed,
        backOnAPro,
        cleanNoWithhold,
        tamperWithholdsProFreeRuns,
        tamperRecovers,
        budgetsHold,
        logoutAnonFree,
        cliUngatedThroughout,
        phaseB,
        budget: BUDGET,
        listHead: listEnd.stdout.split('\n').slice(0, 3)
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    await issuer?.stop().catch(() => undefined)
    await idp.stop()
    configureTamperCheckForSmoke(null)
    if (nativeLeg) {
      await deleteDeviceKey(`MoggingSmoke.prodm.A.${process.pid}`).catch(() => undefined)
      await deleteDeviceKey(`MoggingSmoke.prodm.B.${process.pid}`).catch(() => undefined)
    }
    setDeviceKeyNameForSmoke(null)
    resetAccountForSmoke()
    resetEntitlementsForSmoke()
    for (const id of savedRemotes) getSettingsStore()?.removeRemote(id)
    if (tmp) rmSync(tmp, { recursive: true, force: true })
    writeResult('prodmilestone', result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}
