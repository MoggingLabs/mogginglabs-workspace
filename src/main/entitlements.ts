import { ipcMain, type BrowserWindow } from 'electron'
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'
import { getTelemetry, setEntitlements } from '@backend'
import { ENTITLEMENT_VERIFY_PUBKEY } from '@backend/core/origins'
import {
  EntitlementsChannels,
  FREE_ENTITLEMENTS,
  freeSnapshot,
  type EntitlementClaims,
  type EntitlementGraceState,
  type Entitlements,
  type EntitlementsSnapshot
} from '@contracts'
import { accessTokenForEntitlement, deviceBindingJkt, dpopProofForResource, setAccountLoginHook, setAccountLogoutHook } from './account'
import { vaultClearKey, vaultLoad, vaultStore } from './vault'

// The entitlement engine (ADR 0016, phase-accounts/05). An entitlement is a SIGNED
// CLAIM this process verifies LOCALLY — never a boolean the UI trusts, never a server
// answer taken at face value:
//
//   · the JWT's Ed25519 signature is checked against the PUBLIC KEY pinned in
//     src/backend/core/origins.ts (an in-code literal — never env, never fetched), so
//     a shipped build cannot be pointed at an attacker's signer;
//   · a tampered or wrong-signature token is treated as ABSENT (→ Free), never trusted;
//   · the verified claim is cached as vault ciphertext and honored through the
//     offline-grace window (ADR 0016 §4) past its last successful fetch, THEN the app
//     degrades to Free — quietly, fully working, never bricked;
//   · the claim is SENDER-CONSTRAINED to this machine (step 06): issuance rides a DPoP
//     proof signed by the hardware device key, the issuer binds `deviceId` to that
//     key's thumbprint, and this engine honors a claim only when its deviceId matches
//     THIS device — a copied install's cached claim reads as absent (→ Free), and it
//     cannot re-license because its refresh proofs sign with a different chip;
//   · every gated feature reads ONE port (the @backend holder, telemetry pattern);
//     claims cross IPC as a snapshot, the JWT and the tokens never do.
//
// Honesty (ADR 0016 §5): the LOCAL gates are UX — real teeth are the hardware binding
// above plus server-side value. On hardware-less machines (Linux today) the device key
// is the software fallback and the binding is only as strong as the vault (docs/18).
//
// Boot discipline (I7): registration wires IPC + the port and nothing else. The cache
// loads lazily on first read; the network refresh runs opportunistically AFTER the
// renderer mounts (its first snapshot pull), never on the boot path. In production
// there is no issuer wired yet (config === null, like account.ts), so no fetch can
// even start — the reserved `entitlements` origin lands in origins.ts when the
// service exists.

const VAULT_CACHE = 'entitlements.cache' // { jwt, fetchedAt } as safeStorage ciphertext

/** The offline-grace window past the last successful fetch (ADR 0016 §4 allows 7–30
 *  days; the shipped figure is fixed when the service ships). */
const GRACE_MS = 14 * 86_400_000

/** What the fetch talks to. Production: null until the operator wires the pinned
 *  `entitlements` origin — the smoke injects a FAKE issuer baseUrl + its fixture
 *  verify key as PARAMETERS (never the environment; ORIGINPIN). */
export interface EntitleConfig {
  baseUrl: string
  /** Fixture verify key override — SMOKE ONLY. Absent = the pinned production key. */
  verifyKeyPem?: string
}

interface CachedEntitlement {
  claims: EntitlementClaims
  jwt: string
  /** Epoch ms of the last SUCCESSFUL fetch — the grace anchor. */
  fetchedAt: number
}

