// LIVE device-flow check (RFC 8628) — the one you run yourself, against the real
// provider, to answer "does this actually work?" with real bytes.
//
//   MOGGING_OAUTH_CLIENT_GITHUB_COM=<your client id> npm run check:device-flow-live
//
// This is NOT a gate. It talks to github.com, it needs you to click Approve, and
// it is deliberately absent from qa-smokes.sh: a sweep that depends on a human
// and a network is a sweep that goes red for reasons that are not the product.
// The hermetic proof is DEVICEFLOW (scripts/device-flow-pure-smoke.ts); this is
// the end-to-end confirmation that the fixture told the truth about the vendor.
//
// It drives the SAME functions the app calls — requestDeviceCode + pollDeviceToken
// out of src/backend/features/integrations/oauth.ts — so a pass here is evidence
// about the shipped code path, not about a script that resembles it.
//
// What it prints, in order:
//   1. the user code + the URL          (what the card shows you)
//   2. the poll ladder, live            (pending… pending… granted)
//   3. WHOSE account the token is for   (api.github.com/user)
//   4. the SCOPES the grant carries     (the x-oauth-scopes response header)
//
// Step 4 is the one that matters beyond "the flow works": it is the direct
// answer to whether this grant could clone your private repos.
//
// Nothing is written anywhere. The token lives in this process and dies with it —
// no vault, no keychain, no file. Run it, read it, forget it.

import { requestDeviceCode, pollDeviceToken, type AuthServerMetadata } from '@backend/features/integrations'
import { firstPartyClientEnvName, firstPartyClientFor, type OAuthClientRecord } from '@contracts'

const GITHUB_ISSUER = 'https://github.com/login/oauth'
const DEVICE_ENDPOINT = 'https://github.com/login/device/code'

const metadata: AuthServerMetadata = {
  issuer: GITHUB_ISSUER,
  authorization_endpoint: 'https://github.com/login/oauth/authorize',
  token_endpoint: 'https://github.com/login/oauth/access_token'
}

// The scopes GitHub's own MCP resource declares (RFC 9728) — the same list the
// app asks for. `repo` is the one that decides whether this grant can clone.
const SCOPES = ['repo', 'read:org', 'read:user', 'user:email', 'gist', 'workflow']

const line = (s = ''): void => console.log(s)
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`

async function main(): Promise<void> {
  const envName = firstPartyClientEnvName(GITHUB_ISSUER)
  const resolved = firstPartyClientFor(GITHUB_ISSUER, process.env)
  if (!resolved) {
    line(red('No GitHub client id to test with.'))
    line()
    line(`Set ${bold(envName)} to an OAuth App client id, then re-run:`)
    line()
    line(dim(`  ${envName}=Ov23li... npm run check:device-flow-live`))
    line()
    line('Use the client id from the OAuth App you already registered — the SAME one')
    line('you pasted into the card. You do not need the client secret: the device')
    line('flow does not use one. The app must have ' + bold('"Enable Device Flow"') + ' ticked')
    line('at ' + dim('https://github.com/settings/developers') + ' › your app.')
    process.exit(2)
  }

  const client: OAuthClientRecord = {
    authServer: GITHUB_ISSUER,
    clientId: resolved.clientId,
    registeredAt: Date.now(),
    source: 'first-party'
  }
  line(`${bold('Client id')}  ${resolved.clientId.slice(0, 8)}… ${dim(`(from ${resolved.registeredIn})`)}`)
  line(`${bold('Asking')}     ${DEVICE_ENDPOINT}`)
  line(`${bold('Scopes')}     ${SCOPES.join(' ')}`)
  line()

  // ── 1. The device code ────────────────────────────────────────────────────
  const asked = await requestDeviceCode({ endpoint: DEVICE_ENDPOINT, clientId: client.clientId, scopes: SCOPES })
  if (!asked.ok) {
    if (asked.deviceFlowDisabled) {
      line(yellow('DEVICE FLOW IS TURNED OFF for this OAuth App.'))
      line()
      line('This is the default for a new GitHub OAuth App, and it is a one-tick fix:')
      line(`  1. ${dim('https://github.com/settings/developers')} › your app`)
      line(`  2. tick ${bold('"Enable Device Flow"')} › Update application`)
      line('  3. re-run this check')
      line()
      line(dim('In the app itself this is not an error: the connect flow falls back to the'))
      line(dim('browser redirect flow, so the card still connects — just not in one step.'))
      process.exit(3)
    }
    line(red(`Could not start the device flow: ${asked.reason}`))
    process.exit(1)
  }

  const g = asked.grant
  line('─'.repeat(58))
  line(`  Go to   ${bold(g.verificationUri)}`)
  line(`  Enter   ${bold(green(g.userCode))}`)
  line('─'.repeat(58))
  line(dim(`  (this is exactly what the connection card now shows you)`))
  line(dim(`  code expires in ${Math.round((g.expiresAt - Date.now()) / 60000)} min · polling every ${g.intervalMs / 1000}s`))
  line()

  // ── 2. The poll ladder, narrated ──────────────────────────────────────────
  let polls = 0
  const started = Date.now()
  const polled = await pollDeviceToken(metadata, client, g, {
    sleep: (ms) =>
      new Promise((r) =>
        setTimeout(() => {
          polls++
          process.stdout.write(dim(`  poll ${polls} (waited ${ms / 1000}s)…\r`))
          r()
        }, ms)
      )
  })
  process.stdout.write(' '.repeat(50) + '\r')

  if (!polled.ok) {
    if (polled.denied) line(red('You declined the sign-in. Nothing was granted — which is the correct outcome for a decline.'))
    else if (polled.expired) line(yellow('The code expired before it was approved. Re-run to get a fresh one.'))
    else line(red(`Sign-in failed: ${polled.reason}`))
    process.exit(1)
  }
  line(green(`GRANTED after ${polls} poll(s), ${Math.round((Date.now() - started) / 1000)}s.`))
  line()

  // ── 3 + 4. Whose account, and what the grant can actually do ──────────────
  const token = polled.tokens.accessToken
  const res = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
  })
  if (!res.ok) {
    line(red(`The token was refused by api.github.com (${res.status}) — the flow worked, but the grant is not usable.`))
    process.exit(1)
  }
  const who = (await res.json()) as { login?: string; name?: string }
  // GitHub reports the grant's real scopes in a response header — the provider's
  // own answer, not our echo of what we asked for.
  const granted = res.headers.get('x-oauth-scopes') ?? '(none reported)'
  line(`${bold('Account')}    ${who.login ?? '?'}${who.name ? ` (${who.name})` : ''}`)
  line(`${bold('Scopes')}     ${granted}`)
  line(`${bold('Token')}      ${token.slice(0, 7)}… ${dim(`(${token.length} chars, not stored anywhere)`)}`)
  line()

  const canClone = /(^|,\s*)repo(,|$)/.test(granted)
  line(canClone ? green('This grant carries `repo` — it could clone your private repositories.') : yellow('This grant has no `repo` scope — it could not clone private repositories.'))
  line()
  line(green('Device flow verified end to end against the real provider.'))
}

void main().catch((e) => {
  console.error(red(`CHECK ERROR: ${e instanceof Error ? e.message : String(e)}`))
  process.exit(1)
})
