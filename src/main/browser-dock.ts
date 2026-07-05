import { BrowserWindow, WebContentsView, ipcMain, shell, session } from 'electron'
import {
  BrowserChannels,
  type BrowserAgentActivity,
  type BrowserAgentResult,
  type BrowserAgentVerb,
  type BrowserAgentVerbName,
  type BrowserDockBounds,
  type BrowserDockInit,
  type BrowserDockState,
  type BrowserNavAction,
  type BrowserSnapshotNode
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

// ── Agent control state (6/05b) ────────────────────────────────────────────
// Consent is per-workspace, default OFF; the renderer pushes the ACTIVE
// workspace's grant here (there is ONE shared dock — the human sees the active
// workspace beside it, so its grant governs). `driving` latches while a verb is
// in flight + a grace beat, so possession is always visible.
let agentAllowed = false
let driving = false
let drivingClearTimer: NodeJS.Timeout | null = null
const trail: BrowserAgentActivity['trail'] = []
const consoleBuf: string[] = []
const netFailBuf: string[] = []
const RING = 200 // console/network ring-buffer cap

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
  // The error feedback loop (6/05b): buffer console + failed loads so an agent
  // can READ what broke. Ring-capped; a new navigation clears the last page's
  // noise. Buffers live main-side only — never logged, never telemetry.
  // Electron's console-message signature varies by version: newer passes one
  // event object ({level, message}); older passes (event, level, message, …).
  // Read both shapes (same tactic as flicker-smoke).
  wc.on('console-message', (...args: unknown[]) => {
    const a1 = args[1] as { level?: unknown; message?: unknown } | number | string | undefined
    const level = a1 && typeof a1 === 'object' ? String(a1.level ?? '') : String(a1 ?? '')
    const message = a1 && typeof a1 === 'object' ? String(a1.message ?? '') : String(args[2] ?? '')
    consoleBuf.push(`[${level}] ${message}`)
    if (consoleBuf.length > RING) consoleBuf.shift()
  })
  wc.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return // ABORTED — user/nav churn, not a failure
    netFailBuf.push(`${code} ${desc} ${url}`)
    if (netFailBuf.length > RING) netFailBuf.shift()
  })
  wc.on('did-start-navigation', (_e, _url, _inPage, isMainFrame) => {
    if (isMainFrame) {
      consoleBuf.length = 0
      netFailBuf.length = 0
    }
  })
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

// ── Agent control (6/05b): the wheel, consent-gated + visibly possessed ──────

function pushActivity(): void {
  const win = getWin?.()
  if (!win || win.isDestroyed()) return
  const activity: BrowserAgentActivity = { driving, allowed: agentAllowed, trail: trail.slice(-12) }
  win.webContents.send(BrowserChannels.activity, activity)
}

/** Latch possession ON for the verb and a grace beat after, so the human always
 *  sees the wheel is held even between rapid verbs. */
function markDriving(verb: BrowserAgentVerbName, target?: string): void {
  trail.push({ verb, target, at: Date.now() })
  if (trail.length > 50) trail.shift()
  driving = true
  if (drivingClearTimer) clearTimeout(drivingClearTimer)
  drivingClearTimer = setTimeout(() => {
    driving = false
    pushActivity()
  }, 1500)
  pushActivity()
}

/** Revoke the grant instantly (the human's Stop button). Consent stays as the
 *  workspace set it; this just drops the in-flight possession latch. */
export function agentStop(): void {
  driving = false
  if (drivingClearTimer) clearTimeout(drivingClearTimer)
  // A hard stop also halts whatever is loading, so "Stop" is literal.
  try {
    view?.webContents.stop()
  } catch {
    /* nothing loading */
  }
  pushActivity()
}

export function setAgentConsent(allowed: boolean): void {
  agentAllowed = allowed
  if (!allowed) agentStop()
  else pushActivity()
}

/** Injected once per snapshot: stamp `data-mog-ref` on interactive/labelled
 *  elements so a later click/type targets the SAME node the agent saw, and
 *  return the node list + a visible-text digest. Runs in the sandboxed page. */
const SNAPSHOT_JS = `(() => {
  const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[onclick],summary'
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none' }
  const nodes = []
  let i = 0
  document.querySelectorAll(sel).forEach((el) => {
    if (!vis(el)) return
    const ref = 'e' + (++i)
    el.setAttribute('data-mog-ref', ref)
    const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value') || '').trim().slice(0, 80)
    nodes.push({ ref, role: (el.getAttribute('role') || el.tagName.toLowerCase()), name })
  })
  const text = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 4000)
  return { nodes, text, url: location.href, title: document.title }
})()`

const byRef = (ref: string): string =>
  `document.querySelector('[data-mog-ref=${JSON.stringify(ref)}]') || document.querySelector(${JSON.stringify(ref)})`

/** Dispatch one agent verb. `origin: 'agent'` verbs are consent-gated; the dock
 *  chrome's own navigate/nav go through browserDriver directly (human, ungated). */