let config: EntitleConfig | null = null
let winGetter: (() => BrowserWindow | null) | null = null
// undefined = not loaded yet (lazy); null = loaded, nothing valid at rest.
let cached: CachedEntitlement | null | undefined
let lastPushedJson = ''
// THIS device's key thumbprint (step 06) — the deviceId a claim must carry to be
// honored. Resolved lazily post-boot (the chip can be slow; I7): null = not known yet,
// and until it is, a cached claim is honored provisionally — the moment it resolves,
// a foreign-device claim degrades and the change is pushed.
let deviceJkt: string | null = null
let deviceJktResolving: Promise<string | null> | null = null
// The runtime tamper self-check's verdict (phase-accounts/07, src/main/native-preflight.ts).
// A modified build sets this true POST-PAINT (never on the boot path, I7); while it holds,
// PAID grants are withheld and the app runs as FREE — fully, never bricked (invariant I2).
// A patched fork can strip the check that sets it, so this is EVIDENCE + a revocation
// trigger, not prevention (docs/19-accounts.md).
let buildTampered = false
// Emit `entitlement.device_mismatch` exactly once per process — a boolean piracy signal,
// consent-gated by the Telemetry port (ADR 0005), never a path/id (the account is already
// known to the authed session).
let deviceMismatchReported = false
// The cache generation. Bumped whenever the cache is intentionally cleared (logout, a
// smoke reset). An in-flight fetch captures it before its network await and refuses to
// cache if it changed — otherwise a logout landing DURING the fetch's round-trip would
// be overwritten when the fetch resumes and re-vaults, resurrecting a Pro claim the user
// just signed out of (the "logout → anon-free" law, ADR 0016 / the product milestone).
let cacheEpoch = 0

// ── Test seams (production leaves all of them untouched) ────────────────────────────
let now: () => number = Date.now
export function setEntitleConfigForSmoke(cfg: EntitleConfig | null): void {
  config = cfg
}
export function setEntitleClockForSmoke(clock: (() => number) | null): void {
  now = clock ?? Date.now
}
export function resetEntitlementsForSmoke(): void {
  vaultClearKey(VAULT_CACHE)
  cached = undefined
  config = null
  now = Date.now
  lastPushedJson = ''
  deviceJkt = null
  deviceJktResolving = null
  buildTampered = false
  deviceMismatchReported = false
  cacheEpoch += 1 // any in-flight fetch predating the reset must not re-cache
}

/** The tamper self-check's write door (native-preflight.ts). Flipping it pushes a fresh
 *  snapshot so the renderer's plan UI degrades in step with the gated features. */
export function setBuildTampered(on: boolean): void {
  if (buildTampered === on) return
  buildTampered = on
  pushIfChanged()
}
export function isBuildTamperedForSmoke(): boolean {
  return buildTampered
}

// ── Local verification: the ONLY door claims come through ───────────────────────────
const b64urlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function verifyKeyObject(): KeyObject | null {
  try {
    return createPublicKey(config?.verifyKeyPem ?? ENTITLEMENT_VERIFY_PUBKEY.ed25519Pem)
  } catch {
    return null
  }
}

/** Verify signature + shape, or null. Expiry is deliberately NOT judged here: a cached
 *  claim past `exp` is still honored through grace — time is graceStateOf's job. */
