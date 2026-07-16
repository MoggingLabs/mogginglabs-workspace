import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { getEntitlements } from '@backend'
import { FakeIdp } from '@backend/features/account/fake-idp'
import { FakeEntitleIssuer } from '@backend/features/account/fake-entitle'
import { deleteDeviceKey, openDeviceKey, probeDeviceKey } from '@backend/platform/device-key'
import {
  generateDpopKey,
  jktOfPublicJwk,
  openDeviceDpopKey,
  setDeviceKeyForceSoftwareForSmoke,
  setDeviceKeyNameForSmoke,
  type DpopKey,
  type DpopPublicJwk
} from '@backend/platform/dpop-key'
import {
  accountStatus,
  dpopCustodyForSmoke,
  dpopJktForSmoke,
  dropDpopKeyMemoryForSmoke,
  forceRefreshForSmoke,
  login,
  resetAccountForSmoke,
  setAccountConfigForSmoke,
  setBrowserOpenerForSmoke,
  whenSettledForSmoke
} from '../account'
import {
  cachedDeviceIdForSmoke,
  dropMemoryCacheForSmoke,
  ensureDeviceJktForSmoke,
  refreshEntitlements,
  registerEntitlements,
  resetEntitlementsForSmoke,
  setEntitleClockForSmoke,
  setEntitleConfigForSmoke
} from '../entitlements'
import { vaultClearKey } from '../vault'

// Env-gated device-key smoke (MOGGING_DEVICEKEY, phase-accounts/06). Windowless — the
// key holder needs the settings store + the OS vault, no window. Runs against the REAL
// platform key store (TPM / CNG / Secure Enclave — under SMOKE-NAMED keys, deleted at
// teardown, so the machine's real device identity is never touched) plus the FAKE
// in-process IdP + entitlement issuer (zero external network). It proves, in order:
//   (a) generate → sign → verify with the platform key: a DPoP proof signed BY THE
//       CHIP verifies with plain node:crypto against the proof's own public key, and
//       the key persists (a second open answers the same thumbprint);
//   (b) the key is NON-EXPORTABLE: the OS's own private-key export is REFUSED, and
//       the DpopKey surface has no export method for hardware custody;
//   (c) the copied install is INERT: a vault carried to "machine B" (different chip,
//       same vault contents — the pirate-redistribution shape) cannot refresh: the AS
//       rejects the foreign-key proof, no new token is issued, the session drops to
//       anon cleanly;
//   (d) entitlements are SENDER-CONSTRAINED: a device-mismatch claim is refused at
//       fetch (never cached); issuance binds deviceId to the device public key the
//       proof presented (attestation); on machine B the cached claim reads Free the
//       moment the device is known, and no re-license is possible — degrade, not brick;
//   (e) the software fallback (Linux; hardware-less machines) says what it is:
//       custody 'software', hardwareBacked false — never a hardware claim.
// On machines with no native key store, (a)-(d) run in the honest fallback shape and
// the verdict says which world it proved (`backend`, `deviceLeg`).

