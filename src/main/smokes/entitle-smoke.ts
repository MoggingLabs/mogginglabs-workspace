import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getEntitlements } from '@backend'
import { FREE_ENTITLEMENTS } from '@contracts'
import { FakeIdp } from '@backend/features/account/fake-idp'
import { FakeEntitleIssuer } from '@backend/features/account/fake-entitle'
import { setDeviceKeyForceSoftwareForSmoke } from '@backend/platform/dpop-key'
import {
  dpopJktForSmoke,
  login,
  resetAccountForSmoke,
  setAccountConfigForSmoke,
  setBrowserOpenerForSmoke,
  whenSettledForSmoke
} from '../account'
import {
  dropMemoryCacheForSmoke,
  refreshEntitlements,
  registerEntitlements,
  resetEntitlementsForSmoke,
  setEntitleClockForSmoke,
  setEntitleConfigForSmoke,
  verifyEntitlementJwt
} from '../entitlements'
import { remoteQuotaRefusal } from '../remotes'
import { getSettingsStore } from '../app-settings'

// Env-gated entitlement smoke (MOGGING_ENTITLE, phase-accounts/05). Windowless — the
// engine needs the settings store + the OS vault, no window. Runs ENTIRELY against the
// FAKE in-process IdP + FAKE in-process entitlement issuer (zero external network, by
// construction). It proves, in order:
//   (a) a fresh entitlement is fetched with REAL authn (step-04 access token + a DPoP
//       proof whose `ath` matches it), verified LOCALLY (Ed25519), cached as vault
//       CIPHERTEXT, and honored — plan/limits land on the ONE port features read;
//   (b) verification is the only door: a tampered payload, a wrong-key signature, and
//       an expired-at-fetch token are each treated as ABSENT (→ Free), never trusted —
//       and the device-mismatch fixture EXISTS, valid-signed, for step 06 to consume;
//   (c) the offline-grace law: the network is PULLED (issuer stopped); past `exp` but
//       inside the window the plan HOLDS (graceState 'grace'); past the window it
//       degrades to Free quietly — the port keeps answering, nothing bricks;
//   (d) the port gates a capped feature (the remotes gate under a fixture Pro limit of
//       1) with a visible upgrade reason, and the post-grace downgrade re-enables the
//       generous Free tier cleanly (the same action is allowed again).