export function verifyEntitlementJwt(jwt: string): EntitlementClaims | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  let header: { alg?: string; typ?: string }
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'))
    payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'))
  } catch {
    return null
  }
  // alg AND typ pinned (RFC 8725 token-type discipline): this verifier accepts exactly
  // our own token type, so no OTHER Ed25519-signed JWT that ever shares the pinned key
  // can be replayed as an entitlement. Pinned now, while no real claim exists to migrate.
  if (header.alg !== 'EdDSA' || header.typ !== 'entitle+jwt') return null
  const key = verifyKeyObject()
  if (!key) return null
  let ok = false
  try {
    // Ed25519 in node: algorithm null; the key decides.
    ok = verifySignature(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, b64urlToBuf(parts[2]))
  } catch {
    return null
  }
  if (!ok) return null
  // Shape: closed and typed, or the token is treated as absent.
  const plan = typeof payload.plan === 'string' && payload.plan ? payload.plan : null
  const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : null
  const iat = typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat : null
  const exp = typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null
  if (!plan || deviceId === null || iat === null || exp === null) return null
  const features = Array.isArray(payload.features) ? payload.features.filter((f): f is string => typeof f === 'string') : []
  const limits: Record<string, number> = {}
  if (payload.limits && typeof payload.limits === 'object') {
    for (const [k, v] of Object.entries(payload.limits as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) limits[k] = v
    }
  }
  // Forensic watermark + revocation (phase-accounts/07). All OPTIONAL and additive — a
  // pre-07 claim (no accountId, no wm) still verifies and is honored exactly as before.
  const accountId = typeof payload.accountId === 'string' ? payload.accountId : undefined
  const wmField = payload.watermark as { wm?: unknown; wmk?: unknown } | undefined
  const watermark =
    wmField && typeof wmField.wm === 'string' && Array.isArray(wmField.wmk) && wmField.wmk.every((t) => typeof t === 'string')
      ? { wm: wmField.wm, wmk: wmField.wmk as string[] }
      : undefined
  const revoked = payload.revoked === true
  return { plan, features, limits, deviceId, iat, exp, accountId, watermark, revoked }
}

// ── The cache + the grace law ────────────────────────────────────────────────────────
function loadCache(): CachedEntitlement | null {
  if (cached !== undefined) return cached
  cached = null
  const raw = vaultLoad(VAULT_CACHE)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { jwt?: unknown; fetchedAt?: unknown }
      if (typeof parsed.jwt === 'string' && typeof parsed.fetchedAt === 'number') {
        // Re-verified on EVERY load: ciphertext at rest does not exempt the claim from
        // the signature check — a tampered blob is absent, not trusted.
        const claims = verifyEntitlementJwt(parsed.jwt)
        if (claims) cached = { claims, jwt: parsed.jwt, fetchedAt: parsed.fetchedAt }
      }
    } catch {
      cached = null
    }
  }
  return cached
}

function graceStateOf(entry: CachedEntitlement): EntitlementGraceState {
  const t = now()
  // A fetch anchor from the FUTURE is a rolled-back clock (this engine only ever
  // writes fetchedAt = now()). Small skew — an NTP correction — is tolerated up to a
  // day; past that the anchor is not believed and the claim reads expired, otherwise
  // winding the clock back extends grace without bound. Recomputed on every read, so
  // a repaired clock (or the next successful fetch) restores the plan by itself.
  if (entry.fetchedAt - t > 86_400_000) return 'expired'
  // The law: honored up to GRACE past the last successful fetch, THEN Free — even a
  // long-lived exp does not outrun the window.
  if (t > entry.fetchedAt + GRACE_MS) return 'expired'
  if (t < entry.claims.exp * 1000) return 'fresh'
  return 'grace'
}

/** Resolve THIS device's key thumbprint, once. Async and off the boot path (I7);
 *  callers fire it exactly when there is a claim to check or a fetch to attest. */
async function ensureDeviceJkt(): Promise<string | null> {
  if (deviceJkt) return deviceJkt
  if (!deviceJktResolving) {
    deviceJktResolving = deviceBindingJkt()
      .then((jkt) => {
        deviceJkt = jkt
        // A cached claim from ANOTHER device degrades the moment the device is known.
        if (jkt) {
          reportDeviceMismatch()
          pushIfChanged()
        }
        return jkt
      })
      .catch((): string | null => null)
      .finally(() => {
        deviceJktResolving = null
      })
  }
  return deviceJktResolving
}

/** The step-06 sender-constraint, read-side: a claim issued to another device is
 *  ABSENT here — the copied-vault-on-new-hardware case reads as Free. */
const deviceMismatch = (entry: CachedEntitlement): boolean => deviceJkt !== null && entry.claims.deviceId !== deviceJkt

