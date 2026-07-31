// The device-flow (RFC 8628) regression suite — pure, hermetic, no Electron.
//
//   npm run smoke:device-flow-pure          (qa-smokes gate: DEVICEFLOW)
//
// This is the gate on the ONE-BUTTON on-ramp: the flow that lets a card say
// "Connect" and mean it, with no client id to paste, no client secret to copy,
// and no redirect URI for a vendor console to reject. A local FIXTURE
// authorization server drives the REAL client code
// (src/backend/features/integrations/oauth.ts + client-registry.ts +
// contracts/integrations/first-party-clients.ts). Nothing here touches the
// network beyond 127.0.0.1.
//
// Every assertion is regression-shaped — each encodes a rule that failed
// silently when broken, or would have:
//
//   · GITHUB'S 200. GitHub answers `authorization_pending` with HTTP **200**,
//     not RFC 6749's 400. A status-only error check reads that as SUCCESS, hands
//     the body to the token normalizer, and reports "the provider returned no
//     access token" on a flow that is merely waiting for the user to click
//     Approve. This is the single most likely way this feature breaks, and D2
//     is the mutation-red that proves the body-first check is load-bearing.
//   · `slow_down` IS NOT A FAILURE. It means "you polled too fast" — the RFC
//     says add five seconds and keep going. Treating it as terminal aborts a
//     sign-in the user is mid-approving.
//   · A SHIPPED CLIENT IS NEVER PERSISTED. It is app data; storing it would let
//     a stale keychain record pin a client id we have since revoked.
//   · AN EMPTY SHIPPED ID IS INERT. The table ships half-filled on purpose, and
//     a blank entry must fall through to today's behaviour, never hand out "".
import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import { AddressInfo } from 'node:net'
import {
  pollDeviceToken,
  requestDeviceCode,
  resolveClient,
  type AuthServerMetadata,
  type ClientStore
} from '@backend/features/integrations'
import { firstPartyClientEnvName, firstPartyClientFor, type OAuthClientRecord } from '@contracts'

// ── Harness ──────────────────────────────────────────────────────────────────
const failures: string[] = []
let passes = 0
function check(ok: unknown, name: string): void {
  if (ok) {
    passes++
  } else {
    failures.push(name)
    console.error(`  FAIL  ${name}`)
  }
}
const watchdog = setTimeout(() => {
  console.error('WATCHDOG: suite exceeded 60s — failing hard')
  process.exit(1)
}, 60_000)

/** Never a real wait: the poll ladder is asserted in milliseconds, not minutes.
 *  Records what the flow ASKED to wait, which is how the slow_down backoff is
 *  proven rather than assumed. */
function fakeClock(): { sleep: (ms: number) => Promise<void>; waits: number[]; now: () => number; advance: (ms: number) => void } {
  const waits: number[] = []
  let t = 1_000_000
  return {
    waits,
    sleep: (ms: number) => {
      waits.push(ms)
      t += ms // a slept interval moves the clock, or the deadline never arrives
      return Promise.resolve()
    },
    now: () => t,
    advance: (ms: number) => {
      t += ms
    }
  }
}

const memStore = (): ClientStore & { saved: OAuthClientRecord[] } => {
  const map = new Map<string, OAuthClientRecord>()
  const saved: OAuthClientRecord[] = []
  return {
    saved,
    load: (issuer) => map.get(issuer) ?? null,
    save: (issuer, record) => {
      map.set(issuer, record)
      saved.push(record)
      return true
    },
    clear: (issuer) => void map.delete(issuer)
  }
}

// ── The fixture authorization server ─────────────────────────────────────────
// One server, several scripted device flows selected by the client_id, so each
// provider quirk gets its own lane without a server per test.

interface Fixture {
  origin: string
  close: () => void
  /** Token-endpoint hits per device_code — the "did it stop polling?" evidence. */
  polls: Map<string, number>
  deviceCodeRequests: number
}

