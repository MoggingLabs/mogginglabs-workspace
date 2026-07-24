import { app, shell, type BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpPreset, ProviderEntry } from '@contracts'
import { chooserMethods, groupToolCards, mergeToolCards, planHasServerForCli } from '@contracts'
import { MCP_PRESETS, injectProviderEntryForSmoke, saveServer, type GrantKv } from '@backend/features/integrations'
import { connect, listConnections, submitKey, sweepConnections, verifyConnection, setAccountNote } from '../connections'
import { listServers } from '../mcp-manager'
import { serviceKeyNames } from '../service-keys'
import { getToolPlan } from '../integrations'
import { getSettingsStore } from '../app-settings'

// Env-gated LIVE tool-cards smoke (MOGGING_TOOLCARDS, phase-tools/05). Boots the REAL
// app, drives the tool-card grid + detail on the real Settings page against local
// fixtures — zero external network, zero real accounts.
//
//   (a) ONE CARD  — a service connected through the app AND carried CLI-owned renders
//       a single card node (merge key = catalog service id), with the other route's
//       fact on the same card.
//   (b) STATUS    — the tag reads `✓ Connected · verified {n}m ago` from the status
//       engine's stamp, and flips to `Needs attention` when the fixture revokes.
//   (c) CHOOSER   — exactly the catalog's methods, rank order, ADR 0020 strings
//       verbatim, custody subtitles in fine print; the no-DCR fixture's client form
//       renders the catalog's setupGuideUrl as a real door.
//   (d) SCOPES    — humanized titles render, the raw scope rides the title attribute,
//       and a granted-but-uncataloged scope falls back to its raw string, never hidden.
//   (e) SCOPING   — the detail's workspace checkbox mutates the plan (planGet is the
//       same truth the matrix renders).
//   (f) COMING SOON — Codex/Gemini rows are disabled with ZERO handlers: a dispatched
//       click invokes nothing and changes nothing.
//
// MUTATION-RED ×2, proven LIVE on every pass (the pure-knob pattern):
//   · mergeToolCards `_testBreakMergeKey` — a broken merge key splits the dual-route
//     service into two rows, exactly what (a)'s single-node assert catches;
//   · chooserMethods `_testBreakRank`   — broken ordering reverses the methods,
//     exactly what (c)'s rank assert catches.

const b64url = (s: Buffer | string): string =>
  (typeof s === 'string' ? Buffer.from(s) : s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256b64url = (s: string): string => b64url(createHash('sha256').update(s).digest())

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => resolve(s))
  })
}
const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

let origin = ''
const S = { challenge: null as string | null, revoke: new Set<string>() }

function mcpAnswer(req: IncomingMessage, res: ServerResponse, body: string, name: string, requireBearer: boolean): void {
  if (S.revoke.has(name)) {
    res.writeHead(401).end() // the REVOKE flip: the provider itself refuses the credential
    return
  }
  if (requireBearer && !/^Bearer .+/.test(String(req.headers.authorization ?? ''))) {
    res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/prm/${name}"` }).end()
    return
  }
  let msg: { id?: number; method?: string }
  try {
    msg = JSON.parse(body)
  } catch {
    sendJson(res, 400, {})
    return
  }
  if (msg.method === 'initialize') {
    sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: `Cards-${name}` }, capabilities: { tools: {} } } })
    return
  }
  if (msg.method === 'notifications/initialized') {
    res.writeHead(202).end()
    return
  }
  if (msg.method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', inputSchema: {} }] } })
    return
  }
  sendJson(res, 200, { jsonrpc: '2.0', id: msg.id ?? null, result: { content: [] } })
}

