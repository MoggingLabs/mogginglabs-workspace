import { app, type BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserDriver, dockDebug, dockPageEval } from './browser-dock'

// Env-gated per-workspace-browser smoke (MOGGING_PERWS, Phase-8/07b). Proves
// every workspace has its OWN browser: its own LIVE page state AND its own
// cookie jar/session (partition). One fixture origin; two workspaces:
//   A -> navigate + set cookie ws=AAA · B (same origin) sees COOKIE_none
//   (SESSION isolation — separate partitions) · set ws=BBB in B · switch back
//   to A: the dock shows A's exact page again, still COOKIE_AAA (LIVE state
//   preserved, not reloaded) · switch to B: B's page, COOKIE_BBB.
// Zero external network — the only origin is this smoke's own 127.0.0.1 server.

export function runPerWsSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  let server: Server | null = null

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'perws-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const serve = (): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((req, res) => {
        const ck = /(?:^|;\s*)ws=([^;]+)/.exec(String(req.headers.cookie ?? ''))
        const p = new URL(req.url ?? '/', 'http://x').searchParams.get('p') ?? '?'
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><title>PERWS_${p}</title><div id="mark">PAGE_${p}</div><div id="cookie">COOKIE_${ck ? ck[1] : 'none'}</div>`)
      })
      server.listen(0, '127.0.0.1', () => {
        const a = server?.address()
        resolve(typeof a === 'object' && a ? a.port : 0)
      })
    })

  const pageText = async (): Promise<string> => String((await dockPageEval('document.body.innerText')) ?? '')
  const waitFor = async (probe: () => Promise<boolean>, tries = 20, gap = 400): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await probe()) return true
      await sleep(gap)
    }
    return false
  }
  const indexOfWs = async (id: string): Promise<number> => {
    const list = (await ES<{ id: string }[]>('window.__mogging.workspace.list()')) ?? []
    return list.findIndex((w) => w.id === id)
  }
  const switchTo = async (id: string): Promise<void> => {
    const i = await indexOfWs(id)
    if (i >= 0) await ES(`window.__mogging.workspace.switchByIndex(${i})`)
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      const port = await serve()
      const origin = `http://127.0.0.1:${port}`

      // ── Workspace A: navigate + set a cookie on the origin ────────────────
      await ES(`window.__mogging.workspace.create({ name: 'WS-A' })`)
      await sleep(1800)
      const wsA = (await ES<{ id: string }>('window.__mogging.workspace.active()')).id
      await ES('window.__mogging.browser.toggle(true)')
      await sleep(600)
      await ES(`window.__mogging.browser.navigate('${origin}/?p=A')`)
      await waitFor(async () => dockDebug().url.includes('p=A'))
      await sleep(400)
      await dockPageEval(`document.cookie='ws=AAA; path=/'`)
      browserDriver.nav('reload')
      await waitFor(async () => (await pageText()).includes('COOKIE_AAA'))
      const aCookieSet = (await pageText()).includes('COOKIE_AAA')

      // ── Workspace B: SAME origin — its own partition sees no cookie ────────
      await ES(`window.__mogging.workspace.create({ name: 'WS-B' })`)
      await sleep(1800)
      const wsB = (await ES<{ id: string }>('window.__mogging.workspace.active()')).id
      await ES('window.__mogging.browser.toggle(true)')
      await sleep(500)
      await ES(`window.__mogging.browser.navigate('${origin}/?p=B')`)
      await waitFor(async () => dockDebug().url.includes('p=B'))
      await sleep(400)
      const bText0 = await pageText()
      const sessionIsolated = bText0.includes('PAGE_B') && bText0.includes('COOKIE_none') // B did NOT see A's ws=AAA
      await dockPageEval(`document.cookie='ws=BBB; path=/'`)
      browserDriver.nav('reload')
      await waitFor(async () => (await pageText()).includes('COOKIE_BBB'))

      // ── Switch back to A: its OWN live page + session, unchanged ───────────
      await switchTo(wsA)
      await waitFor(async () => dockDebug().url.includes('p=A'))
      await sleep(500)
      const aUrl = dockDebug().url
      const aText = await pageText()
      // Live state preserved: A's page still shows COOKIE_AAA (never reloaded to
      // blank, session A intact) and its exact url.
      const aPreserved = aUrl.includes(`${origin}/?p=A`) && aText.includes('PAGE_A') && aText.includes('COOKIE_AAA')

      // ── Switch to B: its own page + session ───────────────────────────────
      await switchTo(wsB)
      await waitFor(async () => dockDebug().url.includes('p=B'))
      await sleep(500)
      const bUrl = dockDebug().url
      const bText = await pageText()
      const bPreserved = bUrl.includes(`${origin}/?p=B`) && bText.includes('PAGE_B') && bText.includes('COOKIE_BBB')

      // The two workspaces show DIFFERENT browsers.
      const distinctBrowsers = aUrl !== bUrl && wsA !== wsB

      const pass = aCookieSet && sessionIsolated && aPreserved && bPreserved && distinctBrowsers
      result = { pass, aCookieSet, sessionIsolated, aPreserved, bPreserved, distinctBrowsers, aUrl, bUrl, bText0: bText0.slice(0, 80) }
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