function startFixture(): Promise<Fixture> {
  const polls = new Map<string, number>()
  const state = { deviceCodeRequests: 0 }

  const read = (req: IncomingMessage): Promise<URLSearchParams> =>
    new Promise((resolve) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => resolve(new URLSearchParams(body)))
    })

  const server = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const form = req.method === 'POST' ? await read(req) : new URLSearchParams()
      const send = (status: number, body: unknown, contentType = 'application/json'): void => {
        const text = typeof body === 'string' ? body : JSON.stringify(body)
        res.writeHead(status, { 'content-type': contentType }).end(text)
      }

      if (url.pathname === '/device/code') {
        state.deviceCodeRequests++
        const clientId = form.get('client_id') ?? ''
        if (clientId === 'unknown-client') {
          // GitHub's shape for a client id it has never seen.
          send(404, { error: 'Not Found' })
          return
        }
        if (clientId === 'device-off') {
          // GitHub ships OAuth Apps with "Enable Device Flow" UNCHECKED — this is
          // the most likely real-world answer the first time a real client id is
          // pointed at this code, and it must NOT read as a broken client.
          send(200, { error: 'device_flow_disabled', error_description: 'Device Flow has not been enabled for this app.' })
          return
        }
        if (clientId === 'google-shape') {
          // Google spells it `verification_url`, and offers the pre-filled variant.
          send(200, {
            device_code: `dc-${clientId}`,
            user_code: 'GOOG-1234',
            verification_url: `${origin()}/activate`,
            verification_uri_complete: `${origin()}/activate?code=GOOG-1234`,
            expires_in: 900,
            interval: 5
          })
          return
        }
        send(200, {
          device_code: `dc-${clientId}`,
          user_code: 'WXYZ-1234',
          verification_uri: `${origin()}/activate`,
          expires_in: 900,
          // A deliberately small interval so the ladder's arithmetic is legible.
          interval: 2
        })
        return
      }

      if (url.pathname === '/token') {
        const deviceCode = form.get('device_code') ?? ''
        const n = (polls.get(deviceCode) ?? 0) + 1
        polls.set(deviceCode, n)
        const clientId = form.get('client_id') ?? ''

        // THE GITHUB LANE: `authorization_pending` at HTTP 200, twice, then a
        // `slow_down` at 200, then the grant. Every hop is a 200 — a status-only
        // reader sees four successes and zero tokens.
        if (clientId === 'github-shape') {
          if (n <= 2) return send(200, { error: 'authorization_pending' })
          if (n === 3) return send(200, { error: 'slow_down' })
          return send(200, { access_token: 'gho_fixture', token_type: 'bearer', scope: 'repo read:org' })
        }
        // FORM-ENCODED: GitHub without an Accept header. Same meaning, other wire.
        if (clientId === 'form-shape') {
          if (n <= 1) return send(200, 'error=authorization_pending', 'application/x-www-form-urlencoded')
          return send(200, 'access_token=form_tok&token_type=bearer', 'application/x-www-form-urlencoded')
        }
        if (clientId === 'deny-shape') return send(400, { error: 'access_denied' })
        if (clientId === 'expire-shape') return send(400, { error: 'expired_token' })
        if (clientId === 'weird-shape') return send(400, { error: 'invalid_grant', error_description: 'the fixture refuses' })
        if (clientId === 'cancel-shape') return send(200, { error: 'authorization_pending' })
        // RFC-correct lane: 400s, as the spec mandates.
        if (n <= 1) return send(400, { error: 'authorization_pending' })
        return send(200, { access_token: 'rfc_tok', token_type: 'Bearer', expires_in: 3600 })
      }

      res.writeHead(404).end()
    })()
  })

  let origin = (): string => ''
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      origin = () => `http://127.0.0.1:${port}`
      resolve({
        origin: origin(),
        close: () => server.close(),
        polls,
        get deviceCodeRequests() {
          return state.deviceCodeRequests
        }
      } as Fixture)
    })
  })
}

const metaFor = (origin: string): AuthServerMetadata => ({
  issuer: `${origin}/as`,
  authorization_endpoint: `${origin}/authorize`,
  token_endpoint: `${origin}/token`
})