function startFixture(): Promise<{ close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const body = req.method === 'POST' ? await readBody(req) : ''
        const p = url.pathname
        const svc = /^\/svc\/([a-z]+)$/.exec(p)?.[1]
        if (svc) return mcpAnswer(req, res, body, svc, false)
        if (p === '/oauth-mcp') return mcpAnswer(req, res, body, 'oauth', true)
        if (p === '/nodcr-mcp') return mcpAnswer(req, res, body, 'nodcr', true)
        if (p === '/prm/oauth') return sendJson(res, 200, { resource: `${origin}/oauth-mcp`, authorization_servers: [`${origin}/as`], scopes_supported: ['mcp:use', 'read:things', 'weird:custom'] })
        if (p === '/prm/nodcr') return sendJson(res, 200, { resource: `${origin}/nodcr-mcp`, authorization_servers: [`${origin}/as2`], scopes_supported: ['mcp:use'] })
        if (p === '/.well-known/oauth-authorization-server/as') {
          return sendJson(res, 200, {
            issuer: `${origin}/as`,
            authorization_endpoint: `${origin}/as/authorize`,
            token_endpoint: `${origin}/as/token`,
            registration_endpoint: `${origin}/as/register`,
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['mcp:use', 'read:things', 'weird:custom']
          })
        }
        // The NO-DCR sign-in server: no registration_endpoint — connect() lands on the
        // client-id form, where the setup link must render.
        if (p === '/.well-known/oauth-authorization-server/as2') {
          return sendJson(res, 200, {
            issuer: `${origin}/as2`,
            authorization_endpoint: `${origin}/as2/authorize`,
            token_endpoint: `${origin}/as2/token`,
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['mcp:use']
          })
        }
        if (p === '/as/register' && req.method === 'POST') return sendJson(res, 201, { client_id: 'client-cards' })
        if (p === '/as/authorize') {
          const q = url.searchParams
          if (q.get('client_id') !== 'client-cards' || !q.get('code_challenge') || !q.get('state')) return sendJson(res, 400, { error: 'invalid_request' })
          S.challenge = q.get('code_challenge')
          res.writeHead(302, { location: `${q.get('redirect_uri')}?code=code-${randomBytes(6).toString('hex')}&state=${q.get('state')}` }).end()
          return
        }
        if (p === '/as/token' && req.method === 'POST') {
          const form = new URLSearchParams(body)
          if (form.get('client_id') !== 'client-cards') return sendJson(res, 400, { error: 'invalid_client' })
          if (sha256b64url(form.get('code_verifier') ?? '') !== S.challenge) return sendJson(res, 400, { error: 'invalid_grant' })
          return sendJson(res, 200, { access_token: `at-${randomBytes(4).toString('hex')}`, expires_in: 3600, scope: 'mcp:use read:things weird:custom', token_type: 'bearer' })
        }
        sendJson(res, 404, {})
      })()
    })
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve({ close: () => server.close() })
    })
  })
}

