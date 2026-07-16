import { app, BrowserWindow, type BrowserWindow as BW } from 'electron'
import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dockDebug, dockPageEval } from '../browser-dock'
import { getSettingsStore } from '../app-settings'

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
  // The dock-width assertions (settle at 380) assume the dev window's 1200 width; on the
  // 1024-wide CI displays the layout's own cap clamps the dock below that and the gate
  // fails arithmetic it never meant to test. Pin the authored size (see explorer-smoke).
  win.setSize(1200, 800)
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

      // ── 2. Navigate: the guest <webview> IS the page and FILLS the dock's
      //       view host (8/07 — no main-owned view; the guest is in the DOM) ──
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
      const close2 = (a: number, b: number): boolean => Math.abs(a - b) <= 2
      const guestReady = await ES<boolean>('window.__mogging.browser.guestReady()')
      const guestRect = await ES<{ x: number; y: number; width: number; height: number } | null>(
        'window.__mogging.browser.guestRect()'
      )
      // The guest occupies the whole view host — no separate layer to lag.
      const guestFillsOk =
        !!guestRect &&
        guestReady &&
        dockDebug().url.includes(`127.0.0.1:${port}`) &&
        close2(guestRect.x, rect.x) &&
        close2(guestRect.y, rect.y) &&
        close2(guestRect.width, rect.width) &&
        close2(guestRect.height, rect.height)
      const headerUrl = (await ES<{ url: string }>('window.__mogging.browser.state()')).url
      const urlOk = headerUrl.includes(`127.0.0.1:${port}`)

      // ── 3. window.open from page context is DENIED ────────────────────────
      await dockPageEval(`window.open('http://127.0.0.1:${port}/pop')`)
      await sleep(800)
      const windowsOk = BrowserWindow.getAllWindows().length === 1

      // ── 4. Resize is LOCKSTEP (8/07): the dock and the guest are one DOM
      //       layout — after a width change the guest rect EQUALS the view host
      //       rect exactly, and the page is NOT reloaded (same url) ───────────
      const urlBeforeResize = dockDebug().url
      await ES('window.__mogging.browser.setWidth(560)')
      await sleep(400)
      const rect2 = await ES<{ width: number }>('window.__mogging.browser.viewRect()')
      const guestRect2 = await ES<{ width: number; height: number } | null>('window.__mogging.browser.guestRect()')
      const resizeLockstepOk =
        rect2.width > rect.width && // the dock grew
        !!guestRect2 &&
        close2(guestRect2.width, rect2.width) && // the guest grew WITH it, exactly
        dockDebug().url === urlBeforeResize // no reflow-from-scratch; same live page
      // Settle at a width the window can actually GIVE. The dock is no longer free to be any
      // width it likes: it lives inside the responsive budget (src/ui/core/layout/dock-budget.ts),
      // which keeps a 480px floor under the pane grid — so at this window (1200) the dock tops
      // out at 432, and the 520 this gate used to ask for was a dock there is no room for. The
      // product clamped it and persisted the clamp, honestly; the gate then failed the product
      // for obeying its own layout law. 380 is INSIDE the budget and is neither the boot default
      // (420) nor the clamp (432) — so the store round-trip below still proves it is the width
      // the user CHOSE that came back, and not a default or a ceiling wearing its clothes.
      const SETTLE_W = 380
      await ES(`window.__mogging.browser.setWidth(${SETTLE_W})`)
      await sleep(600) // let the debounced width-persist (400ms) fire
      const settledWidth = await ES<number>('window.__mogging.browser.width()') // what the dock TOOK

      // ── 5. Toggle off: dock closed, grid re-widens ────────────────────────
      await ES('window.__mogging.browser.toggle(false)')
      await sleep(600)
      const closedOk = dockDebug().open === false
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
      // The width the DOCK settled on is the width the STORE holds — one number, no drift.
      const persistOk =
        persist.open === '' &&
        settledWidth === SETTLE_W &&
        persist.width === String(SETTLE_W) &&
        persist.lastUrl === `http://127.0.0.1:${port}/`

      const pass =
        narrowed &&
        paneCountBefore === paneCountAfter &&
        titleOk &&
        guestFillsOk &&
        urlOk &&
        windowsOk &&
        resizeLockstepOk &&
        closedOk &&
        rewidened &&
        persistOk
      result = {
        pass,
        narrowed,
        paneCountBefore,
        paneCountAfter,
        titleOk,
        guestFillsOk,
        urlOk,
        windowsOk,
        resizeLockstepOk,
        closedOk,
        rewidened,
        persist,
        settledWidth,
        persistOk,
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