const clientFor = (clientId: string, issuer: string): OAuthClientRecord => ({
  authServer: issuer,
  clientId,
  registeredAt: 0,
  source: 'first-party'
})

async function main(): Promise<void> {
  const fx = await startFixture()
  const metadata = metaFor(fx.origin)
  const deviceEndpoint = `${fx.origin}/device/code`

  // ── D1 — the device-code request, normalized ───────────────────────────────
  const asked = await requestDeviceCode({ endpoint: deviceEndpoint, clientId: 'github-shape', scopes: ['repo', 'read:org'] })
  check(asked.ok, 'D1 a device-code request succeeds')
  if (!asked.ok) return finish(fx)
  check(asked.grant.userCode === 'WXYZ-1234', 'D1 the user code is carried verbatim')
  check(asked.grant.verificationUri.endsWith('/activate'), 'D1 the verification URI is carried')
  check(asked.grant.intervalMs === 2000, 'D1 the interval is normalized to milliseconds')
  check(asked.grant.expiresAt > Date.now(), 'D1 expiry is an absolute stamp, not a duration')

  // ── D2 — THE GITHUB REGRESSION: pending/slow_down delivered at HTTP 200 ────
  // If parseTokenError is ever moved back behind an `if (!res.ok)`, this is the
  // assertion that goes red — the poll would read the first 200 as a token
  // response and fail with "returned no access token" instead of waiting.
  const ghClock = fakeClock()
  const gh = await pollDeviceToken(metadata, clientFor('github-shape', metadata.issuer), asked.grant, {
    sleep: ghClock.sleep,
    now: ghClock.now
  })
  check(gh.ok, 'D2 a GitHub-shaped flow (errors at HTTP 200) reaches the grant')
  check(gh.ok && gh.tokens.accessToken === 'gho_fixture', 'D2 the access token survives the 200-error lane')
  check(gh.ok && gh.tokens.scopes?.includes('repo') === true, 'D2 the granted scopes are normalized off the token response')
  check(fx.polls.get('dc-github-shape') === 4, 'D2 it polled exactly until the grant landed (2 pending + 1 slow_down + 1 grant)')

  // ── D3 — slow_down backs off by 5s and KEEPS GOING ────────────────────────
  // waits: [2000, 2000, 2000, 7000] — the fourth poll is the slowed one.
  check(ghClock.waits.length === 4, 'D3 one wait precedes every poll')
  check(ghClock.waits.slice(0, 3).every((w) => w === 2000), 'D3 the declared interval is honoured before slow_down')
  check(ghClock.waits[3] === 7000, 'D3 slow_down adds exactly 5s to the interval (RFC 8628 §3.5)')

  // ── D4 — the form-encoded wire ────────────────────────────────────────────
  const formAsked = await requestDeviceCode({ endpoint: deviceEndpoint, clientId: 'form-shape' })
  check(formAsked.ok, 'D4 a device-code request for the form lane succeeds')
  if (formAsked.ok) {
    const clock = fakeClock()
    const out = await pollDeviceToken(metadata, clientFor('form-shape', metadata.issuer), formAsked.grant, {
      sleep: clock.sleep,
      now: clock.now
    })
    check(out.ok && out.tokens.accessToken === 'form_tok', 'D4 a form-encoded pending+grant pair is read correctly')
  }

  // ── D5 — the three terminal answers, each distinguishable ─────────────────
  const denied = await runLane(fx, metadata, 'deny-shape', deviceEndpoint)
  check(!denied.ok && denied.denied === true, 'D5 access_denied reports denied (not a generic error)')
  check(!denied.ok && /declined/i.test(denied.reason), 'D5 the denied sentence says the user declined')

  const expired = await runLane(fx, metadata, 'expire-shape', deviceEndpoint)
  check(!expired.ok && expired.expired === true, 'D5 expired_token reports expired')

  const weird = await runLane(fx, metadata, 'weird-shape', deviceEndpoint)
  check(!weird.ok && !weird.denied && !weird.expired, 'D5 an unknown error code is a plain failure')
  check(!weird.ok && /fixture refuses/.test(weird.reason), "D5 an unknown failure surfaces the provider's own description")
  check(fx.polls.get('dc-weird-shape') === 1, 'D5 an unknown error stops polling immediately (never loops to expiry)')

  // ── D6 — the LOCAL deadline: expiry costs zero requests ───────────────────
  const stale = await requestDeviceCode({ endpoint: deviceEndpoint, clientId: 'rfc-shape' })
  if (stale.ok) {
    const clock = fakeClock()
    const before = fx.polls.get('dc-rfc-shape') ?? 0
    const out = await pollDeviceToken(
      metadata,
      clientFor('rfc-shape', metadata.issuer),
      { ...stale.grant, expiresAt: clock.now() - 1 },
      { sleep: clock.sleep, now: clock.now }
    )
    check(!out.ok && out.expired === true, 'D6 a code already past its deadline reports expired')
    check((fx.polls.get('dc-rfc-shape') ?? 0) === before, 'D6 an expired deadline makes ZERO requests')
    check(clock.waits.length === 0, 'D6 …and does not even sleep first')
  }

  // ── D7 — Cancel stops the loop, and stops the traffic ─────────────────────
  const cancelAsked = await requestDeviceCode({ endpoint: deviceEndpoint, clientId: 'cancel-shape' })
  if (cancelAsked.ok) {
    const clock = fakeClock()
    let polled = 0
    const out = await pollDeviceToken(metadata, clientFor('cancel-shape', metadata.issuer), cancelAsked.grant, {
      sleep: clock.sleep,
      now: clock.now,
      // Cancel arrives after the second poll — the card's Cancel button, in effect.
      shouldStop: () => ++polled > 5
    })
    check(!out.ok && out.cancelled === true, 'D7 a cancelled flow reports cancelled (not denied, not expired)')
    const at = fx.polls.get('dc-cancel-shape') ?? 0
    check(at > 0 && at < 5, 'D7 a cancelled flow stops making requests')
  }

  // ── D8 — a client id the provider does not know is OUR bug, said plainly ──
  const unknown = await requestDeviceCode({ endpoint: deviceEndpoint, clientId: 'unknown-client' })
  check(!unknown.ok, 'D8 an unregistered client id fails the device-code request')
  check(!unknown.ok && /configuration problem on our side/.test(unknown.reason), 'D8 …and blames US, not the user')
  check(!unknown.ok && !/paste|client id/i.test(unknown.reason.replace(/client id[^.]*our side/i, '')), 'D8 …and never asks the user to paste anything')

  // ── D8b — device flow switched OFF at the vendor is DISTINGUISHABLE ───────
  // The caller keys its fallback (to the browser redirect flow) off this exact
  // flag. If it ever collapses into a generic failure, a user whose OAuth App has
  // the toggle unchecked stops being able to connect AT ALL — a strictly worse
  // outcome than before the device flow existed. That is what this pins.
  const off = await requestDeviceCode({ endpoint: deviceEndpoint, clientId: 'device-off' })
  check(!off.ok && off.deviceFlowDisabled === true, 'D8b device_flow_disabled is flagged, not folded into a generic failure')
  check(!off.ok && /Enable Device Flow/i.test(off.reason), 'D8b …and the sentence names the exact one-tick fix')
  check(!off.ok && !/configuration problem on our side/.test(off.reason), 'D8b …and does not misblame it as our bundle bug')

  // ── D9 — Google's `verification_url` spelling ─────────────────────────────
  const goog = await requestDeviceCode({ endpoint: deviceEndpoint, clientId: 'google-shape' })
  check(goog.ok && goog.grant.verificationUri.endsWith('/activate'), 'D9 the `verification_url` spelling is accepted')
  check(goog.ok && !!goog.grant.verificationUriComplete, 'D9 verification_uri_complete is carried when offered')

  // ── D10 — the shipped-client table ────────────────────────────────────────
  const GH_ISSUER = 'https://github.com/login/oauth'
  check(firstPartyClientEnvName(GH_ISSUER) === 'MOGGING_OAUTH_CLIENT_GITHUB_COM', 'D10 the env override name is derived from the issuer host')
  // The table ships with an EMPTY GitHub id until the OAuth app is registered.
  // An empty entry must be inert — never handed out as a client id of "".
  const shippedNow = firstPartyClientFor(GH_ISSUER, {})
  check(shippedNow === null || shippedNow.clientId.length > 0, 'D10 an empty shipped entry is inert (never a blank client id)')
  const overridden = firstPartyClientFor(GH_ISSUER, { MOGGING_OAUTH_CLIENT_GITHUB_COM: 'Ov23liOVERRIDE' })
  check(overridden?.clientId === 'Ov23liOVERRIDE', 'D10 an env override supplies the client id')
  const novel = firstPartyClientFor('https://example.test/as', { MOGGING_OAUTH_CLIENT_EXAMPLE_TEST: 'xyz' })
  check(novel?.clientId === 'xyz', 'D10 an override works for an issuer with no table row (forks, self-hosting)')
  check(firstPartyClientFor('https://example.test/as', {}) === null, 'D10 …and without one, an unknown issuer has no client')
  check(firstPartyClientFor('', {}) === null, 'D10 an empty issuer never resolves a client')

  // ── D11 — the resolveClient ladder, and the never-persist rule ────────────
  const store = memStore()
  const shippedIssuerMeta: AuthServerMetadata = {
    // A registration endpoint EXISTS here: the shipped client must still win, or
    // the rung ordering is wrong and GitHub would DCR into a client we cannot vouch for.
    issuer: 'https://example.test/as',
    authorization_endpoint: `${fx.origin}/authorize`,
    token_endpoint: `${fx.origin}/token`,
    registration_endpoint: `${fx.origin}/register`
  }
  const resolved = await resolveClient(shippedIssuerMeta, 'http://127.0.0.1:1/callback', store, {
    env: { MOGGING_OAUTH_CLIENT_EXAMPLE_TEST: 'shipped-id' }
  })
  check(resolved.ok && resolved.client.clientId === 'shipped-id', 'D11 a shipped client beats dynamic registration')
  check(resolved.ok && resolved.client.source === 'first-party', 'D11 …and is labelled first-party')
  check(resolved.ok && resolved.client.clientSecret === undefined, 'D11 …and carries NO secret, structurally')
  check(store.saved.length === 0, 'D11 a shipped client is NEVER written to the client store')

  // A STORED record still outranks the shipped one — a user who pasted their own
  // client keeps it, and an app update cannot silently switch them off it.
  const store2 = memStore()
  store2.save('https://example.test/as', { authServer: 'https://example.test/as', clientId: 'user-pasted', registeredAt: 1, source: 'user' })
  const resolved2 = await resolveClient(shippedIssuerMeta, 'http://127.0.0.1:1/callback', store2, {
    env: { MOGGING_OAUTH_CLIENT_EXAMPLE_TEST: 'shipped-id' }
  })
  check(resolved2.ok && resolved2.client.clientId === 'user-pasted', "D11 a stored record still outranks the shipped client (the user's paste wins)")

  finish(fx)
}

async function runLane(
  fx: Fixture,
  metadata: AuthServerMetadata,
  clientId: string,
  endpoint: string
): Promise<{ ok: boolean; reason: string; denied?: boolean; expired?: boolean; cancelled?: boolean }> {
  const asked = await requestDeviceCode({ endpoint, clientId })
  if (!asked.ok) return { ok: false, reason: asked.reason }
  const clock = fakeClock()
  const out = await pollDeviceToken(metadata, clientFor(clientId, metadata.issuer), asked.grant, {
    sleep: clock.sleep,
    now: clock.now
  })
  return out.ok ? { ok: true, reason: '' } : out
}

function finish(fx: Fixture): void {
  fx.close()
  clearTimeout(watchdog)
  console.log(`\ndevice-flow-pure: ${passes} passed, ${failures.length} failed`)
  if (failures.length) {
    console.error('FAILED:\n' + failures.map((f) => `  · ${f}`).join('\n'))
    process.exit(1)
  }
}

void main().catch((e) => {
  console.error('SUITE ERROR:', e)
  process.exit(1)
})
