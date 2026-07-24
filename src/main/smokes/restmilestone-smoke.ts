import { app, shell, type BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpPreset, ProviderEntry } from '@contracts'
import { planHasServerForCli } from '@contracts'
import { MCP_PRESETS, handleRestBridgeRpc, injectProviderEntryForSmoke } from '@backend/features/integrations'
import {
  disconnect,
  listConnections,
  restBridgeUpstream,
  submitFamilyKey,
  sweepConnections,
  verifyConnection,
  verifyConnectionsForLaunch,
  verifyStatsForSmoke
} from '../connections'
import { getToolPlan, resolveWriteAllGranted, setIntegrationsGrant } from '../integrations'
import { serviceKeyNames } from '../service-keys'
import { listServers } from '../mcp-manager'

// RESTMILESTONE (MOGGING_RESTMILESTONE, phase-restbridge/05) — THE authority on
// "phase-restbridge done": the whole promise composed on the real app, in order,
// every arrow an assert, against a fixture REST API with ZERO MCP endpoints.
//
//   fresh profile → the fixture family offers "Paste an API key" at FAMILY level
//   → one paste proves once, vaults, connects EVERY member (`✓ Connected ·
//   verified 0m ago`) → the slot name reads saved on the CLI route (the
//   one-paste law) → identity lands from the catalog profile (accountSource
//   'rest') → scope into a workspace from the DETAIL → the plan carries the
//   bridge row; pre-launch verify stamps within budget → an agent-shaped
//   tools/call reads through the bridge (fixture asserts the pinned URL + the
//   injected header) → a WRITE tool refuses with the grant off (the sentence
//   names the switch; ZERO write hits) → the grant flips through the REAL store
//   → the same call lands → the key is revoked fixture-side → attention raises
//   within one beat and the card reads Needs attention → a re-paste heals it →
//   disconnect deletes the credential while the CLI-route slot SURVIVES (it is
//   the user's, not the connection's).
//
// BRACKETED write-refusal (the red/green law): the refusal's zero-hit assert is
// proven biting on every run — `_testDisableWriteGate` must land the ungranted
// write at the fixture.

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

let origin = ''
const S = { revoked: false }
const hits = { verify: 0, whoami: 0, reads: [] as Array<{ path: string; auth: string }>, writes: 0, mcp: 0 }

function startFixture(): Promise<{ close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const authed = req.headers.authorization === 'Bearer good-key' && !S.revoked
      if (url.pathname === '/verify-mile') {
        hits.verify++
        return authed ? sendJson(res, 200, { ok: true }) : sendJson(res, 401, { error: 'bad key' })
      }
      if (url.pathname === '/whoami') {
        hits.whoami++
        return authed ? sendJson(res, 200, { id: 'mile-1', email: 'mile@example.test' }) : sendJson(res, 401, {})
      }
      if (url.pathname === '/things' && req.method === 'GET') {
        hits.reads.push({ path: url.pathname + url.search, auth: String(req.headers.authorization ?? '') })
        return sendJson(res, 200, { results: ['one', 'two'] })
      }
      if (url.pathname === '/things' && req.method === 'POST') {
        hits.writes++
        return sendJson(res, 200, { created: true })
      }
      if (url.pathname.includes('mcp')) {
        hits.mcp++
        return sendJson(res, 404, {})
      }
      sendJson(res, 404, {})
    })
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve({ close: () => server.close() })
    })
  })
}

