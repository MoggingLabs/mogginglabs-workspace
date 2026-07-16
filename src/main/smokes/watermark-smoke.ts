import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEntitlements, NoopTelemetry, setTelemetry } from '@backend'
import { FREE_ENTITLEMENTS, type TelemetryEvent } from '@contracts'
import { FakeIdp } from '@backend/features/account/fake-idp'
import { FakeEntitleIssuer } from '@backend/features/account/fake-entitle'
import { setDeviceKeyForceSoftwareForSmoke } from '@backend/platform/dpop-key'
import {
  dpopJktForSmoke,
  dropDpopKeyMemoryForSmoke,
  login,
  resetAccountForSmoke,
  setAccountConfigForSmoke,
  setBrowserOpenerForSmoke,
  whenSettledForSmoke
} from '../account'
import { vaultClearKey } from '../vault'
import {
  activationWatermarkForSmoke,
  dropMemoryCacheForSmoke,
  ensureDeviceJktForSmoke,
  isBuildTamperedForSmoke,
  refreshEntitlements,
  resetEntitlementsForSmoke,
  setEntitleClockForSmoke,
  setEntitleConfigForSmoke
} from '../entitlements'
import { canonicalTamperManifestForSmoke, configureTamperCheckForSmoke, runTamperSelfCheck } from '../native-preflight'

// Env-gated forensic-watermark smoke (MOGGING_WATERMARK, phase-accounts/07). WINDOWED —
// part (b) proves the FREE app still runs under a tamper verdict, and that means a live
// daemon + the real `mogging` CLI. Runs ENTIRELY against the FAKE in-process IdP + FAKE
// entitlement issuer + FIXTURE integrity manifest (zero external network, by
// construction). It proves, in order:
//   (a) a watermarked activation ROUND-TRIPS: the issuer binds a per-account fingerprint
//       into the signed claim, and the OPERATOR tool scripts/trace-watermark.mjs extracts
//       the EXACT account id — from the primary carrier, and (primary stripped) from the
//       redundant ordering carrier against a known-account set, while refusing to attribute
//       to an account it was not given (no hallucination);
//   (d) a `revoked` entitlement degrades to Free on the next refresh (no remote detonation);
//   (b) the runtime tamper self-check: a clean build withholds NOTHING (no false positive),
//       a modified bin/ shim sets `tampered` → PAID is withheld (plan → free) while the FREE
//       app still boots and `mogging list` still works, and fixing the shim RESTORES PAID;
//   (c) the copied-install device-mismatch signal fires, and every piracy telemetry payload
//       (build.modified, entitlement.device_mismatch) carries BOOLEANS ONLY — never a path,
//       filename, id, or credential (ADR 0002/0005; invariant I6).
// Verdict: out/watermark-result.json.