export async function runDeviceKeySmoke(): Promise<void> {
  let result: Record<string, unknown> = { pass: false }
  const NAME_A = `MoggingSmoke.deviceA.${process.pid}`
  const NAME_B = `MoggingSmoke.deviceB.${process.pid}`
  const idp = new FakeIdp({ email: 'founder@mogginglabs.example', plan: 'pro', accessTtlSec: 600 })
  let issuer: FakeEntitleIssuer | null = null
  let nativeLeg = false
  try {
    resetAccountForSmoke()
    resetEntitlementsForSmoke()

    const probe = await probeDeviceKey()
    nativeLeg = probe.backend !== 'none'

    // ── (a) generate → sign → verify, through the exact production proof path ──────
    setDeviceKeyNameForSmoke(NAME_A)
    // A probed key store can still refuse persistence (an unsigned macOS dev build, a
    // CI VM without SEP) — openDeviceDpopKey answers null and that IS the fallback
    // world; run it as such, honestly.
    const keyA = nativeLeg ? await openDeviceDpopKey() : null
    const deviceLeg = keyA !== null
    const key: DpopKey = keyA ?? generateDpopKey()
    const proof = await key.createProof({ htm: 'POST', htu: 'https://idp.smoke.example/token' })
    const [h, p, s] = proof.split('.')
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string; jwk?: DpopPublicJwk }
    let signVerifies = false
    try {
      const pub = createPublicKey({ key: { ...header.jwk! }, format: 'jwk' })
      signVerifies =
        header.alg === 'ES256' &&
        verifySignature('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))
    } catch {
      signVerifies = false
    }
    const jktMatches = !!header.jwk && jktOfPublicJwk(header.jwk) === key.jkt
    const persists = !deviceLeg || (await openDeviceDpopKey())?.jkt === key.jkt

    // ── (b) the private key cannot leave ───────────────────────────────────────────
    // Native custody: ask the OS itself to export the private half — the answer must
    // be a refusal. Software custody has no native export to attempt; its honesty is
    // (e)'s assertion, not a hardware claim here.
    let exportRefused = !deviceLeg
    if (deviceLeg) {
      const handle = await openDeviceKey(NAME_A)
      const attempt = handle ? await handle.tryExportPrivate() : null
      exportRefused = attempt !== null && attempt.attempted && attempt.refused
    }
    const noExportSurface = !deviceLeg || keyA.exportPrivateKeyPem === undefined

    // ── (c) the copied install: same vault, different machine ─────────────────────
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
    const authedA = ((await whenSettledForSmoke()) ?? { state: 'anon' }).state === 'authed'
    const jktA = await dpopJktForSmoke()
    const boundToDeviceA = authedA && jktA !== null && idp.lastBoundJkt === jktA && (!deviceLeg || jktA === key.jkt)

    // "Machine B": everything at rest rides along (a pirated copy ships the vault,
    // even plaintext-extracted) — the chip does not. Native custody swaps to a second
    // real platform key; software custody loses the vaulted key (safeStorage
    // ciphertext does not decrypt off-machine), which is that custody's honest shape.
    const issuedBeforeCopy = idp.issuedRefresh.length
    if (deviceLeg) setDeviceKeyNameForSmoke(NAME_B)
    else vaultClearKey('account.dpopKey')
    dropDpopKeyMemoryForSmoke()
    const refreshOnB = await forceRefreshForSmoke()
    const copiedInstallInert =
      refreshOnB.ok === false &&
      refreshOnB.authed === false &&
      accountStatus().state === 'anon' &&
      idp.issuedRefresh.length === issuedBeforeCopy // the AS minted NOTHING for the copy

    // ── (d) entitlements are sender-constrained to the device ─────────────────────
    // Back on device A with a fresh session (the copy attempt above cleanly ended the
    // old one — that is the point of (c)).
    setDeviceKeyNameForSmoke(NAME_A)
    dropDpopKeyMemoryForSmoke()
    wireAccount()
    await login()
    const authedA2 = ((await whenSettledForSmoke()) ?? { state: 'anon' }).state === 'authed'
    const jktA2 = (await dpopJktForSmoke()) ?? ''

    const clock = { t: Date.now() }
    // NO deviceId seeded: the issuer must learn it from the request (attestation).
    issuer = new FakeEntitleIssuer({
      proLimits: { maxPanes: 8, maxConnections: 25, maxSwarmRoles: 2, maxRemotes: 1 },
      ttlSec: 48 * 3600,
      clock: () => clock.t
    })
    await issuer.start()
    setEntitleClockForSmoke(() => clock.t)
    setEntitleConfigForSmoke({ baseUrl: issuer.baseUrl, verifyKeyPem: issuer.publicKeyPem })
    registerEntitlements(() => null)

    // A validly-signed claim for SOMEONE ELSE'S machine is refused at the door.
    issuer.setFixture('device-mismatch')
    const mismatchFetch = await refreshEntitlements()
    const mismatchRefused = mismatchFetch === false && getEntitlements().snapshot().plan === 'free' && cachedDeviceIdForSmoke() === null

    // Attestation: the issuer bound deviceId to the device public key the DPoP proof
    // presented — OUR key — and the engine honors it.
    issuer.setFixture('pro')
    const fetched = await refreshEntitlements()
    const attested =
      fetched && getEntitlements().snapshot().plan === 'pro' && issuer.lastProofJkt === jktA2 && cachedDeviceIdForSmoke() === jktA2

    // The pirate copy on machine B: cached claim + refresh token present, chip absent.
    // The claim reads FREE the moment the device is known; re-license is impossible;
    // nothing bricks and the cache is not overwritten.
    let mismatchDegrades = true
    let noRelicense = true
    if (deviceLeg) {
      setDeviceKeyNameForSmoke(NAME_B)
      dropDpopKeyMemoryForSmoke()
      dropMemoryCacheForSmoke()
      const deviceB = await ensureDeviceJktForSmoke()
      const snapB = getEntitlements().snapshot()
      mismatchDegrades = deviceB !== null && deviceB !== jktA2 && snapB.plan === 'free' && cachedDeviceIdForSmoke() === jktA2
      const relicense = await refreshEntitlements()
      noRelicense =
        relicense === false &&
        getEntitlements().snapshot().plan === 'free' &&
        accountStatus().state === 'anon' &&
        cachedDeviceIdForSmoke() === jktA2
    }

    // ── (e) the software fallback says what it is ──────────────────────────────────
    setDeviceKeyForceSoftwareForSmoke(true)
    resetAccountForSmoke()
    wireAccount()
    await login()
    const authedSoft = ((await whenSettledForSmoke()) ?? { state: 'anon' }).state === 'authed'
    const custodySoft = await dpopCustodyForSmoke()
    const fallbackHonest = authedSoft && custodySoft !== null && custodySoft.backend === 'software' && custodySoft.hardwareBacked === false
    setDeviceKeyForceSoftwareForSmoke(false)

    const pass =
      signVerifies &&
      jktMatches &&
      persists &&
      exportRefused &&
      noExportSurface &&
      boundToDeviceA &&
      copiedInstallInert &&
      authedA2 &&
      mismatchRefused &&
      attested &&
      mismatchDegrades &&
      noRelicense &&
      fallbackHonest
    result = {
      pass,
      // The world this run proved — read these before comparing across machines.
      backend: probe.backend,
      hardwareBacked: probe.hardwareBacked,
      deviceLeg,
      signVerifies,
      jktMatches,
      persists,
      exportRefused,
      noExportSurface,
      boundToDeviceA,
      copiedInstallInert,
      authedA2,
      mismatchRefused,
      attested,
      mismatchDegrades,
      noRelicense,
      fallbackHonest
      // Thumbprints and tokens stay out of the verdict on principle.
    }
  } catch (e) {
    result = { pass: false, error: String(e) }
  }
  await issuer?.stop().catch(() => undefined)
  await idp.stop()
  if (nativeLeg) {
    // The smoke's chip keys must not outlive it (the REAL device key was never touched).
    await deleteDeviceKey(NAME_A).catch(() => undefined)
    await deleteDeviceKey(NAME_B).catch(() => undefined)
  }
  setDeviceKeyNameForSmoke(null)
  setDeviceKeyForceSoftwareForSmoke(false)
  resetAccountForSmoke()
  resetEntitlementsForSmoke()
  try {
    writeFileSync(join(app.getAppPath(), 'out', 'devicekey-result.json'), JSON.stringify(result, null, 2))
  } catch {
    /* best effort */
  }
  app.exit(result.pass ? 0 : 1)
}
