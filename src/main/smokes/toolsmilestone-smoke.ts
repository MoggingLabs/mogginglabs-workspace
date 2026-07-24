import { app, shell, type BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { McpPreset, ProviderEntry } from '@contracts'
import { planHasServerForCli } from '@contracts'
import { MCP_PRESETS, injectProviderEntryForSmoke, saveServer, type GrantKv } from '@backend/features/integrations'
import { driftStatsForSmoke, listConnections, submitKey, verifyConnection, verifyStatsForSmoke } from '../connections'
import { mgrApply, mgrBackups } from '../mcp-manager'
import { refreshStatus } from '../mcp-status'
import { getToolPlan } from '../integrations'
import { materializeToolPlanAtLaunch } from '../tool-plan'
import { getSettingsStore } from '../app-settings'

// THE COMPOSED MILESTONE (MOGGING_TOOLSMILESTONE, phase-tools/07): one walk of the
// WHOLE tool-first promise on fixtures — every arrow an assert, zero external network,
// a sandboxed CLI home (the isolation law), and a red/green bracket on the wording
// assert. The steps' own gates carry the mutation-reds; this gate proves they COMPOSE:
//
//   fresh profile → Integrations speaks tools only (banned list vs LIVE DOM text,
//   red-bracketed) → connect the GitHub-shaped fixture via "Sign in with your
//   browser" → the card flips ✓ Connected and earns its verified-ago stamp → the
//   identity email lands, sourced 'rest' → a note lands on an identity-less tool →
//   the detail scopes it into a workspace → a launch there verifies pre-launch
//   within budget and the pane env carries the tool → the fixture breaks → the
//   app-wide badge raises within one accelerated beat → recovery clears it → Fix
//   repairs a hand-broken Claude Code config (preview shown, backup created,
//   byte-identical) → disconnect deletes the credential and the card returns to
//   Not connected with the note surviving.

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
const S = { challenge: null as string | null, revoked: false }

function mcp(req: IncomingMessage, res: ServerResponse, body: string, name: string, requireBearer: boolean): void {
  if (name === 'gh' && S.revoked) {
    res.writeHead(401).end()
    return
  }
  if (requireBearer && !/^Bearer .+/.test(String(req.headers.authorization ?? ''))) {
    res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/prm"` }).end()
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
    sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: `MS-${name}` }, capabilities: { tools: {} } } })
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
        if (p === '/gh-mcp') return mcp(req, res, body, 'gh', true)
        if (p === '/plain-mcp') return mcp(req, res, body, 'plain', true)
        if (p === '/user') {
          if (!/^Bearer .+/.test(String(req.headers.authorization ?? ''))) return sendJson(res, 401, {})
          return sendJson(res, 200, { id: 7, email: 'dev@fixture.test', login: 'devlogin' })
        }
        if (p === '/prm') return sendJson(res, 200, { resource: `${origin}/gh-mcp`, authorization_servers: [`${origin}/as`], scopes_supported: ['mcp:use'] })
        if (p === '/.well-known/oauth-authorization-server/as') {
          return sendJson(res, 200, {
            issuer: `${origin}/as`,
            authorization_endpoint: `${origin}/as/authorize`,
            token_endpoint: `${origin}/as/token`,
            registration_endpoint: `${origin}/as/register`,
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['mcp:use']
          })
        }
        if (p === '/as/register' && req.method === 'POST') return sendJson(res, 201, { client_id: 'client-ms' })
        if (p === '/as/authorize') {
          const q = url.searchParams
          if (q.get('client_id') !== 'client-ms' || !q.get('code_challenge') || !q.get('state')) return sendJson(res, 400, { error: 'invalid_request' })
          S.challenge = q.get('code_challenge')
          res.writeHead(302, { location: `${q.get('redirect_uri')}?code=code-${randomBytes(6).toString('hex')}&state=${q.get('state')}` }).end()
          return
        }
        if (p === '/as/token' && req.method === 'POST') {
          const form = new URLSearchParams(body)
          if (form.get('client_id') !== 'client-ms') return sendJson(res, 400, { error: 'invalid_client' })
          if (sha256b64url(form.get('code_verifier') ?? '') !== S.challenge) return sendJson(res, 400, { error: 'invalid_grant' })
          return sendJson(res, 200, { access_token: `at-${randomBytes(4).toString('hex')}`, expires_in: 3600, scope: 'mcp:use', token_type: 'bearer' })
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

export function runToolsMilestoneSmoke(win: BrowserWindow): void {
  const safety = setTimeout(() => app.exit(1), 220000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const stateOf = (id: string) => listConnections().find((c) => c.id === id)
  const waitFor = async (test: () => boolean, tries = 30, gap = 300): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (test()) return true
      await sleep(gap)
    }
    return test()
  }
  const waitTrue = async (js: string, tries = 30, gap = 300): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }
  // The grid repaints on every heartbeat push, and a card's async fill leaves a
  // window where a just-rebuilt block has no buttons yet — so every click RETRIES
  // until it lands on a live node (first success stops the loop).
  const clickWhenReady = (selector: string, tries = 30, gap = 300): Promise<boolean> =>
    waitTrue(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!(b instanceof HTMLElement)) return false; b.click(); return true })()`, tries, gap)

  let result: Record<string, unknown> = { pass: false }
  let fixture: { close: () => void } | null = null

  const origOpen = shell.openExternal.bind(shell)
  shell.openExternal = async (authorizeUrl: string): Promise<void> => {
    if (!authorizeUrl.includes('/as/authorize')) return
    const loc = (await fetch(authorizeUrl, { redirect: 'manual' })).headers.get('location')
    if (loc) await fetch(loc)
  }

  const run = async (): Promise<void> => {
    try {
      fixture = await startFixture()
      const sandbox = process.env.MOGGING_SMOKE_CLI_HOME
      if (!sandbox) throw new Error('MOGGING_SMOKE_CLI_HOME not set — the isolation law would be violated')
      const mk = (id: string, path: string, authKinds: McpPreset['authKinds']): McpPreset => ({
        id,
        label: id,
        transport: 'http',
        urlOrCommand: `${origin}${path}`,
        authKinds,
        envRefSlots: [],
        cliQuirks: {},
        grantCopy: 'Fixture for the TOOLSMILESTONE gate.',
        verifiedAt: '2026-07-24'
      })
      // ms-plain is KEY-auth: an identity-less tool must still wear an identity ROW
      // (the fallback line + "Add a note…") — `local` no-account tools are the one
      // shape that honestly has no identity row at all.
      ;(MCP_PRESETS as McpPreset[]).push(mk('ms-github', '/gh-mcp', ['oauth']), mk('ms-plain', '/plain-mcp', ['token']))
      injectProviderEntryForSmoke({
        id: 'ms-github',
        label: 'ms-github',
        source: 'fixture://toolsmilestone',
        mcp: { transport: 'http', url: `${origin}/gh-mcp` },
        methods: [
          { key: 'browser', kind: 'oauth', name: 'Sign in with your browser', rank: 1, scopes: [{ scope: 'mcp:use', title: 'Use tools' }] },
          { key: 'cli-owned', kind: 'cliOwned', name: 'Let Claude Code sign in itself (advanced)', rank: 90 }
        ],
        profile: { via: 'rest', url: `${origin}/user`, paths: { id: 'id', email: 'email||login' }, source: 'fixture://toolsmilestone' }
      } as ProviderEntry)
      // A CLI-owned row up front: it makes the untouched card KNOWN (the inventory
      // shows it), and it is the config the Fix phase will repair in the sandbox.
      const store = getSettingsStore()
      if (!store) throw new Error('settings store not ready')
      const kv: GrantKv = { get: (k) => store.getSetting(k), set: (k, v) => store.setSetting(k, v) }
      const saved = saveServer(kv, { id: 'ms-github', label: 'ms-github', transport: 'http', url: `${origin}/gh-mcp` })
      if (!saved.ok) throw new Error(`saveServer refused: ${saved.reason}`)

      // ── 1 · fresh profile: Integrations speaks TOOLS only (red-bracketed) ────
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(500)
      await ES(`(document.querySelector('.settings-nav-item[data-target="integrations"]')?.click(), 1)`)
      await sleep(1500)
      // The banned list, against LIVE DOM textContent of the top-level surfaces
      // (the intro band + the tool grid). Fine print (the audit fold, the vault
      // card) is the ADR's reviewed survivor and is out of top-level scope.
      const wordsProbe = `(() => {
        const banned = [/\\bMCPs?\\b/, /\\bservers?\\b/i, /\\bstdio\\b/i, /\\btransports?\\b/i, /\\bdrift(?:ed|s)?\\b/i, /\\b(?:re-)?appl(?:y|ied|ies)\\b/i, /\\badopt(?:ed|s)?\\b/i, /\\bpresets?\\b/i, /\\bRoute\\s+[AB]\\b/]
        const text = ['.integux-intro', '.conn-grid'].map((sel) => document.querySelector(sel)?.textContent ?? '').join(' ')
        return banned.every((re) => !re.test(text))
      })()`
      const toolsOnlyOk = await waitTrue(wordsProbe)
      // RED BRACKET: inject a banned word into the grid; the same probe must catch it.
      await ES(`(() => { const s = document.createElement('span'); s.id = 'ms-red-bracket'; s.textContent = 'MCP server'; document.querySelector('.conn-grid')?.append(s); return 1 })()`)
      const wordsBracketRed = !(await ES<boolean>(wordsProbe))
      await ES(`(document.getElementById('ms-red-bracket')?.remove(), 1)`)

      // ── 2 · connect via the chooser's own pixel ──────────────────────────────
      const clicked = await ES<boolean>(`(() => {
        const btn = document.querySelector('.conn-card[data-connection="ms-github"] .conn-method[data-method-kind="oauth"]')
        if (!(btn instanceof HTMLElement)) return false
        btn.click()
        return true
      })()`)
      if (!clicked) throw new Error('the chooser oauth row was not on the card')
      const connectedTagOk = await waitTrue(
        `((document.querySelector('.conn-card[data-connection="ms-github"] .conn-chip')?.textContent) ?? '').startsWith('✓ Connected')`
      )
      // The heartbeat earns the verified-ago stamp within a beat or two.
      const verifiedTagOk = await waitTrue(
        `/^✓ Connected · verified \\d+m ago$/.test(document.querySelector('.conn-card[data-connection="ms-github"] .conn-chip')?.textContent ?? '')`
      )

      // ── 3 · identity lands, sourced 'rest' ───────────────────────────────────
      const identityOk = await waitFor(() => {
        const c = stateOf('ms-github')
        return c?.accountProfile?.email === 'dev@fixture.test' && c?.accountSource === 'rest'
      })
      const identityDomOk = await waitTrue(
        `(document.querySelector('.conn-card[data-connection="ms-github"] .conn-identity-text')?.textContent ?? '') === 'dev@fixture.test'`
      )

      // ── 4 · the note, on an identity-less tool ───────────────────────────────
      const plainConn = await submitKey('ms-plain', 'plain-key')
      if (!plainConn.ok) throw new Error(`submitKey ms-plain refused: ${plainConn.reason}`)
      await sleep(600)
      await clickWhenReady('.conn-card[data-connection="ms-plain"] .conn-note-edit')
      await sleep(400)
      await ES(`(() => {
        const input = document.querySelector('.conn-card[data-connection="ms-plain"] .conn-note-input')
        if (input instanceof HTMLInputElement) { input.value = 'ops box'; input.dispatchEvent(new Event('input', { bubbles: true })) }
        const save = [...document.querySelectorAll('.conn-card[data-connection="ms-plain"] .conn-note-form button')].find((b) => /Save/.test(b.textContent ?? ''))
        if (save instanceof HTMLElement) save.click()
        return 1
      })()`)
      const notedOk = await waitTrue(
        `(document.querySelector('.conn-card[data-connection="ms-plain"] .conn-identity-text')?.textContent ?? '') === 'ops box · noted by you'`
      )

      // ── 5 · scope it into a workspace, from the detail ───────────────────────
      await ES(`window.__mogging.workspace.create({ name: 'Alpha' })`)
      await sleep(900)
      const wsId = (await ES<{ id: string }>(`window.__mogging.workspace.active()`)).id
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(400)
      await ES(`(document.querySelector('.settings-nav-item[data-target="integrations"]')?.click(), 1)`)
      await sleep(1000)
      await clickWhenReady('.conn-card[data-connection="ms-github"] .conn-scope-toggle')
      await waitTrue(`(() => {
        const box = document.querySelector('.conn-card[data-connection="ms-github"] .conn-scope-check')
        if (!(box instanceof HTMLInputElement)) return false
        if (!box.checked) box.click()
        return true
      })()`)
      const scopedOk = await waitFor(() => planHasServerForCli(getToolPlan(wsId), 'ms-github', 'claude-code'))

      // ── 6 · launch there: pre-launch verifies within budget, env carries it ──
      const scratch = mkdtempSync(join(tmpdir(), 'toolsms-'))
      const preBefore = verifyStatsForSmoke().causes['pre-launch']
      const t0 = Date.now()
      const launch = await materializeToolPlanAtLaunch({ agentId: 'claude', cwd: scratch, workspaceId: wsId })
      const launchMs = Date.now() - t0
      const planPath = launch.args[launch.args.indexOf('--mcp-config') + 1]
      const launchOk =
        launch.ok &&
        launchMs < 3500 &&
        verifyStatsForSmoke().causes['pre-launch'] === preBefore + 1 &&
        typeof planPath === 'string' &&
        readFileSync(planPath, 'utf8').includes('ms-github')
      const stampFreshOk = (stateOf('ms-github')?.verifiedAt ?? 0) >= t0 - 60_000

      // ── 7 · the fixture breaks: app-wide attention within one beat ───────────
      S.revoked = true
      const attentionOk = await waitFor(() => verifyStatsForSmoke().failing.includes('ms-github'), 30, 300)
      const badgeOk = await waitTrue(
        `(() => { const f = document.querySelector('.rail-conn-attn-footer'); return !!f && !f.hidden })()`
      )
      S.revoked = false
      await verifyConnection('ms-github', 'manual')
      const recoveredOk = await waitFor(() => !verifyStatsForSmoke().failing.includes('ms-github'))

      // ── 8 · Fix repairs a hand-broken Claude Code config ─────────────────────
      // Re-apply the CURRENT registry truth (the bridge row the grant registered),
      // then break it surgically — Fix must restore it byte-identically.
      const reApplied = mgrApply('ms-github', 'claude-code')
      if (!reApplied.ok) throw new Error(`mgrApply refused: ${reApplied.reason}`)
      const claudeCfg = join(sandbox, '.claude.json')
      const healthyBytes = readFileSync(claudeCfg, 'utf8')
      writeFileSync(claudeCfg, healthyBytes.replace('--connection', '--connectionX'))
      const driftRaised = await waitFor(() => driftStatsForSmoke().includes('ms-github'))
      refreshStatus()
      await sleep(2500)
      const fixSentenceOk = await waitTrue(
        `(document.querySelector('.conn-card[data-connection="ms-github"] .conn-fix-sentence')?.textContent ?? '') === 'Claude Code’s config for this tool was edited by hand.'`
      )
      const openClicked = await clickWhenReady('.conn-card[data-connection="ms-github"] .conn-fix-open')
      const previewOk = await waitTrue(
        `(document.querySelector('.conn-card[data-connection="ms-github"] .conn-fix-preview-title')?.textContent ?? '') === 'What Fix will change'`
      )
      const fixDomDebug = previewOk
        ? ''
        : await ES<string>(
            `((document.querySelector('.conn-card[data-connection="ms-github"] .conn-fix')?.innerHTML ?? 'NO-FIX-BLOCK') + ' || card: ' + (document.querySelector('.conn-card[data-connection="ms-github"]')?.className ?? 'NO-CARD')).slice(0, 500)`
          )
      const backupsBefore = mgrBackups('claude-code').length
      await clickWhenReady('.conn-card[data-connection="ms-github"] .conn-fix-now')
      const fixedOk = await waitFor(() => readFileSync(claudeCfg, 'utf8') === healthyBytes)
      const backupOk = mgrBackups('claude-code').length > backupsBefore

      // ── 9 · disconnect: credential gone, card honest, note survives ──────────
      await ES(`(() => {
        const btn = [...document.querySelectorAll('.conn-card[data-connection="ms-plain"] button')].find((b) => (b.textContent ?? '') === 'Disconnect')
        if (btn instanceof HTMLElement) btn.click()
        return 1
      })()`)
      const disconnectedOk = await waitTrue(
        `(document.querySelector('.conn-card[data-connection="ms-plain"] .conn-chip')?.textContent ?? '') === 'Not connected'`
      )
      const noteSurvivedOk = await waitFor(() => stateOf('ms-plain')?.accountNote === 'ops box')

      result = {
        pass:
          toolsOnlyOk &&
          wordsBracketRed &&
          connectedTagOk &&
          verifiedTagOk &&
          identityOk &&
          identityDomOk &&
          notedOk &&
          scopedOk &&
          launchOk &&
          stampFreshOk &&
          attentionOk &&
          badgeOk &&
          recoveredOk &&
          driftRaised &&
          fixSentenceOk &&
          previewOk &&
          fixedOk &&
          backupOk &&
          disconnectedOk &&
          noteSurvivedOk,
        toolsOnlyOk,
        wordsBracketRed,
        connectedTagOk,
        verifiedTagOk,
        identityOk,
        identityDomOk,
        notedOk,
        scopedOk,
        launchOk,
        launchMs,
        stampFreshOk,
        attentionOk,
        badgeOk,
        recoveredOk,
        driftRaised,
        fixSentenceOk,
        previewOk,
        fixedOk,
        backupOk,
        disconnectedOk,
        noteSurvivedOk,
        observed: { openClicked, fixDomDebug }
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
      writeFileSync(join(process.cwd(), 'out', 'toolsmilestone-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    clearTimeout(safety)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
