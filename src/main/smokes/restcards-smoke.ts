import { app, shell, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpPreset, ProviderEntry } from '@contracts'
import { MCP_PRESETS, handleRestBridgeRpc, injectProviderEntryForSmoke } from '@backend/features/integrations'
import { listConnections, restBridgeUpstream, submitFamilyKey, sweepConnections, verifyConnection } from '../connections'
import { listServers } from '../mcp-manager'

// Env-gated LIVE rest-cards smoke (MOGGING_RESTCARDS, phase-restbridge/04). Boots the
// REAL app and proves the bridge's user-visible payoff on the real Settings page,
// against a local fixture REST API — zero MCP endpoints exist in this fixture at all.
//
//   (a) CHOOSER + GUIDED PANEL — a restTools-only fixture renders "Paste an API key"
//       (ADR 0020 strings verbatim, rank honored); the panel shows the Create-your-
//       token door (openExternal SPIED — the exact prefilled setupTokenUrl asserted)
//       and the requiredPermissions list;
//   (b) PASTE → PROVE-BEFORE-SAVE — a bad key is refused by the fixture's own 401,
//       the field RETAINS it (the SECRETFORMS law); a good key flips the card to
//       `✓ Connected · verified 0m ago`;
//   (c) THE FAMILY KEY — one paste at family level lights every member (each with
//       its own bridge row registered), one family card, aggregate tag;
//   (d) tools/list through the real bridge upstream shows the curated names;
//   (e) IDENTITY — the catalog `profile` spec names the account (accountSource
//       'rest'), zero engine changes;
//   (f) HEARTBEAT — re-verifies via the verification endpoint (fixture counts) and
//       NO MCP handshake ever fires (the fixture would have counted it).
//
// MUTATION-RED ×2, proven LIVE on every pass:
//   · MOGGING_REST_BREAK_FANOUT — the broken family fan-out connects ONE member,
//     exactly what (c)'s every-member assert catches;
//   · check-catalog --entry on a restTools row WITHOUT `verification` — the
//     mandatory-verification RESTSCHEMA rule must red.

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

let origin = ''
const hits = { verify: 0, whoami: 0, things: 0, mcp: 0 }