/** A cached claim landing on the wrong machine is a BOOLEAN piracy signal (ADR 0005):
 *  `entitlement.device_mismatch = true`. No path, no id, no filename — the account is
 *  already known to the authed session; this only says the copied-install case happened,
 *  so the operator can measure abuse RATE and revoke server-side. Consent-gated by the
 *  Telemetry port (Noop unless the user opted in). Emitted once per process. */
function reportDeviceMismatch(): void {
  if (deviceMismatchReported) return
  const entry = loadCache()
  if (!entry || !deviceMismatch(entry)) return
  deviceMismatchReported = true
  getTelemetry().captureEvent({ name: 'entitlement.device_mismatch', props: { mismatch: true } })
}

/** The one truth every consumer projects from. Degrading past grace yields the FREE
 *  snapshot — the answer is always total, never a throw, never a brick. Each degrade
 *  branch NAMES its cause (`reason`, a closed claims-only enum) so the account panel
 *  can say its one honest line (ADR 0016 §4) without a second source of truth. */
export function entitlementsSnapshot(): EntitlementsSnapshot {
  // A modified build withholds PAID grants: the answer is the generous FREE tier, so the
  // free app is untouched (invariant I2) while nothing paid is honored on a tampered fork.
  if (buildTampered) return freeSnapshot('expired', 'tampered')
  const entry = loadCache()
  if (!entry) return freeSnapshot()
  // Server-side revocation, honored on read: a validly-signed but revoked claim is Free.
  if (entry.claims.revoked) return freeSnapshot('expired', 'revoked')
  if (deviceMismatch(entry)) return freeSnapshot('expired', 'device_mismatch')
  const graceState = graceStateOf(entry)
  if (graceState === 'expired') return freeSnapshot('expired', 'grace_expired')
  return {
    plan: entry.claims.plan,
    // FEATURES are additive (set union over Free). LIMITS replace per name — the
    // "a plan can only widen" law (ADR 0016 §2) is the ISSUER's contract, deliberately
    // NOT clamped here: fixture claims must be able to carry numbers small enough for
    // the gates to visibly bite, and tiers are data, not client arithmetic.
    features: [...new Set([...FREE_ENTITLEMENTS.features, ...entry.claims.features])],
    limits: { ...FREE_ENTITLEMENTS.limits, ...entry.claims.limits },
    graceState
  }
}

// ── The port (installed into the @backend holder at registration) ───────────────────
const port: Entitlements = {
  allows: (feature) => entitlementsSnapshot().features.includes(feature),
  limit: (name) => entitlementsSnapshot().limits[name] ?? Number.POSITIVE_INFINITY,
  snapshot: () => entitlementsSnapshot()
}

function pushIfChanged(): void {
  const snap = entitlementsSnapshot()
  const json = JSON.stringify(snap)
  if (json === lastPushedJson) return
  lastPushedJson = json
  const win = winGetter?.()
  if (win && !win.isDestroyed()) win.webContents.send(EntitlementsChannels.changed, snap)
}

// ── Refresh: serialized, opportunistic, and incapable of bricking ────────────────────
let refreshing: Promise<boolean> | null = null
// Counts fetch RUN STARTS (deduped joins don't move it) — the login kick's yield signal.
let fetchSerial = 0

/** Fetch + verify + cache a fresh entitlement. Authn: the step-04 access token plus a
 *  DPoP proof bound to it (`ath`). EVERY failure — no config, anon, network pulled,
 *  5xx, tampered or stale token — resolves false and leaves the cached claim (and the
 *  grace clock) exactly as they were. */
export async function refreshEntitlements(): Promise<boolean> {
  if (!config) return false // production until the service ships: nothing to talk to
  if (refreshing) return refreshing
  fetchSerial += 1 // a real run starts (joins above don't count)
  const run = doFetch().finally(() => {
    refreshing = null
    pushIfChanged()
  })
  refreshing = run
  return run
}

