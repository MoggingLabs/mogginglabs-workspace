import { app, type BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TrailStore } from '@backend/features/integrations'
import {
  agentAct,
  browserDriver,
  confirmPendingActOrigin,
  dockPageEval,
  setAgentConsent
} from '../browser-dock'
import { clearTrail, flushTrailForSmoke, readTrail, recordTrail } from '../trail'
import { setIntegrationsGrant } from '../integrations'
import { spawnPaneMcpSmokeClient, type PaneMcpSmokeClient } from './pane-mcp-smoke-client'
import type { BrowserAgentVerb, TrailEntry } from '@contracts'

// Env-gated trail smoke (MOGGING_WEBTRAIL, Phase-8/05 — FINDINGS §4.5). One
// fixture world drives BOTH emitters (04's agent-web acts + 03's MCP-write
// receipts) into the real store, then holds the LEDGER itself to account:
//   (a) granted click  -> web/ok entry, ORIGIN as target
//   (b) ungranted click -> web/refused + reason
//   (c) MCP send_to_pane -> mcp/ok + pane ref (through the real server child)
//   (d) the RAW FILE leaks nothing: no eval body, page text, cookie value,
//       or URL path/query beyond origins — absence is the assert
//   (e) the ring caps: seed 2100 -> ≤2000 kept, oldest gone, newest intact
//   (f) entries survive "restart" (a fresh store instance on the same dir)
//   (g) clear-workspace empties exactly that file (the ring ws survives)
//   (h) the viewer renders the entries (Settings § Activity, DOM asserts)
// Zero external network: the only page is this smoke's own 127.0.0.1 server.