const b64url = (s: string): string => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export async function runEntitleSmoke(): Promise<void> {
  let result: Record<string, unknown> = { pass: false }
  const idp = new FakeIdp({ email: 'founder@mogginglabs.example', plan: 'pro', accessTtlSec: 600 })
  let issuer: FakeEntitleIssuer | null = null
  try {
    resetAccountForSmoke()
    resetEntitlementsForSmoke()
    // Pin the SOFTWARE custody path: this gate proves the entitlement engine, not the
    // chip (DEVICEKEY owns that) — deterministic on any runner, no real-key touches.
    setDeviceKeyForceSoftwareForSmoke(true)

    // The FreeEntitlements fallback answers BEFORE any engine is installed — the
    // default the whole app rests on when nothing is signed in.
    const fallbackFree =
      getEntitlements().snapshot().plan === 'free' && getEntitlements().limit('maxRemotes') === FREE_ENTITLEMENTS.limits.maxRemotes

    // ── Sign in against the fake IdP so a REAL access token + DPoP key exist ──────
    await idp.start()
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
    await login()
    const authed = ((await whenSettledForSmoke()) ?? { state: 'anon' }).state === 'authed'

    // ── The engine, its clock, and the fixture issuer (verify key as a PARAMETER) ─
    const t0 = Date.now()
    const clock = { t: t0 }
    const nowFn = (): number => clock.t
    const jkt = (await dpopJktForSmoke()) ?? 'device-1'
    issuer = new FakeEntitleIssuer({
      deviceId: jkt,
      // A LOW Pro row so the gate mechanism is provable; real tiers are config + claim.
      proLimits: { maxPanes: 8, maxConnections: 25, maxSwarmRoles: 2, maxRemotes: 1 },
      ttlSec: 48 * 3600,
      clock: nowFn
    })
    await issuer.start()
    setEntitleClockForSmoke(nowFn)
    setEntitleConfigForSmoke({ baseUrl: issuer.baseUrl, verifyKeyPem: issuer.publicKeyPem })
    registerEntitlements(() => null) // the REAL registration: installs the port + IPC

    const rearm = (): void => {
      // Clear the cache between verification cases without losing the seams.
      resetEntitlementsForSmoke()
      setEntitleClockForSmoke(nowFn)
      setEntitleConfigForSmoke({ baseUrl: issuer!.baseUrl, verifyKeyPem: issuer!.publicKeyPem })
    }

    // ── (a) fetch + verify + cache + the port answers Pro ─────────────────────────
    const fetched = await refreshEntitlements()
    const snapPro = getEntitlements().snapshot()
    const proOk =
      fetched &&
      snapPro.plan === 'pro' &&
      snapPro.graceState === 'fresh' &&
      snapPro.limits.maxRemotes === 1 &&
      getEntitlements().limit('maxPanes') === 8 &&
      getEntitlements().allows('pro')
    const authnRode = issuer.entitlementRequests >= 1 && issuer.lastAuthOk === true && issuer.lastAthOk === true

    // Cached as CIPHERTEXT: the constant JWT header never appears in the KV slot or
    // anywhere in the settings DB file — only inside safeStorage ciphertext.
    const jwtHeaderB64 = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'entitle+jwt' }))
    const store = getSettingsStore()
    const cacheSlot = store?.getSetting('entitlements.cache') ?? ''
    let dbText = ''
    try {
      dbText = readFileSync(join(app.getPath('userData'), 'app-settings.db'), 'latin1')
    } catch {
      /* absent db reads as empty */
    }
    const cachedCiphertext = cacheSlot.length > 0 && !cacheSlot.includes(jwtHeaderB64) && !dbText.includes(jwtHeaderB64)
    // …and it SURVIVES: drop the in-memory copy, the vault slot alone must answer Pro.
    dropMemoryCacheForSmoke()
    const cacheSurvives = getEntitlements().snapshot().plan === 'pro'

    // ── (b) verification is the only door ─────────────────────────────────────────
    const tamperedRejected = verifyEntitlementJwt(issuer.issue('tampered')) === null
    const wrongKeyRejected = verifyEntitlementJwt(issuer.issue('wrong-key')) === null
    const validStillVerifies = verifyEntitlementJwt(issuer.issue('pro')) !== null
    const deviceFixture = verifyEntitlementJwt(issuer.issue('device-mismatch'))
    const deviceMismatchCarried = deviceFixture !== null && deviceFixture.deviceId !== jkt // valid signature, wrong machine — step 06's food

    // End to end: a tampered FETCH lands nothing (→ Free), and an expired-at-fetch
    // token is equally absent.
    rearm()
    issuer.setFixture('tampered')
    const tamperedFetch = await refreshEntitlements()
    const afterTampered = getEntitlements().snapshot()
    const tamperedFetchAbsent = tamperedFetch === false && afterTampered.plan === 'free' && (store?.getSetting('entitlements.cache') ?? '') === ''
    issuer.setFixture('expired')
    const expiredFetch = await refreshEntitlements()
    const expiredFetchAbsent = expiredFetch === false && getEntitlements().snapshot().plan === 'free'

    // ── (c) the offline-grace law ──────────────────────────────────────────────────
    rearm()
    issuer.setFixture('pro')
    const refetched = await refreshEntitlements()
    await issuer.stop() // THE NETWORK IS PULLED — everything below runs offline
    clock.t = t0 + 60 * 3_600_000 // past exp (48h), inside the grace window
    const offlineRefresh = await refreshEntitlements() // fails, and must change nothing
    const snapGrace = getEntitlements().snapshot()
    const graceHolds =
      refetched && offlineRefresh === false && snapGrace.plan === 'pro' && snapGrace.graceState === 'grace' && snapGrace.limits.maxRemotes === 1

    // The port gates a capped feature while the Pro fixture (maxRemotes: 1) holds.
    store?.saveRemote({ id: 'h-ent-1', name: 'entbox', host: 'ent.example' })
    const refusal = remoteQuotaRefusal('h-ent-2')
    const portGates = typeof refusal === 'string' && /pro plan/i.test(refusal) && /upgrade/i.test(refusal)
    const editNeverGated = remoteQuotaRefusal('h-ent-1') === null

    // Past the window: degrade to Free — quietly, still answering, never bricked.
    clock.t = t0 + 15 * 86_400_000
    const snapExpired = getEntitlements().snapshot()
    const stillOffline = await refreshEntitlements() // still no network; still no throw
    const degradesToFree =
      stillOffline === false &&
      snapExpired.plan === 'free' &&
      snapExpired.graceState === 'expired' &&
      snapExpired.limits.maxRemotes === FREE_ENTITLEMENTS.limits.maxRemotes &&
      snapExpired.limits.maxPanes === FREE_ENTITLEMENTS.limits.maxPanes

    // ── (d) the downgrade re-enables Free cleanly: the refused action now passes ──
    const downgradeReEnables = remoteQuotaRefusal('h-ent-2') === null
    store?.removeRemote('h-ent-1')

    const pass =
      fallbackFree &&
      authed &&
      proOk &&
      authnRode &&
      cachedCiphertext &&
      cacheSurvives &&
      tamperedRejected &&
      wrongKeyRejected &&
      validStillVerifies &&
      deviceMismatchCarried &&
      tamperedFetchAbsent &&
      expiredFetchAbsent &&
      graceHolds &&
      portGates &&
      editNeverGated &&
      degradesToFree &&
      downgradeReEnables
    result = {
      pass,
      fallbackFree,
      authed,
      proOk,
      authnRode,
      cachedCiphertext,
      cacheSurvives,
      tamperedRejected,
      wrongKeyRejected,
      validStillVerifies,
      deviceMismatchCarried,
      tamperedFetchAbsent,
      expiredFetchAbsent,
      graceHolds,
      portGates,
      editNeverGated,
      degradesToFree,
      downgradeReEnables,
      // Counts + claims only — the verdict carries no JWT and no token.
      entitlementRequests: issuer.entitlementRequests,
      refusalWording: refusal ?? ''
    }
  } catch (e) {
    result = { pass: false, error: String(e) }
  }
  await issuer?.stop().catch(() => undefined)
  await idp.stop()
  resetAccountForSmoke()
  resetEntitlementsForSmoke()
  setDeviceKeyForceSoftwareForSmoke(false)
  try {
    writeFileSync(join(app.getAppPath(), 'out', 'entitle-result.json'), JSON.stringify(result, null, 2))
  } catch {
    /* best effort */
  }
  app.exit(result.pass ? 0 : 1)
}