function mileEntry(id: string, withWrite: boolean): ProviderEntry {
  return {
    id,
    label: id,
    source: 'fixture://restmilestone',
    group: 'milefam',
    methods: [
      { key: 'api-key', kind: 'apiKey', name: 'Paste an API key', rank: 1, inputs: [{ key: 'RESTMILE_KEY', label: 'Milestone key', secret: true, required: true }] },
      { key: 'cli-owned', kind: 'cliOwned', name: 'Let Claude Code sign in itself (advanced)', rank: 90 }
    ],
    restAuth: { in: 'header', header: 'Authorization', scheme: 'Bearer' },
    requiredPermissions: ['Things Read', ...(withWrite ? ['Things Write'] : [])],
    setupTokenUrl: 'https://example.test/create-token?scopes=things&name=mogging',
    verification: { method: 'GET', endpoint: `${origin}/verify-mile` },
    profile: { via: 'rest', url: `${origin}/whoami`, paths: { id: 'id', email: 'email' }, source: 'https://example.test/docs/whoami' },
    restTools: [
      {
        name: `list_${id.replace(/-/g, '_')}_things`,
        description: `List the things ${id} curates.`,
        method: 'GET',
        endpoint: `${origin}/things`,
        responsePath: 'results',
        source: 'https://example.test/docs/things'
      },
      ...(withWrite
        ? [
            {
              name: 'create_mile_thing',
              description: 'Create one thing.',
              method: 'POST' as const,
              endpoint: `${origin}/things`,
              params: [{ key: 'name', in: 'body' as const, type: 'string' as const, required: true }],
              readOnly: false,
              source: 'https://example.test/docs/things#create'
            }
          ]
        : [])
    ]
  } as ProviderEntry
}

