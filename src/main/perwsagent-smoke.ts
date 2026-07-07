import { app, type BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentAct, agentPossessionDebug, confirmPendingActOrigin, dockDebug, setAgentConsent } from './browser-dock'
import { setIntegrationsGrant } from './integrations'
import type { BrowserAgentResult } from '@contracts'

// Env-gated per-workspace AGENT-browser smoke (MOGGING_PERWSAGENT, Phase-8/07c).
// An agent drives ITS OWN workspace's browser even when a DIFFERENT workspace
// is foreground — never the foreground one — and that browser is pinned from
// eviction with its tab marked. Two workspaces, one fixture origin:
//   A (agent-web, granted its origin) is loaded + confirmed while foreground;
//   then B becomes foreground; an agent call carrying A's pane still ACTS on
//   A's browser (click + snapshot see A), B's foreground browser stays blank
//   (untouched), A shows agent-attached (pinned + tab dot), and an ungranted
//   origin still refuses. Zero external network (only this smoke's 127.0.0.1).

export function runPerWsAgentSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  let server: Server | null = null

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'perwsagent-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const serve = (): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((req, res) => {
        const p = new URL(req.url ?? '/', 'http://x').searchParams.get('p') ?? '?'
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><title>PWA_${p}</title><button id="go" onclick="var d=document.createElement('div');d.id='clicked';d.textContent='CLICKED_${p}';document.body.appendChild(d)">Go</button><div id="mark">MARK_${p}</div>`)
      })
      server.listen(0, '127.0.0.1', () => {
        const a = server?.address()
        resolve(typeof a === 'object' && a ? a.port : 0)
      })
    })

  const paneOf = (ordinal: number): string => String(ordinal * 100 + 1)
  const waitFor = async (probe: () => Promise<boolean> | boolean, tries = 25, gap = 300): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gap)
    }
    return false
  }
  const act = (v: Parameters<typeof agentAct>[0], pane: string): Promise<BrowserAgentResult> => agentAct(v, { pane })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      const port = await serve()
      const origin = `http://127.0.0.1:${port}`

      // ── Workspace A (agent-web, granted its origin), foreground, loaded ───
      await ES(`window.__mogging.workspace.create({ name: 'A' })`)
      await sleep(1800)
      const wsA = await ES<{ id: string; ordinal: number }>('window.__mogging.workspace.active()')
      const paneA = paneOf(wsA.ordinal)
      await ES('window.__mogging.browser.toggle(true)')
      await sleep(500)
      await ES(`window.__mogging.browser.setProfile('agent-web')`)
      await sleep(600)
      setAgentConsent(true, wsA.id)
      setIntegrationsGrant({ workspaceId: wsA.id, writeTools: 'none', web: 'signed-in', actOrigins: [origin] })
      // Human loads A's browser (ungated) + confirms the act-origin while A is
      // foreground (visible possession — you approve the browser you see).
      await ES(`window.__mogging.browser.navigate('${origin}/?p=A')`)
      await waitFor(() => dockDebug().url.includes('p=A'))
      await act({ verb: 'click', target: 'button' }, paneA) // -> pending confirm for A (A active)
      await sleep(300)
      confirmPendingActOrigin(origin)

      // ── Workspace B becomes the FOREGROUND (its own agent-web) ────────────
      await ES(`window.__mogging.workspace.create({ name: 'B' })`)
      await sleep(1800)
      const wsB = await ES<{ id: string; ordinal: number }>('window.__mogging.workspace.active()')
      await ES(`window.__mogging.browser.setProfile('agent-web')`)
      await sleep(600)
      setAgentConsent(true, wsB.id)
      const foregroundIsB = dockDebug().workspaceId === wsB.id && !dockDebug().url.includes(`${port}`)

      // ── The agent (A's pane) ACTS on A's browser while B is foreground ────
      const clickA = await act({ verb: 'click', target: 'button' }, paneA)
      const snapA = await act({ verb: 'snapshot' }, paneA)
      const drivenA =
        clickA.ok && (snapA.text ?? '').includes('MARK_A') && (snapA.text ?? '').includes('CLICKED_A') && (snapA.url ?? '').includes('p=A')

      // B's foreground browser never navigated — still blank.
      const bUntouched = !dockDebug().url.includes(`${port}`) && dockDebug().workspaceId === wsB.id

      // A is agent-attached (pinned) with its tab marked.
      const poss = agentPossessionDebug()
      const aAttached = poss.attached.includes(wsA.id)
      const tabMarked = await waitFor(
        async () => (await ES<boolean>(`!!document.querySelector('.workspace-tab[data-ws-id="${wsA.id}"].is-agent-browsing')`)) === true
      )

      // An ungranted origin (localhost != 127.0.0.1) still refuses for A.
      const refused = await act({ verb: 'navigate', target: `http://localhost:${port}/?p=A` }, paneA)
      const ungrantedRefused = !refused.ok && /ungranted origin|awaiting the human/.test(refused.reason ?? '')

      const pass = foregroundIsB && drivenA && bUntouched && aAttached && tabMarked && ungrantedRefused
      result = { pass, foregroundIsB, drivenA, bUntouched, aAttached, tabMarked, ungrantedRefused, clickReason: clickA.reason, attached: poss.attached }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    server?.close()
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
