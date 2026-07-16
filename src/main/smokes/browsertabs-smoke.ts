import { app, BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BrowserAgentResult } from '@contracts'
import { agentAct, dockPageEval, setAgentConsent } from '../browser-dock'

// Env-gated tabs smoke (MOGGING_BROWSERTABS, Wave 7 / F4):
//   1. A fresh workspace opens with ONE (base) tab; the strip is shown.
//   2. New tab → two tabs, the new one active; navigating it labels its tab.
//   3. Switch back to the base tab → the header follows it; close the extra tab.
//   4. A page's target=_blank / window.open opens a NEW TAB (not the system browser,
//      not a second OS window).
//   5. The agent verbs: browser_tab_new opens + returns the list, browser_tab_list
//      counts them, browser_tab_select switches — all driving the SAME tabs a human
//      sees, gated by the workspace consent.
// Served locally on 127.0.0.1 — no external network, ever.

export function runBrowserTabsSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000)
  win.setSize(1200, 800)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  let server: Server | null = null

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'browsertabs-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const serve = (): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((req, res) => {
        const n = req.url?.slice(1) || 'root'
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><title>TAB_${n}</title><body><a id="blank" href="/opened" target="_blank">open</a></body>`)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server?.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

  const B = 'window.__mogging.browser'
  const act = (v: Parameters<typeof agentAct>[0], pane?: string): Promise<BrowserAgentResult> => agentAct(v, pane ? { pane } : undefined)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      const port = await serve()
      await ES(`window.__mogging.workspace.create({ name: 'Tabs' })`)
      await sleep(1500)
      await ES(`${B}.toggle(true)`)
      await sleep(600)

      // ── 1. One base tab, strip shown ─────────────────────────────────────
      const startCount = await ES<number>(`${B}.tabCount()`)
      const stripShown = await ES<boolean>(`${B}.tabStripShown()`)

      // Navigate the base tab so it has a label.
      await ES(`${B}.navigate('127.0.0.1:${port}/root')`)
      await sleep(1000)

      // ── 2. New tab → two tabs, the new one active + labelled ─────────────
      await ES(`${B}.newTab('http://127.0.0.1:${port}/second')`)
      let twoTabs = false
      for (let i = 0; i < 20 && !twoTabs; i++) {
        await sleep(250)
        twoTabs = (await ES<number>(`${B}.tabCount()`)) === 2
      }
      const activeIdx = await ES<number>(`${B}.activeTabIndex()`)
      let secondLabelled = false
      for (let i = 0; i < 20 && !secondLabelled; i++) {
        await sleep(250)
        secondLabelled = (await ES<string[]>(`${B}.tabLabels()`)).some((l) => l.includes('TAB_second'))
      }

      // ── 3. Switch to base, then close the extra tab ──────────────────────
      await ES(`${B}.selectTabIndex(0)`)
      await sleep(500)
      const backToBase = (await ES<number>(`${B}.activeTabIndex()`)) === 0
      const headerFollowed = (await ES<{ url: string }>(`${B}.state()`)).url.includes('/root')
      await ES(`${B}.closeTabIndex(1)`)
      await sleep(500)
      const closedOk = (await ES<number>(`${B}.tabCount()`)) === 1

      // ── 4. target=_blank opens a NEW TAB, not a window ───────────────────
      const windowsBefore = BrowserWindow.getAllWindows().length
      await dockPageEval(`(document.getElementById('blank') && document.getElementById('blank').click(), 0)`)
      let blankOpenedTab = false
      for (let i = 0; i < 20 && !blankOpenedTab; i++) {
        await sleep(250)
        blankOpenedTab = (await ES<number>(`${B}.tabCount()`)) === 2
      }
      const noNewWindow = BrowserWindow.getAllWindows().length === windowsBefore
      // Reset to one tab for the agent arm.
      await ES(`${B}.selectTabIndex(0)`)
      await ES(`${B}.closeTabIndex(1)`)
      await sleep(400)

      // ── 5. Agent verbs drive the SAME tabs (consent-gated) ───────────────
      const wsOrdinal = (await ES<{ ordinal: number }>('window.__mogging.workspace.active()')).ordinal
      const pane = String(wsOrdinal * 100 + 1)
      setAgentConsent(false)
      const refusedTabNew = await act({ verb: 'tab_new' }, pane)
      setAgentConsent(true)
      const agentNew = await act({ verb: 'tab_new', target: `127.0.0.1:${port}/agent` }, pane)
      await sleep(800)
      const agentList = await act({ verb: 'tab_list' }, pane)
      const listOk = (agentList.tabs?.length ?? 0) >= 2
      const agentSelect = await act({ verb: 'tab_select', target: '0' }, pane)
      const selectOk = agentSelect.ok && agentSelect.activeTabId != null
      const agentTabsOk =
        refusedTabNew.reason === 'disabled' &&
        agentNew.ok === true &&
        (agentNew.tabs?.length ?? 0) >= 2 &&
        listOk &&
        selectOk

      const pass =
        startCount === 1 && stripShown && twoTabs && activeIdx === 1 && secondLabelled &&
        backToBase && headerFollowed && closedOk && blankOpenedTab && noNewWindow && agentTabsOk
      result = {
        pass,
        startCount,
        stripShown,
        twoTabs,
        activeIdx,
        secondLabelled,
        backToBase,
        headerFollowed,
        closedOk,
        blankOpenedTab,
        noNewWindow,
        agentTabsOk,
        agentDiag: {
          refused: refusedTabNew.reason,
          newTabs: agentNew.tabs?.length,
          listTabs: agentList.tabs?.length,
          select: { ok: agentSelect.ok, active: agentSelect.activeTabId }
        }
      }
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

void BrowserWindow