export function runRestMilestoneSmoke(win: BrowserWindow): void {
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
  const typeInto = (sel: string, value: string): Promise<unknown> =>
    ES(`(() => {
      const input = document.querySelector('${sel}')
      if (!(input instanceof HTMLInputElement)) return false
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      proto.set.call(input, '${value}')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)

  let result: Record<string, unknown> = { pass: false }
  let fixture: { close: () => void } | null = null
  const origOpen = shell.openExternal.bind(shell)
  shell.openExternal = async (): Promise<void> => {
    /* no gate ever navigates */
  }

  const run = async (): Promise<void> => {
    try {
      fixture = await startFixture()
      const mk = (id: string): McpPreset => ({
        id,
        label: id,
        transport: 'http',
        urlOrCommand: '',
        authKinds: ['token'],
        envRefSlots: ['RESTMILE_KEY'],
        cliQuirks: {},
        grantCopy: 'Fixture for the RESTMILESTONE gate.',
        verifiedAt: '2026-07-24'
      })
      ;(MCP_PRESETS as McpPreset[]).push(mk('milefam-a'), mk('milefam-b'))
      injectProviderEntryForSmoke(mileEntry('milefam-a', true))
      injectProviderEntryForSmoke(mileEntry('milefam-b', false))

      // ── The world: a workspace with one real pane (the grant's subject) ─────
      await ES(`window.__mogging.templates.open([{provider:'shell',count:1}])`)
      await sleep(3000)
      const ws = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const pane = String(ws.ordinal * 100 + 1)

      // ── Fresh profile → the family offers the key at FAMILY level ──────────
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(500)
      await ES(`(document.querySelector('.settings-nav-item[data-target="integrations"]')?.click(), 1)`)
      await sleep(1200)
      await ES(`(document.querySelector('.integux-intro .integux-library-cta')?.click(), 1)`)
      const famOffer = await waitTrue(
        `document.querySelector('.library-modal .conn-family-card[data-group="milefam"] .conn-family-key-method .conn-method-label')?.textContent === 'Paste an API key'`,
        40,
        300
      )

      // ── One paste → proves once, vaults, connects EVERY member ─────────────
      await ES(`(document.querySelector('.library-modal .conn-family-card[data-group="milefam"] .conn-family-key-method')?.click(), 1)`)
      await sleep(400)
      const verifyBefore = hits.verify
      await typeInto('.library-modal .conn-family-card[data-group="milefam"] .conn-family-key-input', 'good-key')
      await ES(`([...document.querySelectorAll('.library-modal .conn-family-card[data-group="milefam"] .conn-family-key-form button')].find((b) => b.textContent === 'Connect')?.click(), 1)`)
      const famConnected = await waitTrue(
        `(document.querySelector('.library-modal .conn-family-card[data-group="milefam"] .conn-chip')?.textContent ?? '').startsWith('✓ Connected')`
      )
      await ES(`(document.querySelector('.library-modal .conn-family-card[data-group="milefam"] .conn-family-toggle')?.click(), 1)`)
      const memberChips = await waitTrue(`(() => {
        const chips = [...document.querySelectorAll('.library-modal .conn-family-card[data-group="milefam"] .conn-family-members .conn-chip')]
        return chips.length === 2 && chips.every((c) => c.textContent === '✓ Connected · verified 0m ago')
      })()`)
      const provedOnce = hits.verify === verifyBefore + 1
      const bothConnected = ['milefam-a', 'milefam-b'].every((id) => listConnections().find((c) => c.id === id)?.state === 'connected')

      // ── The one-paste law: the slot reads saved on the CLI route ───────────
      const slotSaved = serviceKeyNames().includes('RESTMILE_KEY')
      const bridgeRows = listServers().filter((s) => Array.isArray(s.args) && s.args[0] === '--connection')
      const rowsRegistered = ['milefam-a', 'milefam-b'].every((id) => bridgeRows.some((s) => s.id === id))

      // ── Identity lands from the catalog profile ────────────────────────────
      const who = await verifyConnection('milefam-a', 'manual')
      const identityOk = who?.accountSource === 'rest' && /mile@example\.test/.test(who?.account ?? '')

      // ── Scope into the workspace from the DETAIL ───────────────────────────
      await ES(`(() => {
        const card = document.querySelector('.library-modal .conn-card[data-connection="milefam-a"]')
        const t = card?.querySelector('.conn-scope-toggle')
        if (t instanceof HTMLElement) t.click()
        return 1
      })()`)
      await sleep(700)
      await ES(`(() => {
        const box = document.querySelector('.library-modal .conn-card[data-connection="milefam-a"] .conn-scope-check')
        if (box instanceof HTMLInputElement && !box.checked) box.click()
        return 1
      })()`)
      await sleep(1200)
      const planCarries = planHasServerForCli(getToolPlan(ws.id), 'milefam-a', 'claude-code')

      // ── Pre-launch verify: stamps within the budget, never delays a pane ───
      const beforeLaunch = listConnections().find((c) => c.id === 'milefam-a')?.verifiedAt ?? 0
      await sleep(1100) // one whole minute is not needed; one distinct ms floor is
      const t0 = Date.now()
      await verifyConnectionsForLaunch(['milefam-a', 'milefam-b'])
      const launchMs = Date.now() - t0
      await sleep(400)
      const launchStamped = (listConnections().find((c) => c.id === 'milefam-a')?.verifiedAt ?? 0) > beforeLaunch
      const launchWithinBudget = launchMs <= 2600

      // ── An agent-shaped read through the bridge: pinned URL + injected key ──
      const upstream = await restBridgeUpstream('milefam-a')
      if (!upstream) throw new Error('bridge upstream missing for milefam-a')
      const svc = (writeGranted: boolean, disable = false): Parameters<typeof handleRestBridgeRpc>[1] => ({
        entry: upstream.entry,
        token: upstream.token,
        writeGranted,
        ...(disable ? { _testDisableWriteGate: true } : {})
      })
      const readsBefore = hits.reads.length
      const readResp = (await handleRestBridgeRpc(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_milefam_a_things', arguments: {} } },
        svc(resolveWriteAllGranted(pane))
      )) as { result?: { content?: { text?: string }[]; isError?: boolean } }
      const readLanded =
        hits.reads.length === readsBefore + 1 &&
        hits.reads[hits.reads.length - 1]!.path === '/things' &&
        hits.reads[hits.reads.length - 1]!.auth === 'Bearer good-key' &&
        !readResp.result?.isError &&
        (readResp.result?.content?.[0]?.text ?? '').includes('one')

      // ── THE WRITE BOUNDARY, end-to-end on the real grant seam ──────────────
      const writeCall = (granted: boolean, disable = false): Promise<{ result?: { content?: { text?: string }[]; isError?: boolean } }> =>
        handleRestBridgeRpc(
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_mile_thing', arguments: { name: 'x' } } },
          svc(granted, disable)
        ) as Promise<{ result?: { content?: { text?: string }[]; isError?: boolean } }>
      // Grant OFF (the closed-fist default): refusal names the switch, ZERO hits.
      const grantOffValue = resolveWriteAllGranted(pane)
      const refused = await writeCall(grantOffValue)
      const refusedOk =
        grantOffValue === false &&
        refused.result?.isError === true &&
        (refused.result?.content?.[0]?.text ?? '').includes('Write tools') &&
        hits.writes === 0
      // The flip, through the REAL store (the Settings toggle's engine).
      setIntegrationsGrant({ workspaceId: ws.id, writeTools: 'all', web: 'off', actOrigins: [] })
      const granted = await writeCall(resolveWriteAllGranted(pane))
      const grantedOk = !granted.result?.isError && hits.writes === 1
      // BRACKET (red side): grant back off, gate disabled — the write MUST land,
      // proving the zero-hit refusal assert bites.
      setIntegrationsGrant({ workspaceId: ws.id, writeTools: 'none', web: 'off', actOrigins: [] })
      await writeCall(resolveWriteAllGranted(pane), true)
      const bracketRed = hits.writes === 2
      setIntegrationsGrant({ workspaceId: ws.id, writeTools: 'all', web: 'off', actOrigins: [] })

      // ── Revocation → attention within one beat; the card says so ───────────
      S.revoked = true
      await sweepConnections('heartbeat', { cursor: 0 })
      await sleep(600)
      const failing = verifyStatsForSmoke().failing
      const attentionRaised = failing.includes('milefam-a') && failing.includes('milefam-b')
      const cardAttention = await waitTrue(
        `(document.querySelector('.library-modal .conn-family-card[data-group="milefam"] .conn-chip')?.textContent ?? '') === 'Needs attention'`
      )

      // ── Re-paste heals ─────────────────────────────────────────────────────
      S.revoked = false
      const healed = await submitFamilyKey('milefam', 'good-key')
      await sleep(600)
      const healedOk = healed.ok === true && ['milefam-a', 'milefam-b'].every((id) => listConnections().find((c) => c.id === id)?.state === 'connected')

      // ── Disconnect deletes the credential; the CLI-route slot SURVIVES ─────
      disconnect('milefam-a')
      await sleep(400)
      const dropped = listConnections().find((c) => c.id === 'milefam-a')?.state !== 'connected'
      const upstreamGone = (await restBridgeUpstream('milefam-a')) === null
      const slotSurvives = serviceKeyNames().includes('RESTMILE_KEY')

      result = {
        pass:
          famOffer &&
          famConnected &&
          memberChips &&
          provedOnce &&
          bothConnected &&
          slotSaved &&
          rowsRegistered &&
          identityOk &&
          planCarries &&
          launchStamped &&
          launchWithinBudget &&
          readLanded &&
          refusedOk &&
          grantedOk &&
          bracketRed &&
          attentionRaised &&
          cardAttention &&
          healedOk &&
          dropped &&
          upstreamGone &&
          slotSurvives &&
          hits.mcp === 0,
        famOffer,
        famConnected,
        memberChips,
        provedOnce,
        bothConnected,
        slotSaved,
        rowsRegistered,
        identityOk,
        planCarries,
        launchStamped,
        launchWithinBudget,
        launchMs,
        readLanded,
        refusedOk,
        grantedOk,
        bracketRed,
        attentionRaised,
        cardAttention,
        healedOk,
        dropped,
        upstreamGone,
        slotSurvives,
        mcpHits: hits.mcp
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
      writeFileSync(join(process.cwd(), 'out', 'restmilestone-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    clearTimeout(safety)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