export function runWebTrailSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 180000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const root = app.getAppPath()
  let site: Server | null = null

  const emit = (o: object): void => {
    try {
      writeFileSync(join(root, 'out', 'webtrail-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const cli = (
    args: string[],
    extraEnv: Record<string, string> = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((res) => {
      execFile(
        process.execPath,
        [join(root, 'bin', 'mogging.mjs'), ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv }, timeout: 15000, windowsHide: true },
        (err, stdout, stderr) => res({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
      )
    })

  const serveSite = (): Promise<number> =>
    new Promise((resolve) => {
      site = createServer((req, res) => {
        const loggedIn = /(?:^|;\s*)sid=SECRETCOOKIE_4242(?:;|$)/.test(String(req.headers.cookie ?? ''))
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(
          `<!doctype html><title>TRAIL</title><div id="who">${loggedIn ? 'PAGETEXT_IN_4242' : 'PAGETEXT_OUT_4242'}</div>` +
            `<button id="login" onclick="document.cookie='sid=SECRETCOOKIE_4242; max-age=86400'; location.reload()">Log in</button>` +
            `<button id="act">Do the thing</button>`
        )
      })
      site.listen(0, '127.0.0.1', () => {
        const addr = site?.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

  const act = (v: BrowserAgentVerb): ReturnType<typeof agentAct> => agentAct(v)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let mcpClient: PaneMcpSmokeClient | null = null
    try {
      await sleep(1500)
      const port = await serveSite()
      const origin = `http://127.0.0.1:${port}`
      const deepUrl = `${origin}/deep/path?q=SECRETQUERY_4242`

      // ── World: one workspace, two panes (MCP write needs a target pane) ────
      await ES(`window.__mogging.templates.open([{provider:'shell',count:2}])`)
      await sleep(3000)
      const ws = (await ES('window.__mogging.workspace.active()')) as { id: string; ordinal: number }
      const pane1 = String(ws.ordinal * 100 + 1)
      const pane2 = String(ws.ordinal * 100 + 2)
      await ES('window.__mogging.browser.toggle(true)')
      await sleep(500)
      await ES(`window.__mogging.browser.setProfile('agent-web')`)
      await sleep(600)
      setAgentConsent(true, ws.id)
      browserDriver.navigate(deepUrl) // a URL with path+query — only the ORIGIN may reach the file
      await sleep(1500)
      await dockPageEval(`document.querySelector('#login').click()`)
      await sleep(1200)

      // ── (b) ungranted click -> web/refused ─────────────────────────────────
      const snap = await act({ verb: 'snapshot' })
      const actRef = snap.nodes?.find((n) => n.name.includes('Do the thing'))?.ref ?? ''
      await act({ verb: 'click', target: actRef })

      // ── (a) granted + confirmed click -> web/ok; eval too (body must not leak)
      setIntegrationsGrant({ workspaceId: ws.id, writeTools: 'all', web: 'signed-in', actOrigins: [origin] })
      await act({ verb: 'click', target: actRef }) // raises the confirm
      confirmPendingActOrigin(origin)
      await act({ verb: 'click', target: actRef }) // web/ok
      await act({ verb: 'eval', target: `document.title /*EVALBODY_4242*/` }) // web/ok; body stays out of the file

      // ── (c) MCP write -> mcp/ok with a pane ref ────────────────────────────
      // The write, and the RECEIPT it must leave, are both attributed to the pane that made
      // them — and a pane is now something an MCP session PROVES, not something it claims. The
      // app endpoint binds a session to a pane only on the daemon-minted MOGGING_PANE_TOKEN,
      // which lives nowhere but inside that pane; a server spawned from here with a hand-set
      // MOGGING_PANE_ID is exactly the forgery mcpwrite-smoke asserts gets nothing. So run the
      // REAL server where a real agent runs it — inside the pane — and let the token arrive the
      // way production delivers it (spawnPaneMcpSmokeClient). `by` on the receipt is then a
      // fact, which is the whole point of an activity trail.
      await cli(['send', pane2, 'echo hello'], {}) // the write TARGET: exists & alive
      const mcp = await spawnPaneMcpSmokeClient({
        cli,
        paneId: pane1,
        mcpPath: join(root, 'bin', 'mogging-mcp.mjs')
      })
      mcpClient = mcp
      await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      const sent = await mcp.rpc('tools/call', {
        name: 'send_to_pane',
        arguments: { pane: pane2, text: 'MCPBODY_4242' }
      })
      const mcpSendOk = !sent.error && (sent.result as { isError?: boolean } | undefined)?.isError !== true
      await sleep(1500) // receipt is fire-and-forget; let it land + flush

      flushTrailForSmoke()
      const entries = readTrail(ws.id)
      const webOk = entries.find((t) => t.source === 'web' && t.verb === 'click' && t.outcome === 'ok')
      const aOk = !!webOk && webOk.target === origin
      const webRefused = entries.find((t) => t.source === 'web' && t.verb === 'click' && t.outcome === 'refused')
      const bOk = !!webRefused && /grant/.test(webRefused.reason ?? '') && webRefused.target === origin
      const confirmed = entries.find((t) => t.verb === 'confirm' && t.outcome === 'confirmed' && t.target === origin)
      const mcpEntry = entries.find((t) => t.source === 'mcp' && t.verb === 'send_to_pane' && t.outcome === 'ok')
      const cOk = mcpSendOk && !!mcpEntry && mcpEntry.target === `pane ${pane2}` && mcpEntry.pane === pane1

      // ── (d) the raw file leaks NOTHING ─────────────────────────────────────
      const rawFile = join(app.getPath('userData'), 'trail', `${ws.id}.jsonl`)
      const raw = readFileSync(rawFile, 'utf8')
      const noLeak =
        raw.includes(origin) && // origins are the point…
        !raw.includes('EVALBODY_4242') && // …content is not
        !raw.includes('PAGETEXT_IN_4242') &&
        !raw.includes('SECRETCOOKIE_4242') &&
        !raw.includes('SECRETQUERY_4242') &&
        !raw.includes('/deep/path') &&
        !raw.includes('MCPBODY_4242')

      // ── (e) the ring caps (a separate workspace so counts stay exact) ──────
      const RING_WS = 'ring-test-ws'
      for (let i = 0; i < 2100; i++) {
        recordTrail({ ts: Date.now(), source: 'web', workspaceId: RING_WS, verb: 'click', target: `seed-${i}`, outcome: 'ok' })
      }
      flushTrailForSmoke()
      const ring = readTrail(RING_WS)
      const ringOk =
        ring.length <= 2000 &&
        !ring.some((t) => t.target === 'seed-0') &&
        ring.some((t) => t.target === 'seed-2099')

      // ── (f) entries survive "restart" (a fresh store over the same dir) ────
      const fresh = new TrailStore(join(app.getPath('userData'), 'trail'))
      const survived = fresh.read(ws.id)
      const fOk = survived.some((t) => t.source === 'mcp' && t.verb === 'send_to_pane')

      // ── (h) the viewer renders the entries ────────────────────────────────
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(600)
      await ES(`document.querySelector('.settings-nav-item[data-target="activity"]')?.click()`) // each tab is its own page (8) — the trail lives on Trust › Activity now
      await ES(`(document.querySelector('.trail-activity .trail-btn')?.click(), 1)`) // Refresh (repopulates the ws filter)
      await sleep(600)
      // Filter to THIS workspace (the ring-seed workspace would flood the top).
      await ES(
        `(() => { const s = document.querySelector('.trail-ws'); s.value = ${JSON.stringify(ws.id)}; s.dispatchEvent(new Event('change')); return s.value })()`
      )
      await sleep(800)
      const viewer = (await ES(
        `(() => { const b = document.querySelector('.trail-activity'); return { rows: b.querySelectorAll('.trail-row').length, ok: b.querySelectorAll('.trail-badge.is-ok').length, refused: b.querySelectorAll('.trail-badge.is-refused').length, text: b.textContent.slice(0, 4000) } })()`
      )) as { rows: number; ok: number; refused: number; text: string }
      const hOk =
        viewer.rows > 0 && viewer.ok > 0 && viewer.refused > 0 &&
        viewer.text.includes(origin) && viewer.text.includes('never sent anywhere')

      // ── (g) clear-workspace empties exactly that file ──────────────────────
      clearTrail(ws.id)
      const clearedMain = readTrail(ws.id).length === 0
      const ringSurvives = readTrail(RING_WS).length > 0
      const gOk = clearedMain && ringSurvives

      const pass = aOk && bOk && !!confirmed && cOk && noLeak && ringOk && fOk && gOk && hOk
      result = {
        pass,
        aOk,
        bOk,
        confirmSeen: !!confirmed,
        cOk,
        noLeak,
        ringOk,
        ringLen: ring.length,
        fOk,
        gOk,
        hOk,
        viewerRows: viewer.rows,
        entryCount: entries.length
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    mcpClient?.kill()
    site?.close()
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