export function runToolCardsSmoke(win: BrowserWindow): void {
  const safety = setTimeout(() => app.exit(1), 220000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (js: string, tries = 24, gap = 250): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }

  let result: Record<string, unknown> = { pass: false }
  let fixture: { close: () => void } | null = null

  const origOpen = shell.openExternal.bind(shell)
  shell.openExternal = async (authorizeUrl: string): Promise<void> => {
    // Only the fixture AS's consent is driven; a setup-guide link never navigates.
    if (!authorizeUrl.includes('/as/authorize')) return
    const loc = (await fetch(authorizeUrl, { redirect: 'manual' })).headers.get('location')
    if (loc) await fetch(loc)
  }

  const run = async (): Promise<void> => {
    try {
      fixture = await startFixture()
      const mk = (id: string, path: string, authKinds: McpPreset['authKinds']): McpPreset => ({
        id,
        label: id,
        transport: 'http',
        urlOrCommand: `${origin}${path}`,
        authKinds,
        envRefSlots: [],
        cliQuirks: {},
        grantCopy: 'Fixture for the TOOLCARDS gate.',
        verifiedAt: '2026-07-24'
      })
      ;(MCP_PRESETS as McpPreset[]).push(
        mk('cards-dual', '/svc/dual', ['none']),
        mk('cards-live', '/svc/live', ['none']),
        mk('cards-oauth', '/oauth-mcp', ['oauth']),
        mk('cards-nodcr', '/nodcr-mcp', ['oauth']),
        { ...mk('cards-choose', '/svc/choose', ['oauth', 'token']), envRefSlots: ['CARDS_KEY'] },
        mk('cards-fama', '/svc/fama', ['none']),
        mk('cards-famb', '/svc/famb', ['none'])
      )
      // The FAMILY (2026-07-24): two capabilities of one product — the grid must
      // fold them into ONE card whose members render in the fold.
      for (const id of ['cards-fama', 'cards-famb']) {
        injectProviderEntryForSmoke({
          id,
          label: id,
          source: 'fixture://toolcards',
          group: 'cards-fam',
          mcp: { transport: 'http', url: `${origin}/svc/${id.slice(6)}` },
          methods: [{ key: 'cli-owned', kind: 'cliOwned', name: 'Let Claude Code sign in itself (advanced)', rank: 90 }]
        } as ProviderEntry)
      }
      const CHOOSE_ENTRY: ProviderEntry = {
        id: 'cards-choose',
        label: 'cards-choose',
        source: 'fixture://toolcards',
        mcp: { transport: 'http', url: `${origin}/svc/choose` },
        methods: [
          { key: 'browser', kind: 'oauth', name: 'Sign in with your browser', rank: 1 },
          { key: 'api-key', kind: 'apiKey', name: 'Paste an API key', rank: 2, inputs: [{ key: 'CARDS_KEY', label: 'Cards key', secret: true }] },
          { key: 'cli-owned', kind: 'cliOwned', name: 'Let Claude Code sign in itself (advanced)', rank: 90 }
        ]
      } as ProviderEntry
      injectProviderEntryForSmoke(CHOOSE_ENTRY)
      injectProviderEntryForSmoke({
        id: 'cards-nodcr',
        label: 'cards-nodcr',
        source: 'fixture://toolcards',
        setupGuideUrl: 'https://example.test/create-your-client',
        mcp: { transport: 'http', url: `${origin}/nodcr-mcp` },
        methods: [
          { key: 'browser', kind: 'oauth', name: 'Sign in with your browser', rank: 1 },
          { key: 'cli-owned', kind: 'cliOwned', name: 'Let Claude Code sign in itself (advanced)', rank: 90 }
        ]
      } as ProviderEntry)
      injectProviderEntryForSmoke({
        id: 'cards-oauth',
        label: 'cards-oauth',
        source: 'fixture://toolcards',
        mcp: { transport: 'http', url: `${origin}/oauth-mcp` },
        methods: [
          {
            key: 'browser',
            kind: 'oauth',
            name: 'Sign in with your browser',
            rank: 1,
            scopes: [
              { scope: 'mcp:use', title: 'Use tools' },
              { scope: 'read:things', title: 'Read things' }
            ]
          },
          { key: 'cli-owned', kind: 'cliOwned', name: 'Let Claude Code sign in itself (advanced)', rank: 90 }
        ]
      } as ProviderEntry)

      // ── Connect the fixtures ─────────────────────────────────────────────────
      for (const id of ['cards-dual', 'cards-live', 'cards-fama']) {
        const r = await connect(id)
        if (!r.ok) throw new Error(`connect ${id} refused: ${r.reason}`)
      }
      const oauth = await connect('cards-oauth')
      if (!oauth.ok) throw new Error(`connect cards-oauth refused: ${oauth.reason}`)
      await sleep(800)
      await connect('cards-nodcr') // lands on needsClientId (no DCR at as2) — expected
      setAccountNote('cards-choose', 'kept for the chooser') // "known" → inventory card
      // The DUAL route: the same id also carried CLI-owned (a direct-URL row, not
      // our bridge). One tool, one card — that is (a)'s whole claim.
      const store = getSettingsStore()
      if (!store) throw new Error('settings store not ready')
      const kv: GrantKv = { get: (k) => store.getSetting(k), set: (k, v) => store.setSetting(k, v) }
      const saved = saveServer(kv, { id: 'cards-dual', label: 'cards-dual', transport: 'http', url: `${origin}/svc/dual` })
      if (!saved.ok) throw new Error(`saveServer refused: ${saved.reason}`)
      await verifyConnection('cards-live', 'manual')
      await verifyConnection('cards-dual', 'manual')

      // ── Onto the real page ──────────────────────────────────────────────────
      await ES(`window.__mogging.workspace.create({ name: 'Alpha' })`)
      await sleep(900)
      const wsId = (await ES<{ id: string }>(`window.__mogging.workspace.active()`)).id
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(500)
      await ES(`(document.querySelector('.settings-nav-item[data-target="integrations"]')?.click(), 1)`)
      await sleep(1500)

      // (a) ONE card for the dual-route service, with the other route's fact on it.
      const oneCardOk = await waitTrue(
        `document.querySelectorAll('.conn-card[data-connection="cards-dual"]').length === 1 &&
         !!document.querySelector('.conn-card[data-connection="cards-dual"] .conn-route-cli')`
      )
      // Mutation-red 1: a broken merge key splits it — the assert above would red.
      const rowsNormal = mergeToolCards(listConnections(), listServers(), null)
      const rowsMutated = mergeToolCards(listConnections(), listServers(), null, { _testBreakMergeKey: true })
      const mutationMergeRed =
        rowsNormal.filter((r) => r.id === 'cards-dual').length === 1 &&
        rowsMutated.filter((r) => r.id === 'cards-dual').length === 2

      // (b) the tag tracks verifiedAt, then flips when the provider revokes.
      const tagVerifiedOk = await waitTrue(
        `/^✓ Connected · verified \\d+m ago$/.test(document.querySelector('.conn-card[data-connection="cards-live"] .conn-chip')?.textContent ?? '')`
      )
      S.revoke.add('live')
      await sweepConnections('heartbeat', { cursor: 0 })
      await sleep(600)
      const tagFlippedOk = await waitTrue(
        `(document.querySelector('.conn-card[data-connection="cards-live"] .conn-chip')?.textContent ?? '') === 'Needs attention'`
      )
      S.revoke.delete('live')
      // Recovery, so (e) meets a CONNECTED card again (the scope toggle lives there).
      await verifyConnection('cards-live', 'manual')
      await sleep(800)

      // (c) the chooser: exactly the catalog's methods, rank order, ADR verbatim.
      const chooserOk = await waitTrue(`(() => {
        const card = document.querySelector('.conn-card[data-connection="cards-choose"]')
        if (!card) return false
        const rows = [...card.querySelectorAll('.conn-method:not(.is-coming-soon)')]
        const labels = rows.map((r) => r.querySelector('.conn-method-label')?.textContent)
        const subs = rows.map((r) => r.querySelector('.conn-method-sub')?.textContent ?? '')
        const fold = card.querySelector('.conn-advanced-summary')?.textContent
        return labels.length === 2 &&
          labels[0] === 'Sign in with your browser' &&
          labels[1] === 'Paste an API key' &&
          subs[0].includes('never written into any CLI config') &&
          subs[1].includes('referenced as ' + String.fromCharCode(36) + '{NAME}') &&
          fold === 'Let Claude Code sign in itself (advanced)'
      })()`)
      // Mutation-red 2: broken rank ordering reverses the methods.
      const ranked = chooserMethods(CHOOSE_ENTRY).map((m) => m.kind)
      const rankedMutated = chooserMethods(CHOOSE_ENTRY, { _testBreakRank: true }).map((m) => m.kind)
      const mutationRankRed = ranked[0] === 'oauth' && rankedMutated[0] === 'cliOwned'
      // The no-DCR fixture: the client form renders the catalog's setup guide as a door.
      await ES(`(() => {
        const card = document.querySelector('.conn-card[data-connection="cards-nodcr"]')
        const add = [...(card?.querySelectorAll('button') ?? [])].find((b) => /Add client ID/.test(b.textContent ?? ''))
        add?.click()
        return 1
      })()`)
      await sleep(500)
      const setupLinkOk = await waitTrue(
        `/Create your client here/.test(document.querySelector('.conn-card[data-connection="cards-nodcr"] .conn-setup-link')?.textContent ?? '')`
      )

      // (d) humanized scopes: titles render, raw rides the title attr, unknown falls back.
      const scopesOk = await waitTrue(`(() => {
        const spans = [...document.querySelectorAll('.conn-card[data-connection="cards-oauth"] .conn-scope')]
        if (spans.length !== 3) return false
        const texts = spans.map((s) => s.textContent)
        const titles = spans.map((s) => s.getAttribute('title'))
        return texts[0] === 'Use tools' && titles[0] === 'mcp:use' &&
          texts[1] === 'Read things' && titles[1] === 'read:things' &&
          texts[2] === 'weird:custom' && titles[2] === 'weird:custom' &&
          spans[2].classList.contains('is-raw')
      })()`)

      // (e) the detail's workspace checkbox mutates the plan the matrix renders.
      await ES(`(() => {
        const card = document.querySelector('.conn-card[data-connection="cards-live"]')
        const t = card?.querySelector('.conn-scope-toggle')
        if (t instanceof HTMLElement) t.click()
        return 1
      })()`)
      await sleep(700)
      await ES(`(() => {
        const box = document.querySelector('.conn-card[data-connection="cards-live"] .conn-scope-check')
        if (box instanceof HTMLInputElement && !box.checked) box.click()
        return 1
      })()`)
      await sleep(1200)
      const plan = getToolPlan(wsId)
      const scopingOk = planHasServerForCli(plan, 'cards-live', 'claude-code') && planHasServerForCli(plan, 'cards-live', 'codex')

      // (g) THE FAMILY: one product card, members whole in the fold; broken group
      // key = two cards (the mutation this layer exists to kill).
      const familyOneCardOk = await waitTrue(`(() => {
        const fams = document.querySelectorAll('.conn-family-card[data-group="cards-fam"]')
        const loose = document.querySelectorAll('.conn-group-grid > .conn-card[data-connection="cards-fama"], .conn-group-grid > .conn-card[data-connection="cards-famb"]')
        const chip = fams[0]?.querySelector('.conn-chip')?.textContent ?? ''
        return fams.length === 1 && loose.length === 0 && chip.startsWith('✓ Connected')
      })()`)
      await ES(`(document.querySelector('.conn-family-card[data-group="cards-fam"] .conn-family-toggle')?.click(), 1)`)
      const familyMembersOk = await waitTrue(`(() => {
        const list = document.querySelector('.conn-family-card[data-group="cards-fam"] .conn-family-members')
        return !!list && list.querySelectorAll('.conn-card[data-connection]').length === 2
      })()`)
      const famRows = mergeToolCards(listConnections(), listServers(), null).filter((r) => r.id.startsWith('cards-fam'))
      const famGroupOf = (id: string): string | undefined => (id.startsWith('cards-fam') ? 'cards-fam' : undefined)
      const mutationGroupRed =
        groupToolCards(famRows, famGroupOf).length === 1 &&
        groupToolCards(famRows, famGroupOf, { _testBreakGroupKey: true }).length === 2

      // (f) coming-soon rows: disabled, zero handlers — a dispatched click changes nothing.
      const serversBefore = listServers().length
      const planBefore = JSON.stringify(getToolPlan(wsId))
      const comingSoonOk = await ES<boolean>(`(() => {
        const card = document.querySelector('.conn-card[data-connection="cards-choose"]')
        const fold = card?.querySelector('.conn-advanced')
        if (fold instanceof HTMLDetailsElement) fold.open = true
        const rows = [...(card?.querySelectorAll('.conn-method.is-coming-soon') ?? [])]
        if (rows.length !== 2) return false
        if (!rows.every((r) => r instanceof HTMLButtonElement && r.disabled)) return false
        for (const r of rows) r.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return /Codex — coming soon/.test(rows[0].textContent ?? '') && /Gemini — coming soon/.test(rows[1].textContent ?? '')
      })()`)
      await sleep(600)
      const nothingInvokedOk = listServers().length === serversBefore && JSON.stringify(getToolPlan(wsId)) === planBefore

      // (h) ONE PASTE, EVERY ROUTE: a key that connects the app route also lands in
      // the catalog's env slot, so the CLI-owned ${CARDS_KEY} reads saved. (Runs
      // LAST — connecting cards-choose retires the chooser the earlier asserts read.)
      const keyConn = await submitKey('cards-choose', 'key-anything')
      const dualVaultOk = keyConn.ok && serviceKeyNames().includes('CARDS_KEY')

      result = {
        pass:
          oneCardOk &&
          mutationMergeRed &&
          tagVerifiedOk &&
          tagFlippedOk &&
          chooserOk &&
          mutationRankRed &&
          setupLinkOk &&
          scopesOk &&
          scopingOk &&
          comingSoonOk &&
          nothingInvokedOk &&
          familyOneCardOk &&
          familyMembersOk &&
          mutationGroupRed &&
          dualVaultOk,
        familyOneCardOk,
        familyMembersOk,
        mutationGroupRed,
        dualVaultOk,
        oneCardOk,
        mutationMergeRed,
        tagVerifiedOk,
        tagFlippedOk,
        chooserOk,
        mutationRankRed,
        setupLinkOk,
        scopesOk,
        scopingOk,
        comingSoonOk,
        nothingInvokedOk
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    shell.openExternal = origOpen
    try {
      fixture?.close()
    } catch {
      /* already closing */
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'toolcards-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    clearTimeout(safety)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
