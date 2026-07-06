import { app, BrowserWindow, type BrowserWindow as BW } from 'electron'
import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dockDebug, dockPageEval } from './browser-dock'
import { getSettingsStore } from './app-settings'

// Env-gated browser-dock smoke (MOGGING_BROWSER, Phase-6/05):
//   1. toggle on -> dock chrome shows, grid NARROWS, pane count unchanged
//   2. navigate to a smoke-served local page -> the MAIN-owned view covers the
//      dock's view rect (±2px), header url/title update
//   3. window.open from PAGE context is denied (no second BrowserWindow; the
//      external-browser handoff is suppressed under smoke env)
//   4. drag-resize (dev handle) -> view bounds follow
//   5. toggle off -> view hidden, grid re-widens
//   6. open/width/lastUrl round-trip through the settings store
// The page is served by THIS smoke on 127.0.0.1 — no external network, ever.
const PAGE_TITLE = 'MOG_BROWSER_TEST_4242'

export function runBrowserSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  let server: Server | null = null

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'browser-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const serve = (): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><title>${PAGE_TITLE}</title><h1>dock smoke</h1>`)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server?.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      const port = await serve()

      // A workspace so the dock has an active-workspace context for lastUrl.
      await ES(`window.__mogging.workspace.create({ name: 'Web' })`)
      await sleep(2000)
      const wsId = (await ES<{ id: string }>('window.__mogging.workspace.active()')).id
      const paneCountBefore = await ES<number>('window.__mogging.layout.paneCount()')
      const contentW = (): Promise<number> =>
        ES<number>(`document.getElementById('content').getBoundingClientRect().width`)
      const wBefore = await contentW()

      // ── 1. Toggle on: chrome shows, grid narrows, panes untouched ─────────
      await ES('window.__mogging.browser.toggle(true)')
      await sleep(600)
      const wOpen = await contentW()
      const narrowed = wOpen < wBefore - 200 // dock min-width is 320
      const paneCountAfter = await ES<number>('window.__mogging.layout.paneCount()')

      // ── 2. Navigate: view covers the dock rect, header follows ────────────
      await ES(`window.__mogging.browser.navigate('127.0.0.1:${port}')`)
      let titleOk = false
      for (let i = 0; i < 30 && !titleOk; i++) {
        await sleep(400)
        titleOk = (await ES<{ url: string; title: string }>('window.__mogging.browser.state()')).title === PAGE_TITLE
      }
      const rect = await ES<{ x: number; y: number; width: number; height: number }>(
        'window.__mogging.browser.viewRect()'
      )
      await sleep(400)
      const dbg = dockDebug()
      const close2 = (a: number, b: number): boolean => Math.abs(a - b) <= 2
      const boundsOk =
        !!dbg.bounds &&
        dbg.visible &&
        close2(dbg.bounds.x, rect.x) &&
        close2(dbg.bounds.y, rect.y) &&
        close2(dbg.bounds.width, rect.width) &&
        close2(dbg.bounds.height, rect.height)
      const headerUrl = (await ES<{ url: string }>('window.__mogging.browser.state()')).url
      const urlOk = headerUrl.includes(`127.0.0.1:${port}`)

      // ── 3. window.open from page context is DENIED ────────────────────────
      await dockPageEval(`window.open('http://127.0.0.1:${port}/pop')`)
      await sleep(800)
      const windowsOk = BrowserWindow.getAllWindows().length === 1

      // ── 4. Drag-resize: the view follows ──────────────────────────────────
      await ES('window.__mogging.browser.setWidth(520)')
      await sleep(400)
      const rect2 = await ES<{ width: number }>('window.__mogging.browser.viewRect()')
      const dbg2 = dockDebug()
      const resizeOk = !!dbg2.bounds && close2(dbg2.bounds.width, rect2.width) && rect2.width > rect.width

      // ── 4b. Resize FREEZE (8/07): during a continuous drag the native view
      //        is HIDDEN — the CSS chrome grows but the WebContents never
      //        reflows (viewShown stays false); it snaps back on release ─────
      await ES('window.__mogging.browser.beginResize()')
      await sleep(120)
      // frozen: main entered resize mode AND the native view is actually hidden
      const frozenActive = dockDebug().resizing === true && dockDebug().viewShown === false
      await ES('window.__mogging.browser.setWidth(600)') // chrome grows while the view stays frozen-hidden
      await sleep(200)
      const rectFrozenChrome = await ES<{ width: number }>('window.__mogging.browser.viewRect()')
      // the chrome widened, but the native view was NOT shown/reflowed meanwhile
      const heldDuringFreeze = dockDebug().viewShown === false && rectFrozenChrome.width > rect2.width
      await ES('window.__mogging.browser.endResize()')
      await sleep(400)
      // release: view shown again, snapped to the final (wider) rect in ONE step
      const snappedAfter =
        dockDebug().resizing === false && dockDebug().viewShown === true && (dockDebug().bounds?.width ?? 0) > rect2.width
      const freezeOk = frozenActive && heldDuringFreeze && snappedAfter
      await ES('window.__mogging.browser.setWidth(520)') // restore width for the persist assertion
      await sleep(200)

      // ── 5. Toggle off: hidden view, grid re-widens ────────────────────────
      await ES('window.__mogging.browser.toggle(false)')
      await sleep(600)
      const hiddenOk = !dockDebug().visible
      const wClosed = await contentW()
      const rewidened = Math.abs(wClosed - wBefore) <= 2

      // ── 6. Store round-trip (width persist is debounced 500ms) ────────────
      await sleep(900)
      const store = getSettingsStore()
      const persist = {
        open: store?.getSetting('browser.open') ?? null, // closed -> ''
        width: store?.getSetting('browser.width') ?? null,
        lastUrl: store?.getSetting(`browser.lastUrl.${wsId}`) ?? null
      }
      const persistOk =
        persist.open === '' && persist.width === '520' && persist.lastUrl === `http://127.0.0.1:${port}/`

      const pass =
        narrowed &&
        paneCountBefore === paneCountAfter &&
        titleOk &&
        boundsOk &&
        urlOk &&
        windowsOk &&
        resizeOk &&
        freezeOk &&
        hiddenOk &&
        rewidened &&
        persistOk
      result = {
        pass,
        narrowed,
        paneCountBefore,
        paneCountAfter,
        titleOk,
        boundsOk,
        urlOk,
        windowsOk,
        resizeOk,
        freezeOk,
        frozenActive,
        heldDuringFreeze,
        snappedAfter,
        hiddenOk,
        rewidened,
        persist,
        persistOk,
        bounds: dbg.bounds,
        rect
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    server?.close()
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  const w: BW = win
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
