import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AccountChannels } from '@contracts'
import { FakeIdp } from '@backend/features/account/fake-idp'
import { setDeviceKeyForceSoftwareForSmoke } from '@backend/platform/dpop-key'
import {
  accountStatus,
  dpopJktForSmoke,
  forceRefreshForSmoke,
  login,
  logout,
  resetAccountForSmoke,
  setAccountConfigForSmoke,
  setBrowserOpenerForSmoke,
  whenSettledForSmoke
} from '../account'
import { getSettingsStore } from '../app-settings'

// Env-gated account smoke (MOGGING_ACCOUNT, ADR 0015). Windowless — the token holder
// needs the settings store + the OS vault, no window. Runs ENTIRELY against the FAKE
// in-process IdP (zero external network). It proves, in order:
//   (a) login lands an AUTHED status carrying the right email + plan claims;
//   (b) the refresh token is at rest as CIPHERTEXT and NO channel returns it — the
//       plaintext appears in neither the settings DB, the status, nor this result, and
//       the IPC surface is a closed claims-only set with no token getter;
//   (c) refresh ROTATES the token and PERSISTS the new one (ciphertext changes);
//   (d) a DPoP proof is attached and VERIFIES, the AS bound the SAME key the client
//       holds, and a foreign-key refresh is REJECTED (sender-constraint — a lifted
//       refresh token is inert without the key);
//   (e) logout clears the vault (refresh + DPoP key) and memory -> anon, AND
//       best-effort-revokes the grant AT the AS (RFC 7009) so a forgotten refresh
//       token is not left valid server-side;
//   (f) a server-side revoked refresh drops a re-logged-in session to anon CLEANLY;
//   (g) OIDC verification is the door for identity claims: a tampered id_token
//       (valid grant, edited claims) refuses the whole login — decode-only display
//       of unverified claims is not a thing this module does.

const TOKEN_KEYS = ['accessToken', 'refreshToken', 'access_token', 'refresh_token']