export async function agentAct(v: BrowserAgentVerb): Promise<BrowserAgentResult> {
  if (!agentAllowed) return { ok: false, reason: 'disabled' }
  const wc = view?.webContents ?? ensureView().webContents
  const run = (js: string): Promise<unknown> => wc.executeJavaScript(js, true)
  // Trail records a REF only — never the eval body, typed text, or a full URL
  // (navigate keeps just the origin). This is the one place content could leak.
  const refVerbs: BrowserAgentVerbName[] = ['click', 'type', 'select', 'wait_for']
  let trailTarget: string | undefined
  if (refVerbs.includes(v.verb)) trailTarget = v.target
  else if (v.verb === 'navigate' && v.target) {
    try {
      trailTarget = new URL(normalizeUrl(v.target) ?? '').origin
    } catch {
      /* unparseable — record nothing */
    }
  }
  markDriving(v.verb, trailTarget)
  try {
    switch (v.verb) {
      case 'navigate': {
        const ok = browserDriver.navigate(String(v.target ?? ''))
        return ok ? { ok: true } : { ok: false, reason: 'badtarget' }
      }
      case 'back':
      case 'forward':
      case 'reload':
        browserDriver.nav(v.verb)
        return { ok: true }
      case 'snapshot': {
        const snap = (await run(SNAPSHOT_JS)) as { nodes: BrowserSnapshotNode[]; text: string; url: string; title: string }
        return { ok: true, nodes: snap.nodes, text: snap.text, url: snap.url, title: snap.title }
      }
      case 'screenshot': {
        const img = await wc.capturePage()
        return { ok: true, png: img.toDataURL() }
      }
      case 'click': {
        if (!v.target) return { ok: false, reason: 'badtarget' }
        const hit = await run(`(() => { const el = ${byRef(v.target)}; if (!el) return false; el.click(); return true })()`)
        return hit ? { ok: true } : { ok: false, reason: 'badtarget' }
      }
      case 'type': {
        if (!v.target) return { ok: false, reason: 'badtarget' }
        const hit = await run(
          `(() => { const el = ${byRef(v.target)}; if (!el) return false; el.focus(); el.value = ${JSON.stringify(v.value ?? '')}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true })()`
        )
        return hit ? { ok: true } : { ok: false, reason: 'badtarget' }
      }
      case 'select': {
        if (!v.target) return { ok: false, reason: 'badtarget' }
        const hit = await run(
          `(() => { const el = ${byRef(v.target)}; if (!el) return false; el.value = ${JSON.stringify(v.value ?? '')}; el.dispatchEvent(new Event('change',{bubbles:true})); return true })()`
        )
        return hit ? { ok: true } : { ok: false, reason: 'badtarget' }
      }
      case 'scroll': {
        await run(`window.scrollBy(0, ${Number(v.dy ?? 400)})`)
        return { ok: true }
      }
      case 'eval': {
        // The "fully" in the ask: arbitrary page script. Its BODY never leaves
        // main (trail carries the verb name only) — result is stringified back.
        const out = await run(`(() => { try { return JSON.stringify((function(){ return (${String(v.target ?? 'undefined')}) })()) } catch (e) { return 'ERR: ' + e } })()`)
        return { ok: true, value: String(out ?? '') }
      }
      case 'console':
        return { ok: true, lines: consoleBuf.slice(-Math.max(1, v.n ?? 30)) }
      case 'network_failures':
        return { ok: true, lines: netFailBuf.slice(-Math.max(1, v.n ?? 30)) }
      case 'wait_for': {
        const timeout = Math.min(30000, Math.max(100, v.n ?? 5000))
        const deadline = Date.now() + timeout
        while (Date.now() < deadline) {
          const found = await run(`!!(${byRef(String(v.target ?? ''))})`)
          if (found) return { ok: true }
          await new Promise((r) => setTimeout(r, 150))
        }
        return { ok: false, reason: 'timeout' }
      }
      default:
        return { ok: false, reason: 'badtarget' }
    }
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 120) }
  }
}

/** Smoke-only: read the possession state main-side. */
export function agentControlDebug(): { allowed: boolean; driving: boolean; trail: BrowserAgentActivity['trail'] } {
  return { allowed: agentAllowed, driving, trail: trail.slice() }
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

  // ── Agent control (6/05b) ─────────────────────────────────────────────────
  const kvConsent = (wsId: string): string => `browser.agentControl.${wsId}`
  ipcMain.handle(BrowserChannels.consentGet, (_e, wsId: string) => store()?.getSetting(kvConsent(String(wsId))) === '1')
  ipcMain.handle(BrowserChannels.consentSet, (_e, p: { workspaceId: string; allowed: boolean }) => {
    store()?.setSetting(kvConsent(String(p?.workspaceId)), p?.allowed ? '1' : '')
  })
  // The renderer makes the ACTIVE workspace's stored grant LIVE (on switch/boot).
  ipcMain.on(BrowserChannels.consent, (_e, payload: { allowed: boolean }) => {
    setAgentConsent(!!payload?.allowed)
  })
  // An agent verb. Today the smoke calls this directly; the phase-8 MCP server
  // (8/02) registers each verb as a tool that lands HERE — one driver, one
  // gate, whatever the transport. Consent is re-checked inside agentAct.
  ipcMain.handle(BrowserChannels.agentAct, (_e, v: BrowserAgentVerb) => agentAct(v))
  ipcMain.on(BrowserChannels.agentStop, () => agentStop())
}
