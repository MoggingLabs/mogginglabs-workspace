import { BrowserWindow, WebContentsView, ipcMain, shell, session } from 'electron'
import {
  BrowserChannels,
  type BrowserDockBounds,
  type BrowserDockInit,
  type BrowserDockState,
  type BrowserNavAction
} from '@contracts'
import { getSettingsStore } from './app-settings'

/**
 * The browser dock's MAIN side (Phase-6/05). Split in two, deliberately:
 *   `dock`   — WebContentsView lifecycle, bounds, visibility, persistence.
 *   `driver` — verb-shaped navigate/read acts. The dock chrome calls these
 *              over IPC today; 6/05b hands the SAME verbs to agents via the
 *              phase-8 MCP server. Build nothing here that assumes a human.
 * ADR 0002: the view runs its own persistent partition (normal cookies for
 * the user's browsing, isolated from the app's session) and we inject and
 * read NOTHING — no cookie access, no auth automation, no preload.
 */

const KV_OPEN = 'browser.open'
const KV_WIDTH = 'browser.width'
const kvLastUrl = (workspaceId: string): string => `browser.lastUrl.${workspaceId}`
const DEFAULT_WIDTH = 420

let view: WebContentsView | null = null
let getWin: (() => BrowserWindow | null) | null = null
let lastBounds: BrowserDockBounds | null = null
let open = false
let widthPersistTimer: NodeJS.Timeout | null = null

/** http(s) only — scheme-less input gets http:// (localhost:3000 just works). */
function normalizeUrl(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) ? t : `http://${t}`
  try {
    const u = new URL(withScheme)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

function pushState(): void {
  const win = getWin?.()
  if (!win || win.isDestroyed()) return
  const wc = view?.webContents
  const state: BrowserDockState = {
    url: wc?.getURL() ?? '',
    title: wc?.getTitle() ?? '',
    canGoBack: wc?.navigationHistory.canGoBack() ?? false,
    canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    loading: wc?.isLoading() ?? false
  }
  win.webContents.send(BrowserChannels.state, state)
}

function applyBounds(): void {
  if (!view || !lastBounds) return
  view.setBounds({
    x: Math.round(lastBounds.x),
    y: Math.round(lastBounds.y),
    width: Math.round(lastBounds.width),
    height: Math.round(lastBounds.height)
  })
  view.setVisible(open && lastBounds.visible)
}

/** Lazily create the view on first navigation — until then the renderer's
 *  empty state shows through (and the gallery can shoot the dock offline). */
function ensureView(): WebContentsView {
  if (view) return view
  const ses = session.fromPartition('persist:browser-dock')
  // Deny-all permissions, scoped to the DOCK's partition only (the app's own
  // session is untouched — a handler on the default session would govern both).
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const wc = view.webContents
  wc.setWindowOpenHandler(({ url }) => {
    // New windows never spawn in-app; http(s) goes to the system browser.
    // Smoke runs must not launch the user's real browser (sweep hygiene).
    const ok = normalizeUrl(url)
    if (ok && !Object.keys(process.env).some((k) => k.startsWith('MOGGING_'))) void shell.openExternal(ok)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (!normalizeUrl(url)) e.preventDefault() // http(s) only, ever
  })
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
    wc.on(ev as never, () => pushState())
  }
  const win = getWin?.()
  if (win && !win.isDestroyed()) win.contentView.addChildView(view)
  applyBounds()
  return view
}

/** The verb seam (6/05b exposes these to agents — keep them human-free). */
export const browserDriver = {
  navigate(rawUrl: string): boolean {
    const url = normalizeUrl(rawUrl)
    if (!url) return false
    void ensureView().webContents.loadURL(url)
    return true
  },
  nav(action: BrowserNavAction): void {
    const wc = view?.webContents
    if (!wc) return
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
  },
  state(): BrowserDockState {
    const wc = view?.webContents
    return {
      url: wc?.getURL() ?? '',
      title: wc?.getTitle() ?? '',
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      loading: wc?.isLoading() ?? false
    }
  }
}

/** Smoke-only: run script INSIDE the dock page (the window.open denial probe
 *  needs the attempt to originate from page context). Never used by features. */
export function dockPageEval(js: string): Promise<unknown> | null {
  return view ? view.webContents.executeJavaScript(js, true) : null
}

/** Smoke-only ground truth (main-side): where the view actually is. */
export function dockDebug(): { attached: boolean; visible: boolean; bounds: BrowserDockBounds | null; url: string } {
  return {
    attached: !!view,
    visible: !!view && open && !!lastBounds?.visible,
    bounds: lastBounds,
    url: view?.webContents.getURL() ?? ''
  }
}

export function registerBrowserDock(winGetter: () => BrowserWindow | null): void {
  getWin = winGetter
  const store = (): ReturnType<typeof getSettingsStore> => getSettingsStore()

  ipcMain.handle(BrowserChannels.init, (): BrowserDockInit => {
    const s = store()
    open = s?.getSetting(KV_OPEN) === '1'
    const width = Number(s?.getSetting(KV_WIDTH)) || DEFAULT_WIDTH
    return { open, width }
  })

  ipcMain.handle(BrowserChannels.toggle, (_e, payload: { open: boolean; workspaceId?: string }) => {
    open = !!payload?.open
    store()?.setSetting(KV_OPEN, open ? '1' : '')
    // First open with nothing loaded -> restore this workspace's last preview.
    if (open && !view && payload?.workspaceId) {
      const last = store()?.getSetting(kvLastUrl(payload.workspaceId))
      if (last) browserDriver.navigate(last)
    }
    applyBounds()
    pushState()
  })

  ipcMain.handle(BrowserChannels.navigate, (_e, payload: { url: string; workspaceId?: string }) => {
    const ok = browserDriver.navigate(String(payload?.url ?? ''))
    if (ok && payload?.workspaceId) {
      const url = normalizeUrl(String(payload.url))
      if (url) store()?.setSetting(kvLastUrl(payload.workspaceId), url)
    }
    return ok
  })

  ipcMain.handle(BrowserChannels.nav, (_e, payload: { action: BrowserNavAction }) => {
    browserDriver.nav(payload?.action)
  })

  ipcMain.handle(BrowserChannels.lastUrl, (_e, workspaceId: string) => {
    return store()?.getSetting(kvLastUrl(String(workspaceId))) ?? null
  })

  ipcMain.handle(BrowserChannels.openExternal, (_e, payload: { url: string }) => {
    const url = normalizeUrl(String(payload?.url ?? ''))
    if (url) void shell.openExternal(url)
  })

  ipcMain.on(BrowserChannels.bounds, (_e, b: BrowserDockBounds) => {
    lastBounds = b
    applyBounds()
    // Persist the dock width, debounced — drags emit a bounds stream.
    if (widthPersistTimer) clearTimeout(widthPersistTimer)
    widthPersistTimer = setTimeout(() => store()?.setSetting(KV_WIDTH, String(Math.round(b.dockWidth))), 500)
  })
}