async function doFetch(): Promise<boolean> {
  const cfg = config
  if (!cfg) return false
  const epoch = cacheEpoch // the session this fetch belongs to
  try {
    const token = await accessTokenForEntitlement()
    if (!token) return false // no session — the free core asks for nothing
    // Device attestation (step 06): the request's DPoP proof carries the device
    // PUBLIC key in its header — the issuer binds `deviceId` to its thumbprint.
    const thisDevice = await ensureDeviceJkt()
    if (!thisDevice) return false // no device key = nothing to bind to; refuse to cache
    const htu = `${cfg.baseUrl.replace(/\/$/, '')}/entitlement`
    const fetchOnce = async (nonce?: string): Promise<Response | null> => {
      const proof = await dpopProofForResource('GET', htu, token, nonce)
      if (!proof) return null
      return fetch(htu, {
        headers: { authorization: `DPoP ${token}`, dpop: proof, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000)
      })
    }
    let res = await fetchOnce()
    if (!res) return false
    // RFC 9449 §8.2: a resource server may demand its OWN nonce; it answers 401 with a
    // DPoP-Nonce header. Retry once, with it — without this, an issuer that turns the
    // nonce on strands every client at 401 until grace runs out. The FAKE issuer
    // enforces the dance so this path is live under every gate, never dead code.
    if (res.status === 401) {
      const nonce = res.headers.get('DPoP-Nonce')
      if (nonce) {
        const retry = await fetchOnce(nonce)
        if (!retry) return false
        res = retry
      }
    }
    if (res.status < 200 || res.status >= 300) return false
    const body = (await res.json()) as { entitlement?: unknown }
    const jwt = typeof body?.entitlement === 'string' ? body.entitlement : ''
    const claims = verifyEntitlementJwt(jwt)
    // Verified locally, and FRESH at fetch: an issuer handing out already-expired
    // claims is treated as handing out nothing.
    if (!claims || claims.exp * 1000 <= now()) return false
    // Sender-constrained, verified at the door: a claim issued to any OTHER device —
    // however validly signed — is not an entitlement here and never enters the cache.
    if (claims.deviceId !== thisDevice) return false
    // A logout that landed while we were awaiting the issuer wins: do NOT cache a claim
    // the user just signed out of. (The account-side epoch guards the token; this guards
    // the entitlement cache — logout bumps both.)
    if (epoch !== cacheEpoch) return false
    const fetchedAt = now()
    // Vault-unavailable machines still get a working session (memory-only claim);
    // nothing is ever written as plaintext (ADR 0008.h).
    vaultStore(VAULT_CACHE, JSON.stringify({ jwt, fetchedAt }))
    cached = { claims, jwt, fetchedAt }
    return true
  } catch {
    return false // pulling the network must never brick — grace math carries on
  }
}

/** Post-paint opportunism: refresh when the claim is missing, aging past fresh, or
 *  within six hours of `exp`. Called from the snapshot pull (the renderer's mount),
 *  never from boot. */
function maybeBackgroundRefresh(): void {
  if (!config) return
  const entry = loadCache()
  const staleish = !entry || graceStateOf(entry) !== 'fresh' || entry.claims.exp * 1000 - now() < 6 * 3_600_000
  if (staleish) void refreshEntitlements()
}

/** Explicit user LOGOUT drops the cached claim: the machine returns to anon-FREE in one
 *  gesture (the product-milestone law). Only logout — a session that dies under us
 *  (revoked refresh, foreign hardware) leaves the cache for the device-mismatch story. */
function clearOnLogout(): void {
  cacheEpoch += 1 // an in-flight fetch that predates this logout must not re-cache
  vaultClearKey(VAULT_CACHE)
  cached = null
  pushIfChanged()
}

