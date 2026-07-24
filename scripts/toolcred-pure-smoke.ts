// The credential-core regression suite (ADR 0020, phase-tools/02) — pure,
// hermetic, no Electron. qa-smokes gate: TOOLCRED.
//
//   npm run smoke:toolcred-pure
//
// A local FIXTURE token endpoint + verification endpoint drive the REAL
// credential core (src/backend/features/integrations/credential-core.ts).
// Every assertion is survey-shaped — each encodes a failure one of the studied
// projects hit, or a race ADR 0014 predicted:
//
//   (a) normalization at exchange: a GitHub-shaped FORM-ENCODED token response
//       (`refresh_token_expires_in` and all) becomes the canonical credential,
//       with the catalog buffer applied and NO raw field leaking past the seam;
//   (b) concurrent demand: two racing refreshes make exactly ONE token request —
//       the waiter re-reads and gets the winner's credentials (the lock);
//   (c) the freshness margin: a token inside the margin refreshes, one outside
//       does not (injected clock);
//   (d) failure cooldown: a refused refresh is not re-asked within the window;
//   (e) a non-rotating provider (refresh response without a refresh_token)
//       KEEPS the old refresh token;
//   (f) prove-before-save: the catalog verification probe refuses a bad key on
//       the provider's own 401 — and never mistakes an outage for a refusal;
//   (g) catalog retry grammar: retryable codes ('5xx' families), epoch-stamp vs
//       delta-seconds delay headers, and the cap.
//
// MUTATION-REDS (proven on every run, not once): the same scenarios re-run with
// (b') the lock disabled — the double-refresh MUST manifest, proving the count
// assertion bites; and (a') the pre-seam JSON-only parser — it MUST fail to read
// the form body, proving the seam is load-bearing, not decorative.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  RefreshCoordinator,
  mergeRefreshedCredential,
  normalizeTokenResponse,
  retryDelayMs,
  retryableStatus,
  runVerificationProbe
} from '../src/backend/features/integrations/credential-core'
import type { CanonicalCredential } from '../src/contracts/integrations/credential'

let failures = 0
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── The fixture provider ──────────────────────────────────────────────────────
let tokenCalls = 0
let tokenMode: 'github-form' | 'rotating' | 'non-rotating' | 'refuse' = 'github-form'
let tokenDelayMs = 0
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/token') {
    tokenCalls++
    const answer = (): void => {
      if (tokenMode === 'refuse') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token revoked' }))
        return
      }
      if (tokenMode === 'github-form') {
        // GitHub's exact shape: form-encoded, refresh_token_expires_in, bearer.
        res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' })
        res.end(
          new URLSearchParams({
            access_token: `gat_${tokenCalls}`,
            expires_in: '28800',
            refresh_token: `grt_${tokenCalls}`,
            refresh_token_expires_in: '15897600',
            scope: 'repo,gist',
            token_type: 'bearer'
          }).toString()
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          access_token: `at_${tokenCalls}`,
          token_type: 'Bearer',
          expires_in: 3600,
          ...(tokenMode === 'rotating' ? { refresh_token: `rt_${tokenCalls}` } : {})
        })
      )
    }
    setTimeout(answer, tokenDelayMs)
    return
  }
  if (url.pathname === '/verify') {
    const auth = req.headers.authorization ?? ''
    res.writeHead(auth === 'Bearer good-key' ? 200 : 401, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }
  res.writeHead(404).end()
})

const fetchToken = async (base: string): Promise<{ text: string; contentType: string | null }> => {
  const res = await fetch(`${base}/token`, { method: 'POST' })
  return { text: await res.text(), contentType: res.headers.get('content-type') }
}

/** A vault stand-in: the coordinator's load/store window. */
const makeVault = (initial: CanonicalCredential | null): { get(): CanonicalCredential | null; set(c: CanonicalCredential): boolean; writes: number } => {
  let cur = initial
  const v = {
    writes: 0,
    get: () => cur,
    set: (c: CanonicalCredential) => {
      v.writes++
      cur = c
      return true
    }
  }
  return v
}