export async function runAccountSmoke(): Promise<void> {
  let result: Record<string, unknown> = { pass: false }
  const idp = new FakeIdp({ email: 'founder@mogginglabs.example', plan: 'pro', accessTtlSec: 300 })
  try {
    resetAccountForSmoke()
    // Pin the SOFTWARE custody path: this gate proves token holding, not the chip
    // (DEVICEKEY owns that), and it must neither touch the machine's real device key
    // nor depend on what key store a runner happens to offer.
    setDeviceKeyForceSoftwareForSmoke(true)
    await idp.start()
    setAccountConfigForSmoke({
      metadata: idp.metadata,
      clientId: idp.clientId,
      resource: 'https://entitlements.mogginglabs.example',
      scopes: ['openid', 'email', 'entitlements']
    })
    // The injected "browser": drive the fake IdP's consent and deliver the code to the
    // account module's own loopback server — the whole round trip, in process.
    setBrowserOpenerForSmoke(async (url) => {
      const { redirectTo } = await idp.consent(url)
      await fetch(redirectTo)
    })

    const store = getSettingsStore()
    const dbPath = join(app.getPath('userData'), 'app-settings.db')
    const refreshCipher = (): string => store?.getSetting('account.refresh') ?? ''
    const dbText = (): string => {
      try {
        return readFileSync(dbPath, 'latin1')
      } catch {
        return ''
      }
    }

    // ── (a) login -> authed, right claims ────────────────────────────────────────
    const started = await login()
    const afterLogin = (await whenSettledForSmoke()) ?? accountStatus()
    const loginOk =
      started.ok && afterLogin.state === 'authed' && afterLogin.email === 'founder@mogginglabs.example' && afterLogin.plan === 'pro'

    // ── (b) custody + the closed, token-free IPC surface ─────────────────────────
    const issued = (): string[] => idp.issuedRefresh
    const cipher0 = refreshCipher()
    const ciphertextPresent = cipher0.length > 0 && issued().every((t) => !cipher0.includes(t))
    const plaintextNotInDb = issued().every((t) => !dbText().includes(t))
    // The surface: exactly status/login/logout/changed, none a token getter.
    const surfaceChannels: readonly string[] = Object.values(AccountChannels)
    const surfaceClosed =
      surfaceChannels.length === 4 &&
      ['account:status', 'account:login', 'account:logout', 'account:changed'].every((c) => surfaceChannels.includes(c)) &&
      !surfaceChannels.some((c) => /token/i.test(c))
    const statusJson = JSON.stringify(accountStatus())
    const statusHasNoToken = !TOKEN_KEYS.some((k) => statusJson.includes(k)) && issued().every((t) => !statusJson.includes(t))
    const custodyOk = ciphertextPresent && plaintextNotInDb && surfaceClosed && statusHasNoToken

    // ── (c) refresh rotates + persists ───────────────────────────────────────────
    const issuedBefore = issued().length
    const cipherBefore = refreshCipher()
    const refreshed = await forceRefreshForSmoke()
    const cipherAfter = refreshCipher()
    const rotateOk =
      refreshed.ok &&
      refreshed.authed &&
      issued().length === issuedBefore + 1 && // the AS minted a fresh refresh token
      cipherAfter.length > 0 &&
      cipherAfter !== cipherBefore && // the vaulted ciphertext changed (rotation persisted)
      issued().every((t) => !cipherAfter.includes(t)) // still ciphertext, never plaintext

    // ── (d) DPoP: proof verifies, key bound, foreign key rejected ────────────────
    const nonceDanced = idp.nonceChallenges >= 1 // the RFC 9449 §8 retry path is live
    const proofVerified = idp.proofsVerified >= 1
    const boundToOurKey = idp.lastBoundJkt !== null && idp.lastBoundJkt === (await dpopJktForSmoke())
    const foreign = await idp.probeForeignKeyRefresh() // a stolen refresh token, wrong key
    const dpopOk = nonceDanced && proofVerified && boundToOurKey && foreign.rejected

    // ── (e) logout clears vault + memory -> anon, and revokes AT the AS ──────────
    await logout()
    const afterLogout = accountStatus()
    const logoutOk = afterLogout.state === 'anon' && refreshCipher() === '' && (store?.getSetting('account.dpopKey') ?? '') === ''
    // RFC 7009: the forgotten grant was also revoked server-side. Fire-and-forget by
    // design, so poll with a retry loop (never a fixed sleep).
    let revokedAtAs = false
    for (let i = 0; i < 40 && !revokedAtAs; i++) {
      revokedAtAs = idp.revocations >= 1
      if (!revokedAtAs) await new Promise((r) => setTimeout(r, 50))
    }

    // ── (f) revoked refresh -> anon cleanly (re-login first) ──────────────────────
    await login()
    const reauthed = (await whenSettledForSmoke()) ?? accountStatus()
    idp.revokeAll()
    const afterRevokeRefresh = await forceRefreshForSmoke()
    const revokeState = accountStatus()
    const revokeOk =
      reauthed.state === 'authed' &&
      afterRevokeRefresh.ok === false &&
      afterRevokeRefresh.authed === false &&
      revokeState.state === 'anon' &&
      refreshCipher() === ''

    // ── (g) OIDC verification bites: a tampered id_token refuses the login ────────
    idp.setScenario('tampered-idtoken')
    const startedTampered = await login()
    const afterTamperedIdToken = (await whenSettledForSmoke()) ?? accountStatus()
    idp.setScenario('success')
    const idTokenVerifyBites = startedTampered.ok && afterTamperedIdToken.state === 'anon' && refreshCipher() === ''

    const pass = loginOk && custodyOk && rotateOk && dpopOk && logoutOk && revokedAtAs && revokeOk && idTokenVerifyBites
    result = {
      pass,
      loginOk,
      custodyOk,
      ciphertextPresent,
      plaintextNotInDb,
      surfaceClosed,
      statusHasNoToken,
      rotateOk,
      nonceDanced,
      proofVerified,
      boundToOurKey,
      foreignRejected: foreign.rejected,
      logoutOk,
      revokedAtAs,
      revokeOk,
      idTokenVerifyBites,
      tokenRequests: idp.tokenRequests,
      // Counts + claims only — deliberately NO token material in the verdict.
      issuedRefreshCount: idp.issuedRefresh.length
    }
    // Defense in depth: the verdict must not carry a token even by accident.
    const resultJson = JSON.stringify(result)
    if (idp.issuedRefresh.some((t) => resultJson.includes(t))) {
      result = { pass: false, error: 'a token leaked into the result — aborting' }
    }
  } catch (e) {
    result = { pass: false, error: String(e) }
  }
  await idp.stop()
  resetAccountForSmoke()
  setDeviceKeyForceSoftwareForSmoke(false)
  try {
    writeFileSync(join(app.getAppPath(), 'out', 'account-result.json'), JSON.stringify(result, null, 2))
  } catch {
    /* best effort */
  }
  app.exit(result.pass ? 0 : 1)
}