const ACCOUNT_ID = 'acct_9f2c17e5b0d4'

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export function runWatermarkSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 240000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  // Run a bundled node script (the CLI, or the operator trace tool) under Electron-as-Node
  // — no system Node required, the control-smoke pattern.
  const node = (script: string, args: string[] = []): Promise<CliResult> =>
    new Promise((resolveCli) => {
      execFile(
        process.execPath,
        [script, ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20000, windowsHide: true },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
              ? ((err as unknown as { code: number }).code as number)
              : err
                ? 1
                : 0
          resolveCli({ code, stdout: String(stdout), stderr: String(stderr) })
        }
      )
    })

  const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
  const b64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const parseTrace = (r: CliResult): Record<string, unknown> | null => {
    try {
      return JSON.parse(r.stdout.trim()) as Record<string, unknown>
    } catch {
      return null
    }
  }

  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')
  const traceScript = join(app.getAppPath(), 'scripts', 'trace-watermark.mjs')

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const idp = new FakeIdp({ email: 'founder@mogginglabs.example', plan: 'pro', accessTtlSec: 600 })
    let issuer: FakeEntitleIssuer | null = null
    let tmp = ''
    // Record every telemetry event so (c) can assert the piracy signals are booleans only.
    const events: TelemetryEvent[] = []
    try {
      tmp = mkdtempSync(join(tmpdir(), 'mogging-wm-'))
      setTelemetry({
        init() {},
        captureError() {},
        addBreadcrumb() {},
        setContext() {},
        flush: async () => undefined,
        captureEvent: (e) => void events.push(e)
      })

      resetAccountForSmoke()
      resetEntitlementsForSmoke()
      // The engine, not the chip: pin the software custody path so this is deterministic
      // on any runner (DEVICEKEY owns the real hardware proof).
      setDeviceKeyForceSoftwareForSmoke(true)

      // ── Sign in against the fake IdP so a REAL access token + DPoP key exist ─────────
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
      const jkt1 = (await dpopJktForSmoke()) ?? 'device-1'

      // ── The issuer: attestation-bound (deviceId omitted) so it binds each claim to the
      //    presented proof's device key, and activating FOR our account so every fresh
      //    fixture carries the watermark.
      const clock = { t: Date.now() }
      const nowFn = (): number => clock.t
      issuer = new FakeEntitleIssuer({
        accountId: ACCOUNT_ID,
        proLimits: { maxPanes: 8, maxConnections: 25, maxSwarmRoles: 2, maxRemotes: 1 },
        ttlSec: 48 * 3600,
        clock: nowFn
      })
      await issuer.start()
      setEntitleClockForSmoke(nowFn)
      setEntitleConfigForSmoke({ baseUrl: issuer.baseUrl, verifyKeyPem: issuer.publicKeyPem })
      const rearm = (): void => {
        resetEntitlementsForSmoke()
        setEntitleClockForSmoke(nowFn)
        setEntitleConfigForSmoke({ baseUrl: issuer!.baseUrl, verifyKeyPem: issuer!.publicKeyPem })
      }

      // ── (a) A watermarked activation round-trips ────────────────────────────────────
      issuer.setFixture('pro')
      const fetched = await refreshEntitlements()
      const snapPro = getEntitlements().snapshot()
      const proOk =
        fetched && snapPro.plan === 'pro' && getEntitlements().allows('pro') && getEntitlements().limit('maxPanes') === 8
      const carriers = activationWatermarkForSmoke()
      const carriersPresent = !!carriers && typeof carriers.wm === 'string' && Array.isArray(carriers.wmk) && carriers.wmk.length === 8

      // Primary carrier → the operator tool extracts the EXACT account id.
      const recFull = join(tmp, 'activation.json')
      writeFileSync(recFull, JSON.stringify({ watermark: { wm: carriers?.wm, wmk: carriers?.wmk } }))
      const tracePrimary = await node(traceScript, [recFull, '--json'])
      const tp = parseTrace(tracePrimary)
      const traceExactPrimary = tracePrimary.code === 0 && tp?.accountId === ACCOUNT_ID && tp?.attributedBy === 'primary' && tp?.carriersAgree === true

      // Redundant carrier (primary STRIPPED) → attributes against a known-account set.
      const recOrder = join(tmp, 'order-only.json')
      writeFileSync(recOrder, JSON.stringify({ wmk: carriers?.wmk }))
      const traceOrder = await node(traceScript, [recOrder, '--accounts', `acct_decoy_a,${ACCOUNT_ID},acct_decoy_b`, '--json'])
      const to = parseTrace(traceOrder)
      const traceExactOrder = traceOrder.code === 0 && to?.accountId === ACCOUNT_ID && to?.attributedBy === 'order'

      // No hallucination: the redundant carrier does NOT attribute to an account it was
      // never handed (the real account absent from --accounts).
      const traceNone = await node(traceScript, [recOrder, '--accounts', 'acct_decoy_a,acct_decoy_b', '--json'])
      const tn = parseTrace(traceNone)
      const traceNoFalse = traceNone.code === 1 && tn?.accountId === null

      // ── (d) A revoked entitlement degrades to Free on refresh ───────────────────────
      rearm()
      issuer.setFixture('revoked')
      const revokedFetched = await refreshEntitlements()
      const snapRevoked = getEntitlements().snapshot()
      const revokedFree =
        snapRevoked.plan === 'free' &&
        getEntitlements().allows('pro') === false &&
        snapRevoked.limits.maxRemotes === FREE_ENTITLEMENTS.limits.maxRemotes

      // Restore a clean Pro activation for the tamper test.
      rearm()
      issuer.setFixture('pro')
      await refreshEntitlements()
      const proBeforeTamper = getEntitlements().snapshot().plan === 'pro'

      // ── (b) The runtime tamper self-check ───────────────────────────────────────────
      // A fixture "unpacked bin/" + a SIGNED manifest over it (the operator's key is
      // injected as a parameter — never the environment; the entitlement-issuer pattern).
      const binDir = join(tmp, 'bin')
      mkdirSync(binDir)
      const shimA = join(binDir, 'mogging.mjs')
      const shimB = join(binDir, 'mogging-mcp.mjs')
      writeFileSync(shimA, '#!/usr/bin/env node\n// fixture shim A\n')
      writeFileSync(shimB, '#!/usr/bin/env node\n// fixture shim B\n')
      const manifest = { v: 1, files: { 'mogging.mjs': sha256File(shimA), 'mogging-mcp.mjs': sha256File(shimB) } }
      const { privateKey, publicKey } = generateKeyPairSync('ed25519')
      const sig = b64url(sign(null, Buffer.from(canonicalTamperManifestForSmoke(manifest)), privateKey))
      const manifestPath = join(tmp, 'integrity-manifest.json')
      writeFileSync(manifestPath, JSON.stringify({ manifest, sig }))
      configureTamperCheckForSmoke({
        manifestPath,
        verifyKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        baseDir: binDir
      })

      // Clean build: the self-check runs and withholds NOTHING.
      const cleanCheck = runTamperSelfCheck()
      const cleanNoWithhold =
        cleanCheck.ran && cleanCheck.tampered === false && !isBuildTamperedForSmoke() && getEntitlements().snapshot().plan === 'pro'

      // A fork patches a shim: the self-check flips `tampered`, PAID is withheld.
      writeFileSync(shimA, '#!/usr/bin/env node\n// fixture shim A — PATCHED BY A FORK\n')
      const tamperCheck = runTamperSelfCheck()
      const snapTampered = getEntitlements().snapshot()
      const paidWithheld =
        tamperCheck.tampered &&
        tamperCheck.mismatches.includes('mogging.mjs') &&
        isBuildTamperedForSmoke() &&
        snapTampered.plan === 'free' &&
        getEntitlements().allows('pro') === false &&
        snapTampered.limits.maxPanes === FREE_ENTITLEMENTS.limits.maxPanes

      // …but the FREE app still boots and RUNS: a real workspace, and `mogging list`
      // enumerating its pane, all while `tampered` holds.
      await ES(
        '(function(){var m=window.__mogging;' +
          'if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Workspace 1"});return 1;})()'
      )
      await sleep(3500)
      const list = await node(cliPath, ['list'])
      const rendererAlive = (await ES<string>(`document.getElementById('root') ? 'alive' : 'gone'`)) === 'alive'
      const freeAppRuns = isBuildTamperedForSmoke() && list.code === 0 && /^1\s+\d+x\d+/m.test(list.stdout) && rendererAlive

      // Fixing the shim RESTORES PAID (revocation trigger, not a one-way brick).
      writeFileSync(shimA, '#!/usr/bin/env node\n// fixture shim A\n')
      const recheck = runTamperSelfCheck()
      const recoversPaid = recheck.tampered === false && !isBuildTamperedForSmoke() && getEntitlements().snapshot().plan === 'pro'

      // ── (c) The copied-install device-mismatch signal, boolean-only telemetry ───────
      // Clearing the vaulted software key + the in-memory handle makes the next login mint
      // a NEW device key: the cached (device-D1) activation now lands on a different
      // machine's key (D2) — the pirated-vault case. Deliberately NOT `logout()`: an
      // explicit logout now also drops the cached claim (the anon-free law, step 10), and
      // a pirated copy never logged out — the cache riding along is the very scenario.
      vaultClearKey('account.dpopKey')
      dropDpopKeyMemoryForSmoke()
      await login()
      await whenSettledForSmoke()
      const jkt2 = (await dpopJktForSmoke()) ?? 'device-2'
      dropMemoryCacheForSmoke()
      await ensureDeviceJktForSmoke()
      await sleep(250) // let the post-resolution push + telemetry emission settle
      const deviceChanged = jkt2 !== jkt1
      const mismatchFree = getEntitlements().snapshot().plan === 'free'

      const buildModifiedFired = events.some((e) => e.name === 'build.modified' && typeof e.props?.modified === 'boolean')
      const deviceMismatchFired = events.some((e) => e.name === 'entitlement.device_mismatch' && typeof e.props?.mismatch === 'boolean')
      const piracy = events.filter((e) => e.name === 'build.modified' || e.name === 'entitlement.device_mismatch')
      // BOOLEANS ONLY: every prop of every piracy signal is a boolean — no string can hide
      // a path, a filename, an id, or a credential (I6; the grep, made a typed assertion).
      const booleansOnly =
        piracy.length >= 1 &&
        piracy.every((e) => !!e.props && Object.keys(e.props).length > 0 && Object.values(e.props).every((v) => typeof v === 'boolean'))

      const pass =
        authed &&
        proOk &&
        carriersPresent &&
        traceExactPrimary &&
        traceExactOrder &&
        traceNoFalse &&
        revokedFree &&
        proBeforeTamper &&
        cleanNoWithhold &&
        paidWithheld &&
        freeAppRuns &&
        recoversPaid &&
        deviceChanged &&
        mismatchFree &&
        buildModifiedFired &&
        deviceMismatchFired &&
        booleansOnly

      result = {
        pass,
        authed,
        proOk,
        carriersPresent,
        traceExactPrimary,
        traceExactOrder,
        traceNoFalse,
        revokedFetched,
        revokedFree,
        proBeforeTamper,
        cleanNoWithhold,
        paidWithheld,
        freeAppRuns,
        recoversPaid,
        deviceChanged,
        mismatchFree,
        buildModifiedFired,
        deviceMismatchFired,
        booleansOnly,
        account: ACCOUNT_ID,
        tracedPrimary: tp?.accountId ?? null,
        tracedOrder: to?.accountId ?? null,
        // ID + booleans only — the verdict carries the recorded piracy payloads verbatim
        // so the sweep can grep them, and NO jwt, token, or terminal content.
        piracyEvents: piracy,
        listHead: list.stdout.split('\n').slice(0, 2)
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }

    await issuer?.stop().catch(() => undefined)
    await idp.stop()
    configureTamperCheckForSmoke(null)
    resetAccountForSmoke()
    resetEntitlementsForSmoke()
    setDeviceKeyForceSoftwareForSmoke(false)
    setTelemetry(new NoopTelemetry())
    if (tmp) rmSync(tmp, { recursive: true, force: true })
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'watermark-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