const refreshViaFixture =
  (base: string, prev: () => CanonicalCredential) =>
  async (): Promise<{ ok: true; credential: CanonicalCredential } | { ok: false; reason: string }> => {
    const { text, contentType } = await fetchToken(base)
    const n = normalizeTokenResponse(text, contentType)
    if (!n.ok) return { ok: false, reason: n.reason }
    return { ok: true, credential: mergeRefreshedCredential(prev(), n.credential) }
  }

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // ── (a) Normalization at exchange: GitHub-shaped, form-encoded ─────────────
  console.log('(a) normalization at exchange')
  tokenMode = 'github-form'
  const t0 = Date.now()
  const { text: formBody, contentType } = await fetchToken(base)
  const norm = normalizeTokenResponse(formBody, contentType, { quirks: { tokenExpirationBuffer: 300 }, now: t0, method: 'browser' })
  check('form-encoded response parses', norm.ok)
  if (norm.ok) {
    const c = norm.credential
    check('access token landed', c.accessToken === 'gat_1')
    check('expires_in → expiresAt with catalog buffer', c.expiresAt === t0 + 28_800_000 - 300_000)
    check('refresh_token_expires_in → refreshTokenExpiresAt', c.refreshTokenExpiresAt === t0 + 15_897_600_000)
    check('comma-separated scope split', JSON.stringify(c.scopes) === JSON.stringify(['repo', 'gist']))
    check('tokenType + obtainedAt + method stamped', c.tokenType === 'bearer' && c.obtainedAt === t0 && c.method === 'browser')
    const CANONICAL = new Set(['accessToken', 'expiresAt', 'refreshToken', 'refreshTokenExpiresAt', 'scopes', 'tokenType', 'obtainedAt', 'method'])
    const leaked = Object.keys(c).filter((k) => !CANONICAL.has(k))
    check('no raw field leaks past the seam', leaked.length === 0, `leaked: ${leaked.join(',')}`)
  }
  // (a') MUTATION-RED: the pre-seam parser (JSON.parse only) must FAIL this body.
  let oldParserSurvives = true
  try {
    const j = JSON.parse(formBody) as { access_token?: string }
    oldParserSurvives = !!j.access_token
  } catch {
    oldParserSurvives = false
  }
  check("mutation-red (a'): the JSON-only parser cannot read this exchange — the seam bites", !oldParserSurvives)

  // ── (b) Concurrent demand: one token request, waiter gets winner's creds ──
  console.log('(b) concurrent refresh demand')
  tokenMode = 'rotating'
  tokenDelayMs = 150
  tokenCalls = 0
  {
    const now = Date.now()
    const vault = makeVault({ accessToken: 'stale', refreshToken: 'rt_old', expiresAt: now + 1000, tokenType: 'Bearer', obtainedAt: now - 3600_000 })
    const coord = new RefreshCoordinator()
    const deps = { load: vault.get, refresh: refreshViaFixture(base, () => vault.get()!), store: vault.set }
    const [r1, r2] = await Promise.all([coord.current('svc', deps), coord.current('svc', deps)])
    check('exactly ONE token request at the fixture', tokenCalls === 1, `saw ${tokenCalls}`)
    check('both demands succeeded', r1.ok && r2.ok)
    if (r1.ok && r2.ok) check("waiter got the winner's credentials", r1.credential.accessToken === 'at_1' && r2.credential.accessToken === 'at_1')
    check('exactly one vault write', vault.writes === 1, `saw ${vault.writes}`)
  }
  // (b') MUTATION-RED: lock disabled → the double-refresh MUST manifest.
  tokenCalls = 0
  {
    const now = Date.now()
    const vault = makeVault({ accessToken: 'stale', refreshToken: 'rt_old', expiresAt: now + 1000, tokenType: 'Bearer', obtainedAt: now - 3600_000 })
    const coord = new RefreshCoordinator({ _testDisableLock: true })
    const deps = { load: vault.get, refresh: refreshViaFixture(base, () => vault.get()!), store: vault.set }
    await Promise.all([coord.current('svc', deps), coord.current('svc', deps)])
    check("mutation-red (b'): without the lock the fixture sees the double-refresh — the count assertion bites", tokenCalls === 2, `saw ${tokenCalls}`)
  }
  tokenDelayMs = 0

  // ── (c) The freshness margin ────────────────────────────────────────────────
  console.log('(c) freshness margin')
  tokenMode = 'rotating'
  {
    let clock = Date.now()
    const coord = new RefreshCoordinator()
    tokenCalls = 0
    const outside = makeVault({ accessToken: 'live', refreshToken: 'rt', expiresAt: clock + 65_000, tokenType: 'Bearer', obtainedAt: clock })
    const r = await coord.current('svc-c1', { load: outside.get, refresh: refreshViaFixture(base, () => outside.get()!), store: outside.set, now: () => clock })
    check('outside the margin: no refresh', r.ok && !('refreshed' in r ? r.refreshed : true) && tokenCalls === 0)
    clock += 10_000 // now 55s to expiry — inside the 60s margin
    const r2 = await coord.current('svc-c1', { load: outside.get, refresh: refreshViaFixture(base, () => outside.get()!), store: outside.set, now: () => clock })
    check('inside the margin: refreshes', r2.ok && tokenCalls === 1, `calls ${tokenCalls}`)
  }

  // ── (d) Failure cooldown ────────────────────────────────────────────────────
  console.log('(d) failure cooldown')
  tokenMode = 'refuse'
  {
    let clock = Date.now()
    const coord = new RefreshCoordinator({ cooldownMs: 5 * 60_000 })
    tokenCalls = 0
    const vault = makeVault({ accessToken: 'stale', refreshToken: 'rt', expiresAt: clock + 1000, tokenType: 'Bearer', obtainedAt: clock - 1 })
    const first = await coord.current('svc-d', { load: vault.get, refresh: refreshViaFixture(base, () => vault.get()!), store: vault.set, now: () => clock })
    check('refusal reported', !first.ok && tokenCalls === 1)
    const second = await coord.current('svc-d', { load: vault.get, refresh: refreshViaFixture(base, () => vault.get()!), store: vault.set, now: () => clock })
    check('cooldown suppresses the next attempt (no fixture call)', !second.ok && !!(second as { cooled?: boolean }).cooled && tokenCalls === 1, `calls ${tokenCalls}`)
    clock += 5 * 60_000 + 1
    await coord.current('svc-d', { load: vault.get, refresh: refreshViaFixture(base, () => vault.get()!), store: vault.set, now: () => clock })
    check('cooldown expires — the retry runs', tokenCalls === 2, `calls ${tokenCalls}`)
    coord.reset('svc-d')
  }

  // ── (e) Non-rotating provider keeps the old refresh token ─────────────────
  console.log('(e) non-rotating refresh')
  tokenMode = 'non-rotating'
  {
    const now = Date.now()
    const coord = new RefreshCoordinator()
    const vault = makeVault({ accessToken: 'stale', refreshToken: 'rt_keep_me', expiresAt: now + 1000, tokenType: 'Bearer', obtainedAt: now - 1 })
    const r = await coord.current('svc-e', { load: vault.get, refresh: refreshViaFixture(base, () => vault.get()!), store: vault.set })
    check('refresh succeeded without a new refresh token', r.ok)
    check('the OLD refresh token was kept', vault.get()?.refreshToken === 'rt_keep_me', `got ${vault.get()?.refreshToken}`)
  }

  // ── (f) Prove-before-save: the catalog verification probe ─────────────────
  console.log('(f) catalog verification probe')
  {
    const spec = { method: 'GET' as const, endpoint: `${base}/verify` }
    const bad = await runVerificationProbe(spec, 'bad-key')
    check("a bad key is REFUSED on the provider's own 401", !bad.ok && bad.unauthorized === true)
    const good = await runVerificationProbe(spec, 'good-key')
    check('a good key passes', good.ok)
    const outage = await runVerificationProbe({ method: 'GET', endpoint: 'http://127.0.0.1:9/verify' }, 'any', { timeoutMs: 500 })
    check('an outage is NOT a refusal (falls through, never eats the key)', !outage.ok && !outage.unauthorized)
  }

  // ── (g) Catalog retry grammar ──────────────────────────────────────────────
  console.log('(g) retry grammar')
  {
    const spec = { atHeader: 'x-ratelimit-reset', errorCodes: ['403', '429', '5xx'] }
    check('5xx family matches', retryableStatus(503, spec) && retryableStatus(500, spec))
    check('listed code matches, unlisted does not', retryableStatus(403, spec) && !retryableStatus(404, spec))
    const now = Date.now()
    const epoch = { get: (n: string) => (n === 'x-ratelimit-reset' ? String(Math.round(now / 1000) + 3) : null) }
    const d1 = retryDelayMs(epoch, spec, 0, now)
    check('epoch-stamp header → delta ms (capped)', d1 > 1000 && d1 <= 5000, `got ${d1}`)
    const delta = { get: (n: string) => (n === 'retry-after' ? '2' : null) }
    const d2 = retryDelayMs(delta, { atHeader: 'retry-after' }, 0, now)
    check('delta-seconds header honored', d2 === 2000, `got ${d2}`)
    const d3 = retryDelayMs({ get: () => null }, spec, 0, now)
    check('no header → bounded backoff', d3 === 400)
  }

  server.close()
  if (failures) {
    console.error(`TOOLCRED: ${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('TOOLCRED: credential core holds — normalization, lock, margin, cooldown, rotation, prove-before-save, retry grammar (mutation-reds proven live)')
}

main().catch((e) => {
  console.error('TOOLCRED: crashed', e)
  server.close()
  process.exit(1)
})