/** A fresh LOGIN asks the issuer for its plan soon. Two halves. The epoch bump is
 *  SYNCHRONOUS: an in-flight fetch for the PREVIOUS session must not cache over the
 *  new one. The fetch itself is a decoupled FALLBACK kick, one second later, that
 *  YIELDS to any fetch that started since login (the serial check) — deliberately not
 *  part of the login callstack: the entitlement service may be a beat behind the login
 *  (an outage ending, a checkout still propagating), and a kick racing the very next
 *  caller would hand it a doomed just-started run through the dedup (refreshEntitlements
 *  returns the in-flight promise). Without any kick at all, the plan a user just paid
 *  for waited for the next app restart — the renderer-mount pull was the only trigger. */
function refreshOnLogin(): void {
  cacheEpoch += 1
  const serialAtLogin = fetchSerial
  const kick = setTimeout(() => {
    if (fetchSerial !== serialAtLogin) return // something already fetched for this session — yield
    const stale = refreshing
    if (stale) void stale.finally(() => void refreshEntitlements())
    else void refreshEntitlements()
  }, 1_000)
  kick.unref?.()
}

/** The steady-state cadence (the updater's own 6-hour pattern). A desktop app lives
 *  open for weeks: with "refresh on renderer mount" as the only trigger, a Pro claim
 *  aged straight through grace into Free on a machine that was ONLINE the whole time,
 *  and a grace boundary crossed by pure time never pushed (renderer and gates briefly
 *  told different stories). Each tick re-derives the snapshot (pushIfChanged covers
 *  boundary crossings without a fetch) and refreshes opportunistically when the claim
 *  is stale-ish. Anon or unwired builds: the guards make it a no-op, zero network. */
const CADENCE_MS = 6 * 3_600_000
let cadence: NodeJS.Timeout | null = null

// ── Registration: IPC + the port. No fetch, no cache read — boot stays clean (I7). ──
export function registerEntitlements(getWin: () => BrowserWindow | null): void {
  winGetter = getWin
  setEntitlements(port)
  setAccountLogoutHook(clearOnLogout)
  setAccountLoginHook(refreshOnLogin)
  ipcMain.handle(EntitlementsChannels.snapshot, () => {
    const snap = entitlementsSnapshot()
    lastPushedJson = JSON.stringify(snap) // the pull IS the sync point; push only future diffs
    // Post-paint, and only when a claim exists to check: learn THIS device's key so a
    // copied cache degrades. Async by law (I7) — the provisional snapshot stands until
    // the chip answers, then pushIfChanged corrects it.
    if (loadCache()) void ensureDeviceJkt()
    maybeBackgroundRefresh()
    return snap
  })
  if (!cadence) {
    cadence = setInterval(() => {
      pushIfChanged()
      maybeBackgroundRefresh()
    }, CADENCE_MS)
    cadence.unref?.() // a cadence must never hold a teardown (or a windowless gate) open
  }
}

// ── Smoke-only helpers (claims only — no JWT, no token, ever) ────────────────────────
export function cachedDeviceIdForSmoke(): string | null {
  return loadCache()?.claims.deviceId ?? null
}
/** The forensic watermark bound into the cached activation, if any — the operator-trace
 *  input (phase-accounts/07). Carriers + the account id only; never the JWT or a token. */
export function activationWatermarkForSmoke(): { accountId?: string; wm?: string; wmk?: string[] } | null {
  const claims = loadCache()?.claims
  if (!claims) return null
  return { accountId: claims.accountId, wm: claims.watermark?.wm, wmk: claims.watermark?.wmk }
}
/** Force the next read to re-open the vault slot (proves persistence, not memory).
 *  Drops the resolved device binding too — the whole in-memory world, so the
 *  DEVICEKEY smoke can impersonate a fresh process on different hardware. */
export function dropMemoryCacheForSmoke(): void {
  cached = undefined
  deviceJkt = null
  deviceJktResolving = null
}
/** Resolve (and return) THIS device's binding — lets the smoke await the exact
 *  post-boot resolution production runs opportunistically. */
export function ensureDeviceJktForSmoke(): Promise<string | null> {
  return ensureDeviceJkt()
}