function startFixture(): Promise<{ close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const p = url.pathname
      const authed = req.headers.authorization === 'Bearer good-key'
      if (p === '/verify-fam') {
        hits.verify++
        return authed ? sendJson(res, 200, { ok: true }) : sendJson(res, 401, { error: 'bad key' })
      }
      if (p === '/whoami') {
        hits.whoami++
        return authed ? sendJson(res, 200, { id: 'u1', email: 'fam@example.test' }) : sendJson(res, 401, {})
      }
      if (p === '/things') {
        hits.things++
        return sendJson(res, 200, { results: ['alpha', 'beta'] })
      }
      // ANY MCP-shaped traffic is a failure of the route's whole promise.
      if (p.includes('mcp')) {
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

const SETUP_URL = 'https://example.test/create-token?scopes=things:read&name=mogging'

function restEntry(id: string, group: string | undefined, toolName: string): ProviderEntry {
  return {
    id,
    label: id,
    source: 'fixture://restcards',
    ...(group ? { group } : {}),
    methods: [
      {
        key: 'api-key',
        kind: 'apiKey',
        name: 'Paste an API key',
        rank: 1,
        inputs: [{ key: 'RESTFAM_KEY', label: 'Fixture key', secret: true, required: true }]
      },
      { key: 'cli-owned', kind: 'cliOwned', name: 'Let Claude Code sign in itself (advanced)', rank: 90 }
    ],
    restAuth: { in: 'header', header: 'Authorization', scheme: 'Bearer' },
    requiredPermissions: ['Things Read'],
    setupTokenUrl: SETUP_URL,
    verification: { method: 'GET', endpoint: `${origin}/verify-fam` },
    profile: { via: 'rest', url: `${origin}/whoami`, paths: { id: 'id', email: 'email' }, source: 'https://example.test/docs/whoami' },
    restTools: [
      {
        name: toolName,
        description: `List the things ${id} curates.`,
        method: 'GET',
        endpoint: `${origin}/things`,
        responsePath: 'results',
        source: 'https://example.test/docs/things'
      }
    ]
  } as ProviderEntry
}

/** The mandatory-verification RESTSCHEMA rule, proven biting via the same judge
 *  that guards shipped rows. */
function verificationRuleReds(): Promise<boolean> {
  const entry = {
    id: 'noverify',
    label: 'No Verify',
    source: 'https://example.test/docs',
    methods: [
      { key: 'api-key', kind: 'apiKey', name: 'Paste an API key', rank: 1 },
      { key: 'cli-owned', kind: 'cliOwned', name: 'Let Claude Code sign in itself (advanced)', rank: 90 }
    ],
    restAuth: { in: 'header', header: 'Authorization', scheme: 'Bearer' },
    requiredPermissions: ['Things Read'],
    restTools: [
      { name: 'list_things', description: 'List things.', method: 'GET', endpoint: 'https://example.test/things', source: 'https://example.test/docs' }
    ]
  }
  const dir = mkdtempSync(join(tmpdir(), 'restcards-'))
  const file = join(dir, 'noverify.json')
  writeFileSync(file, JSON.stringify(entry))
  return new Promise((resolve) => {
    execFile(process.execPath, [join(process.cwd(), 'scripts', 'check-catalog.mjs'), '--entry', file], { cwd: process.cwd() }, (err, _out, stderr) => {
      rmSync(dir, { recursive: true, force: true })
      resolve(!!err && String(stderr).includes('verification'))
    })
  })
}

export function runRestCardsSmoke(win: BrowserWindow): void {
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
  const opened: string[] = []
  const origOpen = shell.openExternal.bind(shell)
  shell.openExternal = async (url: string): Promise<void> => {
    opened.push(url) // SPIED: a setup link must never actually navigate in a gate
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
        envRefSlots: ['RESTFAM_KEY'],
        cliQuirks: {},
        grantCopy: 'Fixture for the RESTCARDS gate.',
        verifiedAt: '2026-07-24'
      })
      for (const id of ['restsolo', 'restfam-a', 'restfam-b', 'restfam2-c', 'restfam2-d']) {
        ;(MCP_PRESETS as McpPreset[]).push(mk(id))
      }
      injectProviderEntryForSmoke(restEntry('restsolo', undefined, 'list_solo_things'))
      injectProviderEntryForSmoke(restEntry('restfam-a', 'restfam', 'list_fam_things'))
      injectProviderEntryForSmoke(restEntry('restfam-b', 'restfam', 'list_fam_extras'))
      injectProviderEntryForSmoke(restEntry('restfam2-c', 'restfam2', 'list_fam2_things'))
      injectProviderEntryForSmoke(restEntry('restfam2-d', 'restfam2', 'list_fam2_extras'))

      // ── Onto the real page: never-touched rows live in the LIBRARY overlay (the
      // browse surface), reached through Settings › Integrations' own CTA.
      await ES(`window.__mogging.workspace.create({ name: 'Alpha' })`)
      await sleep(900)
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(500)
      await ES(`(document.querySelector('.settings-nav-item[data-target="integrations"]')?.click(), 1)`)
      await sleep(1200)
      await ES(`(document.querySelector('.integux-intro .integux-library-cta')?.click(), 1)`)
      const libraryUp = await waitTrue(`!!document.querySelector('.library-modal .conn-card[data-connection="restsolo"]')`, 40, 300)
      if (!libraryUp) throw new Error('the Library overlay never rendered the fixture card')

      // (a) chooser + the guided panel on the restTools-only solo card.
      const chooserOk = await waitTrue(`(() => {
        const card = document.querySelector('.conn-card[data-connection="restsolo"]')
        if (!card) return false
        const rows = [...card.querySelectorAll('.conn-method:not(.is-coming-soon)')]
        const first = rows[0]
        return rows.length === 1 &&
          first?.getAttribute('data-method-kind') === 'apiKey' &&
          first?.querySelector('.conn-method-label')?.textContent === 'Paste an API key' &&
          (first?.querySelector('.conn-method-sub')?.textContent ?? '').includes('encrypted by your OS keychain')
      })()`)
      await ES(`(document.querySelector('.conn-card[data-connection="restsolo"] .conn-method[data-method-kind="apiKey"]')?.click(), 1)`)
      await sleep(400)
      const panelOk = await waitTrue(`(() => {
        const card = document.querySelector('.conn-card[data-connection="restsolo"]')
        const setup = card?.querySelector('.conn-token-setup')
        const perms = card?.querySelector('.conn-required-perms')?.textContent ?? ''
        const over = card?.querySelector('.conn-overscope-note')?.textContent ?? ''
        const bridgeNote = card?.querySelector('.conn-bridge-note')?.textContent ?? ''
        return !!setup && perms.includes('This needs: Things Read — nothing more.') &&
          over.includes('a scoped one is safer') &&
          bridgeNote.includes('Runs on this machine against the provider’s own API')
      })()`)
      await ES(`(document.querySelector('.conn-card[data-connection="restsolo"] .conn-token-setup')?.click(), 1)`)
      await sleep(400)
      const setupSpyOk = opened.length === 1 && opened[0] === SETUP_URL

      // (b) prove-before-save: bad key refused + retained; good key connects.
      const typeKey = (sel: string, value: string): Promise<unknown> =>
        ES(`(() => {
          const input = document.querySelector('${sel}')
          if (!(input instanceof HTMLInputElement)) return false
          const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          proto.set.call(input, '${value}')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`)
      await typeKey('.conn-card[data-connection="restsolo"] .conn-key-form input[type="password"]', 'bad-key')
      await ES(`([...document.querySelectorAll('.conn-card[data-connection="restsolo"] .conn-key-form button')].find((b) => b.textContent === 'Connect')?.click(), 1)`)
      const refusedOk = await waitTrue(`(() => {
        const card = document.querySelector('.conn-card[data-connection="restsolo"]')
        const note = card?.querySelector('.conn-key-form [role="alert"]')
        return !!note && !note.hidden && /refused/.test(note.textContent ?? '')
      })()`)
      const retainedOk = await ES<boolean>(`document.querySelector('.conn-card[data-connection="restsolo"] .conn-key-form input[type="password"]')?.value === 'bad-key'`)
      const badKeyHitVerify = hits.verify >= 1 && hits.mcp === 0
      await typeKey('.conn-card[data-connection="restsolo"] .conn-key-form input[type="password"]', 'good-key')
      await ES(`([...document.querySelectorAll('.conn-card[data-connection="restsolo"] .conn-key-form button')].find((b) => b.textContent === 'Connect')?.click(), 1)`)
      const soloConnectedOk = await waitTrue(
        `(document.querySelector('.conn-card[data-connection="restsolo"] .conn-chip')?.textContent ?? '') === '✓ Connected · verified 0m ago'`
      )

      // (c) THE FAMILY KEY: one paste lights every member; one card; aggregate tag.
      const famMethodOk = await waitTrue(`(() => {
        const fam = document.querySelector('.conn-family-card[data-group="restfam"]')
        const m = fam?.querySelector('.conn-family-key-method .conn-method-label')?.textContent
        return m === 'Paste an API key'
      })()`)
      await ES(`(document.querySelector('.conn-family-card[data-group="restfam"] .conn-family-key-method')?.click(), 1)`)
      await sleep(400)
      const verifyBeforeFam = hits.verify
      await typeKey('.conn-family-card[data-group="restfam"] .conn-family-key-input', 'good-key')
      await ES(`([...document.querySelectorAll('.conn-family-card[data-group="restfam"] .conn-family-key-form button')].find((b) => b.textContent === 'Connect')?.click(), 1)`)
      const famConnectedOk = await waitTrue(`(() => {
        // Scoped to the overlay: the Integrations INVENTORY behind it now shows the
        // connected family too (correctly) — one card PER SURFACE is the law.
        const fams = document.querySelectorAll('.library-modal .conn-family-card[data-group="restfam"]')
        const chip = fams[0]?.querySelector('.conn-chip')?.textContent ?? ''
        return fams.length === 1 && chip.startsWith('✓ Connected')
      })()`)
      await sleep(600)
      const cs = listConnections()
      const famBothOk = ['restfam-a', 'restfam-b'].every((id) => cs.find((c) => c.id === id)?.state === 'connected')
      const famOneVerifyOk = hits.verify === verifyBeforeFam + 1
      const bridgeRows = listServers().filter((s) => Array.isArray(s.args) && s.args[0] === '--connection')
      const famRowsOk = ['restfam-a', 'restfam-b', 'restsolo'].every((id) => bridgeRows.some((s) => s.id === id))

      // (d) tools/list through the real bridge upstream: the curated names, verbatim.
      const upstream = await restBridgeUpstream('restfam-a')
      let toolsListOk = false
      if (upstream) {
        const resp = (await handleRestBridgeRpc(
          { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          { entry: upstream.entry, token: upstream.token, writeGranted: false }
        )) as { result?: { tools?: { name: string }[] } }
        toolsListOk = resp.result?.tools?.map((t) => t.name).join(',') === 'list_fam_things'
      }

      // (e) identity from the catalog profile spec — zero engine changes.
      const who = await verifyConnection('restfam-a', 'manual')
      const identityOk = who?.accountSource === 'rest' && /fam@example\.test/.test(who?.account ?? '')

      // (f) the heartbeat re-verifies via the verification endpoint; NO MCP ever.
      const verifyBeforeSweep = hits.verify
      await sweepConnections('heartbeat', { cursor: 0 })
      await sleep(400)
      const connectedNow = listConnections().filter((c) => c.state === 'connected').length
      const sweepOk = hits.verify >= verifyBeforeSweep + connectedNow && hits.mcp === 0

      // Mutation-red 1: the broken fan-out connects ONE member — (c)'s assert bites.
      process.env.MOGGING_REST_BREAK_FANOUT = '1'
      const broken = await submitFamilyKey('restfam2', 'good-key')
      delete process.env.MOGGING_REST_BREAK_FANOUT
      const fanoutRed =
        broken.ok === true &&
        (broken.connected?.length ?? 0) === 1 &&
        listConnections().find((c) => c.id === 'restfam2-d')?.state !== 'connected'

      // Mutation-red 2: the mandatory-verification RESTSCHEMA rule bites.
      const verificationRed = await verificationRuleReds()

      result = {
        pass:
          chooserOk &&
          panelOk &&
          setupSpyOk &&
          refusedOk &&
          retainedOk === true &&
          badKeyHitVerify &&
          soloConnectedOk &&
          famMethodOk &&
          famConnectedOk &&
          famBothOk &&
          famOneVerifyOk &&
          famRowsOk &&
          toolsListOk &&
          identityOk &&
          sweepOk &&
          fanoutRed &&
          verificationRed,
        chooserOk,
        panelOk,
        setupSpyOk,
        refusedOk,
        retainedOk,
        badKeyHitVerify,
        soloConnectedOk,
        famMethodOk,
        famConnectedOk,
        famBothOk,
        famOneVerifyOk,
        famRowsOk,
        toolsListOk,
        identityOk,
        sweepOk,
        fanoutRed,
        verificationRed,
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
      writeFileSync(join(process.cwd(), 'out', 'restcards-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    clearTimeout(safety)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
