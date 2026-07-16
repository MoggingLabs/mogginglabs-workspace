import { BrowserWindow, ipcMain, shell, session, webContents, type Session, type WebContents } from 'electron'
import {
  BrowserChannels,
  DEFAULT_SEARCH_TEMPLATE,
  browserAgentWebPartition,
  type BrowserAgentActivity,
  type BrowserAgentResult,
  type BrowserAgentVerb,
  type BrowserAgentVerbName,
  type BrowserContextMenuParams,
  type BrowserDockInit,
  type BrowserDockState,
  type BrowserGuestChord,
  type BrowserNavAction,
  type BrowserPossession,
  type BrowserProfile,
  type BrowserSignedInSite,
  type BrowserSnapshotNode,
  type BrowserTab,
  type BrowserTabsState
} from '@contracts'
import { isBlockedActOrigin } from '@backend/features/integrations'
import { getSettingsStore } from './app-settings'
import { getIntegrationsGrant, workspaceIdForPane } from './integrations'
import { recordBrowserRaceAudit, waitForBrowserRaceAudit } from './browser-race-audit-faults'
import { consumeConsentSetFailure, maybeFault } from './fault-port'
import { vaultDisabled } from './fixture-port'
import { isLivePane } from './daemon-relay'
import { setVaultProbeForSmoke, vaultAvailable } from './vault'
import { recordTrail } from './trail'
import { SNAPSHOT_JS, clickScript, existsScript, scrollScript, selectScript, typeScript } from './browser-page-scripts'
import { applyGuestSessionPolicy, chromeUserAgent } from './browser-guest-policy'

/**
 * The browser dock's MAIN side (Phase-6/05; 8/07 moved the page to in-DOM
 * <webview>s; 8/07b made them PER-WORKSPACE). Every workspace has its OWN
 * browser — its own live page state AND its own cookie jar/session (partition)
 * — so switching workspaces switches the dock to that workspace's browser, and
 * you can be signed into different accounts per workspace. The renderer owns
 * the <webview> elements (keyed by workspace × profile); this module is the
 * DRIVER, reaching the ACTIVE workspace's active-profile guest by its
 * webContents id. Every verb, gate, consent, and trail is unchanged.
 * Isolation holds (ADR 0002 / docs/13): each guest runs OUT of process in its
 * own partition/sandbox; the page never enters this trusted renderer, and we
 * touch nothing but a workspace's OWN agent-web partition, at the user's
 * request. Branch B (system cookie stores) stays parked.
 */

const KV_OPEN = 'browser.open'
const KV_WIDTH = 'browser.width'
const KV_SEARCH = 'browser.searchEngine'
const kvLastUrl = (workspaceId: string): string => `browser.lastUrl.${workspaceId}`
const kvProfile = (workspaceId: string): string => `browser.profile.${workspaceId}`
const kvConsent = (workspaceId: string): string => `browser.agentControl.${workspaceId}`
const DEFAULT_WIDTH = 420
// A workspace stays "agent-attached" (pinned from LRU eviction, indicator on
// its tab) this long after an agent last drove its browser (8/07c).
const AGENT_ATTACH_MS = 5 * 60_000

let getWin: (() => BrowserWindow | null) | null = null
let open = false
let profile: BrowserProfile = 'preview' // the ACTIVE workspace's profile
let activeWorkspaceId = ''

// Guest webContents ids, keyed `${workspaceId}:${profile}#${tabId}` (registered by
// the renderer's <webview>s on dom-ready). Tabs (F4): each (workspace, profile) holds
// an ordered set of tabs, one guest each; the renderer owns their lifecycle and tells
// main which is ACTIVE, so the driver (activeWc) always resolves the tab you see.
// `BASE_TAB` is the implicit first tab — every pre-tabs path defaults to it, so nothing
// that never opened a second tab changed.
const BASE_TAB = 't0'
const guestKey = (workspaceId: string, p: BrowserProfile, tabId: string = BASE_TAB): string => `${workspaceId}:${p}#${tabId}`
const guestIds = new Map<string, number>()
const wiredGuests = new Set<number>()
const hardenedSessions = new WeakSet<Session>()
const pendingNav = new Map<string, string>()
// The active tab per `${workspaceId}:${profile}` (renderer-published). Absent → BASE_TAB.
const activeTab = new Map<string, string>()
const wpKey = (workspaceId: string, p: BrowserProfile): string => `${workspaceId}:${p}`
const activeTabFor = (workspaceId: string, p: BrowserProfile): string => activeTab.get(wpKey(workspaceId, p)) ?? BASE_TAB
// The renderer's tab list per (workspace, profile), cached so an agent's `browser_tab_list`
// can answer and `browser_tab_select` can resolve an index → tab id.
const tabsCache = new Map<string, BrowserTabsState>()
const tabsSnapshot = (workspaceId: string, p: BrowserProfile): { tabs: BrowserTab[]; activeTabId: string } => {
  const s = tabsCache.get(wpKey(workspaceId, p))
  return { tabs: s?.tabs ?? [{ id: BASE_TAB, url: '', title: '' }], activeTabId: s?.activeId ?? activeTabFor(workspaceId, p) }
}
/** Poll the tab cache (updated by the renderer's tabsState pushes) until `pred` holds
 *  or a short deadline lapses — the tab verbs return the settled tab list. */
async function waitForTabs(
  workspaceId: string,
  p: BrowserProfile,
  pred: (tabs: BrowserTab[], activeId: string) => boolean
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const snap = tabsSnapshot(workspaceId, p)
    if (pred(snap.tabs, snap.activeTabId)) return
    await new Promise((r) => setTimeout(r, 100))
  }
}
// Per-GUEST console/network rings (keyed by webContents id) so workspaces and
// profiles never interleave.
const bufs = new Map<number, { console: string[]; net: string[] }>()
const RING = 200
// One console.log of a giant object must not become the whole tail's budget.
const RING_LINE_CAP = 500
const capLine = (s: string): string => (s.length > RING_LINE_CAP ? `${s.slice(0, RING_LINE_CAP)}…` : s)

// Vault-conditioned agent-web persistence (ADR 0008.h) — machine-global,
// governed by the ONE shared vault probe (8/08).
let agentWebPersists = true
export function setAgentWebVaultProbeForSmoke(probe: (() => boolean) | null): void {
  setVaultProbeForSmoke(probe)
}
function refreshVault(): void {
  agentWebPersists = !vaultDisabled() && vaultAvailable()
}

// ── Agent control state (6/05b), now PER-WORKSPACE (8/07c) ──────────────────
// Each agent drives ITS OWN workspace's browser (resolved from its pane), gated
// by that workspace's consent/grant — never the foreground one. So possession,
// confirms, and the recent-acts trail are all keyed by workspace.
interface WsAgent {
  driving: boolean
  epoch: number
  nextOperation: number
  activeOperations: Set<number>
  confirmed: Set<string> // origins the human allowed this possession
  pendingConfirm: string | null
  recent: BrowserAgentActivity['trail'] // recent verbs for the dock's ⋯ menu
  pane: string | null // WHICH agent holds the wheel (its pane) — visible identity (goal 6)
  lastVerb: BrowserAgentVerbName | null // the live "Clicking…/Reading…" action
}
const wsAgent = new Map<string, WsAgent>()
const lastAgentAct = new Map<string, number>() // ws -> last agent verb (pin window)
function wsa(wsId: string): WsAgent {
  let s = wsAgent.get(wsId)
  if (!s) {
    s = {
      driving: false,
      epoch: 0,
      nextOperation: 0,
      activeOperations: new Set(),
      confirmed: new Set(),
      pendingConfirm: null,
      recent: [],
      pane: null,
      lastVerb: null
    }
    wsAgent.set(wsId, s)
  }
  return s
}
const consentFor = (wsId: string): boolean => getSettingsStore()?.getSetting(kvConsent(wsId)) === '1'
const profileForWs = (wsId: string): BrowserProfile =>
  getSettingsStore()?.getSetting(kvProfile(wsId)) === 'agent-web' ? 'agent-web' : 'preview'
const agentAttached = (wsId: string): boolean => Date.now() - (lastAgentAct.get(wsId) ?? 0) < AGENT_ATTACH_MS

function guestWc(workspaceId: string, p: BrowserProfile, tabId?: string): WebContents | null {
  const id = guestIds.get(guestKey(workspaceId, p, tabId ?? activeTabFor(workspaceId, p)))
  if (id == null) return null
  const wc = webContents.fromId(id)
  return wc && !wc.isDestroyed() ? wc : null
}
const activeWc = (): WebContents | null => guestWc(activeWorkspaceId, profile)

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

const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function pushState(): void {
  const win = getWin?.()
  if (!win || win.isDestroyed()) return
  const wc = activeWc()
  const url = wc?.getURL() ?? ''
  const state: BrowserDockState = {
    workspaceId: activeWorkspaceId,
    url: url === 'about:blank' ? '' : url,
    title: wc?.getTitle() ?? '',
    canGoBack: wc?.navigationHistory.canGoBack() ?? false,
    canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    loading: wc?.isLoading() ?? false,
    profile,
    agentWebPersists
  }
  win.webContents.send(BrowserChannels.state, state)
}

/** Deny-all permissions + a Chrome-honest UA on a guest's ACTUAL session (correct
 *  regardless of the partition name), the app's own session untouched. Idempotent
 *  per session. See browser-guest-policy.ts for why the UA is stripped. */
function hardenSession(ses: Session): void {
  if (hardenedSessions.has(ses)) return
  hardenedSessions.add(ses)
  applyGuestSessionPolicy(ses, (permission) => {
    // Honest denial (F16): the deny stands; the chrome just says so, briefly.
    const win = getWin?.()
    if (win && !win.isDestroyed()) win.webContents.send(BrowserChannels.permissionBlocked, { permission })
  })
  // The HTTP error loop (F11): a 4xx/5xx from the dev server is invisible to
  // did-fail-load (that page "loaded"). Feed status >= 400 into the same per-guest
  // net ring the agent reads via `network_failures`, routed by webContents id so
  // profiles/workspaces on this shared session never interleave.
  ses.webRequest.onCompleted((details) => {
    if (details.statusCode < 400) return
    const id = details.webContentsId
    if (id == null) return
    const ring = bufs.get(id)
    if (!ring) return
    ring.net.push(capLine(`${details.statusCode} ${details.method} ${details.url}`))
    if (ring.net.length > RING) ring.net.shift()
  })
}

/** The window-open policy for a guest AND any child window it spawns (recursive).
 *  A real popup (window features, or an explicit new-window disposition) is how
 *  OAuth sign-in works — it opens as a child window on the SAME session (same
 *  cookies), so the provider's `postMessage`/`window.opener` handshake completes;
 *  ADR 0002 holds (still our own partition, never the system browser's). Anything
 *  else (a plain target=_blank link) navigates the opening guest itself, Comet-
 *  style — never silently kicking the user out to the system browser (the globe
 *  button is the one explicit door for that). http(s) only. */
function guestWindowOpenHandler(wc: WebContents, onNewTab?: (url: string) => void): Parameters<WebContents['setWindowOpenHandler']>[0] {
  return (details) => {
    const url = normalizeUrl(details.url)
    if (!url) return { action: 'deny' }
    const isPopup = !!details.features || details.disposition === 'new-window'
    if (!isPopup) {
      // A plain target=_blank: open it in a NEW TAB (F4) when this is a tabbed guest,
      // else (a popup child window) navigate the window itself. Never the system browser.
      if (onNewTab) onNewTab(url)
      else if (!wc.isDestroyed()) void wc.loadURL(url)
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520,
        height: 640,
        autoHideMenuBar: true,
        // The child inherits the opener's session (same partition, same cookies);
        // these mirror the guest's own isolation so a popup is no weaker than the
        // page that opened it.
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      }
    }
  }
}

/** Harden a popup child window the instant it exists: same session policy (idempotent),
 *  the same window-open + navigation guards, http(s) only. */
function wireChildWindow(child: WebContents): void {
  applyGuestSessionPolicy(child.session) // shared session — idempotent, but explicit
  child.setUserAgent(chromeUserAgent())
  child.setWindowOpenHandler(guestWindowOpenHandler(child))
  // RECURSE: a popup can spawn a popup. Without this, a grandchild window inherits no
  // will-navigate guard and could be pointed at file:// (a sandboxed file:// document IS
  // the file's bytes and can exfiltrate them). Match wireGuest's child wiring, all the
  // way down.
  child.on('did-create-window', (win) => {
    if (!win.isDestroyed()) wireChildWindow(win.webContents)
  })
  child.on('will-navigate', (e, url) => {
    if (!normalizeUrl(url) && url !== 'about:blank') e.preventDefault()
  })
}

/** Attach the driver's listeners to a freshly-registered guest — idempotent
 *  per webContents id. `wsId` is the OWNING workspace (its trail entries). */
function wireGuest(p: BrowserProfile, wc: WebContents, wsId: string): void {
  if (wiredGuests.has(wc.id)) return
  wiredGuests.add(wc.id)
  hardenSession(wc.session)
  // navigator.userAgent is per-webContents (the session UA only sets the request
  // header); set both so scripts AND requests read Chrome-honest (F2).
  wc.setUserAgent(chromeUserAgent())
  bufs.set(wc.id, { console: [], net: [] })
  const ring = bufs.get(wc.id)!
  wc.setWindowOpenHandler(
    guestWindowOpenHandler(wc, (url) => {
      // Defense in depth on the signed-in profile: a page's window.open / target=_blank
      // must never point the agent-web browser at a SENSITIVE origin (bank/mail/gov) —
      // those refuse at BOTH ends, whoever triggered the open. Preview is unrestricted.
      if (p === 'agent-web' && isBlockedActOrigin(originOf(url))) return
      const win = getWin?.()
      if (win && !win.isDestroyed()) win.webContents.send(BrowserChannels.tabOpen, { workspaceId: wsId, profile: p, url })
    })
  )
  // A spawned popup (OAuth) is hardened + guarded the instant it exists.
  wc.on('did-create-window', (childWin) => {
    if (!childWin.isDestroyed()) wireChildWindow(childWin.webContents)
  })
  wc.on('will-navigate', (e, url) => {
    if (!normalizeUrl(url) && url !== 'about:blank') e.preventDefault()
  })
  // Right-click in the page (F7): the context-menu is a main-side event, so forward
  // the (link/media/selection) targets to the renderer, which draws the HOUSE menu.
  // Never the DOM — just what a browser menu acts on.
  wc.on('context-menu', (_e, params) => {
    const win = getWin?.()
    if (!win || win.isDestroyed() || activeWc() !== wc) return
    win.webContents.send(BrowserChannels.contextMenu, {
      workspaceId: wsId,
      x: params.x,
      y: params.y,
      linkURL: params.linkURL ?? '',
      srcURL: params.srcURL ?? '',
      selectionText: params.selectionText ?? '',
      isEditable: !!params.isEditable
    } satisfies BrowserContextMenuParams)
  })
  // App shortcut relay (F12): the guest is a separate process, so an app chord pressed
  // while the page holds focus never reaches the renderer's listeners. Intercept the
  // small set the app owns and relay them — the DECISION stays in the renderer (no
  // shortcut logic here); a keystroke a shell might want (letters, editing) is left alone.
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || activeWc() !== wc) return
    const mod = input.control || input.meta
    if (!mod) return
    const code = input.code
    const isAppChord =
      (input.shift && (code === 'KeyU' || code === 'KeyE' || code === 'KeyB')) || // dock/explorer/rail toggles
      code === 'KeyK' || // palette
      (!input.shift && (code === 'KeyF' || code === 'KeyL')) || // find / focus address
      (!input.shift && (code === 'Equal' || code === 'Minus' || code === 'Digit0')) // zoom
    if (!isAppChord) return
    event.preventDefault()
    const win = getWin?.()
    if (win && !win.isDestroyed()) {
      win.webContents.send(BrowserChannels.guestChord, {
        workspaceId: wsId,
        code,
        key: input.key,
        ctrl: input.control,
        meta: input.meta,
        shift: input.shift,
        alt: input.alt
      } satisfies BrowserGuestChord)
    }
  })
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
    wc.on(ev as never, () => {
      if (activeWc() === wc) pushState()
    })
  }
  wc.on('console-message', (...args: unknown[]) => {
    const a1 = args[1] as { level?: unknown; message?: unknown } | number | string | undefined
    const level = a1 && typeof a1 === 'object' ? String(a1.level ?? '') : String(a1 ?? '')
    const message = a1 && typeof a1 === 'object' ? String(a1.message ?? '') : String(args[2] ?? '')
    ring.console.push(capLine(`[${level}] ${message}`))
    if (ring.console.length > RING) ring.console.shift()
  })
  wc.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return
    ring.net.push(capLine(`${code} ${desc} ${url}`))
    if (ring.net.length > RING) ring.net.shift()
  })
  wc.on('did-start-navigation', (_e, _url, _inPage, isMainFrame) => {
    if (isMainFrame) {
      ring.console.length = 0
      ring.net.length = 0
    }
  })
  if (p === 'agent-web') {
    let lastOrigin = ''
    wc.on('did-navigate', (_e, url) => {
      const next = originOf(url)
      if (lastOrigin && next && next !== lastOrigin) {
        const win = getWin?.()
        if (win && !win.isDestroyed()) win.webContents.send(BrowserChannels.originAlert, { workspaceId: wsId, from: lastOrigin, to: next })
        recordTrail({ ts: Date.now(), source: 'web', workspaceId: wsId, verb: 'origin-change', target: next, outcome: 'ok', reason: `from ${lastOrigin}` })
      }
      if (next) lastOrigin = next
    })
  }
  wc.on('destroyed', () => {
    wiredGuests.delete(wc.id)
    bufs.delete(wc.id)
  })
}

function registerGuest(wsId: string, p: BrowserProfile, tabId: string, id: number): void {
  const wc = webContents.fromId(id)
  if (!wc || wc.isDestroyed()) return
  const key = guestKey(wsId, p, tabId)
  guestIds.set(key, id)
  wireGuest(p, wc, wsId)
  const queued = pendingNav.get(key)
  if (queued) {
    pendingNav.delete(key)
    void wc.loadURL(queued)
  } else if (p === 'preview' && tabId === BASE_TAB) {
    // Restore this workspace's last preview url the first time its BASE tab exists (a
    // NEW tab starts blank or at its opener url; agent-web restores nothing — signed-in
    // pages reopen on the user's nav).
    const cur = wc.getURL()
    if (!cur || cur === 'about:blank') {
      const last = getSettingsStore()?.getSetting(kvLastUrl(wsId))
      const u = last ? normalizeUrl(last) : null
      if (u) void wc.loadURL(u)
    }
  }
  if (activeWc() === wc) pushState()
}

function setProfile(next: BrowserProfile): void {
  if (profile === next) return
  profile = next
  // Switching profiles ends the active workspace's session-scoped confirms.
  const s = wsAgent.get(activeWorkspaceId)
  if (s) {
    s.pendingConfirm = null
    s.confirmed.clear()
  }
  refreshVault()
  pushState()
  pushActivity()
}
export function setProfileForSmoke(p: BrowserProfile): void {
  setProfile(p)
}

export const browserDriver = {
  navigate(rawUrl: string): boolean {
    const url = normalizeUrl(rawUrl)
    if (!url) return false
    // No workspace, no browser (finding 33). Every key in this module is workspace-scoped
    // — guestKey, kvLastUrl, kvProfile, kvConsent — so without one this queued the url
    // under guestKey('', profile): a pending nav for a workspace that does not exist,
    // waiting on a guest that can never register (the renderer's ensureGuests() refuses
    // to build one). Today's only callers are main-side smokes and the real IPC handlers
    // are already guarded, but this is exported, so it fails closed like the rest.
    if (!activeWorkspaceId) return false
    const wc = activeWc()
    if (wc) void wc.loadURL(url)
    else pendingNav.set(guestKey(activeWorkspaceId, profile, activeTabFor(activeWorkspaceId, profile)), url)
    return true
  },
  nav(action: BrowserNavAction): void {
    const wc = activeWc()
    if (!wc) return
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
  }
}

function navigateWorkspace(workspaceId: string, rawUrl: string): boolean {
  const url = normalizeUrl(rawUrl)
  if (!workspaceId || !url) return false
  const p = profileForWs(workspaceId)
  const wc = guestWc(workspaceId, p)
  if (wc) void wc.loadURL(url)
  else pendingNav.set(guestKey(workspaceId, p, activeTabFor(workspaceId, p)), url)
  return true
}

function navWorkspace(workspaceId: string, action: BrowserNavAction): void {
  const wc = guestWc(workspaceId, profileForWs(workspaceId))
  if (!wc) return
  if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  else if (action === 'reload') wc.reload()
}

function activateWorkspace(workspaceId: string): void {
  activeWorkspaceId = workspaceId
  profile = workspaceId ? profileForWs(workspaceId) : 'preview'
  refreshVault()
  pushState()
  pushActivity()
}

// ── Agent control (6/05b), per-workspace (8/07c) ────────────────────────────

/** The dock shows the ACTIVE workspace's possession (the browser you see). */
function pushActivity(): void {
  const win = getWin?.()
  if (!win || win.isDestroyed()) return
  const s = wsAgent.get(activeWorkspaceId)
  const activity: BrowserAgentActivity = {
    workspaceId: activeWorkspaceId,
    driving: s?.driving ?? false,
    allowed: consentFor(activeWorkspaceId),
    trail: (s?.recent ?? []).slice(-12),
    pendingConfirm: s?.pendingConfirm ?? undefined,
    pane: s?.pane ?? undefined,
    lastVerb: s?.lastVerb ?? undefined
  }
  win.webContents.send(BrowserChannels.activity, activity)
}

/** Which workspaces have an agent attached to (or driving) their browser — the
 *  renderer pins these from LRU eviction and marks their tabs (visible
 *  possession, 6/05b, now across workspaces). */
function pushPossession(): void {
  const win = getWin?.()
  if (!win || win.isDestroyed()) return
  const attached: string[] = []
  const driving: string[] = []
  const drivers: Record<string, string> = {}
  for (const [wsId, s] of wsAgent) {
    if (s.driving) driving.push(wsId)
    if (s.pane) drivers[wsId] = s.pane
  }
  for (const wsId of lastAgentAct.keys()) if (agentAttached(wsId)) attached.push(wsId)
  win.webContents.send(BrowserChannels.possession, { attached, driving, drivers } satisfies BrowserPossession)
}

function beginDriving(
  wsId: string,
  verb: BrowserAgentVerbName,
  target?: string,
  pane?: string
): { cancelled(): boolean; finish(): void } {
  const s = wsa(wsId)
  s.recent.push({ verb, target, at: Date.now() })
  if (s.recent.length > 50) s.recent.shift()
  s.driving = true
  if (pane) s.pane = pane // who holds the wheel (goal 6)
  s.lastVerb = verb // the live action line
  const epoch = s.epoch
  const operation = ++s.nextOperation
  s.activeOperations.add(operation)
  lastAgentAct.set(wsId, Date.now())
  pushActivity()
  pushPossession()
  let finished = false
  return {
    cancelled: () => s.epoch !== epoch || !s.activeOperations.has(operation) || !consentFor(wsId),
    finish: () => {
      if (finished) return
      finished = true
      s.activeOperations.delete(operation)
      s.driving = s.activeOperations.size > 0
      if (!s.driving) s.lastVerb = null // no live action once the wheel is released
      pushActivity()
      pushPossession()
    }
  }
}

/** Force the ACTIVE workspace's driving state for the DOCKUX smoke (8.5/08b): sets
 *  driving WITHOUT the 1.5 s auto-reset so the possession banner can be measured, and
 *  pushes the REAL activity + possession events — the same path a live agent act drives.
 *  Smoke-only; never called in the shipped flow. */
export function setDrivingForSmoke(wsId: string, on: boolean, pendingConfirm?: string, pane?: string): void {
  const s = wsa(wsId)
  s.driving = on
  s.activeOperations.clear()
  if (on) s.activeOperations.add(-1)
  s.pendingConfirm = on ? (pendingConfirm ?? s.pendingConfirm) : null
  s.pane = on ? (pane ?? s.pane) : null
  s.lastVerb = on ? (s.lastVerb ?? 'navigate') : null
  if (on) lastAgentAct.set(wsId, Date.now())
  else lastAgentAct.delete(wsId)
  pushActivity()
  pushPossession()
}

/** Revoke possession of the ACTIVE workspace's browser (the dock Stop button —
 *  it governs the browser you're looking at). */
export function agentStop(workspaceId = activeWorkspaceId): void {
  const s = wsAgent.get(workspaceId)
  if (s) {
    s.epoch++
    s.activeOperations.clear()
    s.driving = false
    s.confirmed.clear()
    s.pendingConfirm = null
    s.pane = null
    s.lastVerb = null
  }
  if (workspaceId) getSettingsStore()?.setSetting(kvConsent(workspaceId), '')
  lastAgentAct.delete(workspaceId)
  try {
    guestWc(workspaceId, profileForWs(workspaceId))?.stop()
  } catch {
    /* nothing loading */
  }
  pushActivity()
  pushPossession()
  if (workspaceId === activeWorkspaceId) pushState()
}

export function setAgentConsent(allowed: boolean, workspaceId?: string): void {
  const wsId = typeof workspaceId === 'string' && workspaceId ? workspaceId : activeWorkspaceId
  if (!wsId) {
    pushActivity()
    pushPossession()
    return
  }
  const prev = consentFor(wsId)
  getSettingsStore()?.setSetting(kvConsent(wsId), allowed ? '1' : '')
  if (!allowed) {
    // Only a TRANSITION (or live possession) is a revoke. The renderer re-sends the
    // stored consent on every workspace switch, and treating a still-off push as
    // "turn off" fired agentStop's load-halt at whatever the guest was loading —
    // including the human's own restore, cancelled by a switch A→B→A (finding B3).
    const s = wsAgent.get(wsId)
    const possessed = !!s && (s.driving || s.activeOperations.size > 0)
    if (prev || possessed) agentStop(wsId)
    else {
      if (s) {
        // Consent is off; no session confirm may dangle behind it.
        s.pendingConfirm = null
        s.confirmed.clear()
      }
      pushActivity()
      pushPossession()
    }
  } else {
    pushActivity()
    pushPossession()
  }
}

export function confirmPendingActOrigin(origin: string, workspaceId = activeWorkspaceId): void {
  const s = wsa(workspaceId)
  if (!origin || origin !== s.pendingConfirm) return
  s.confirmed.add(origin)
  s.pendingConfirm = null
  recordTrail({ ts: Date.now(), source: 'web', workspaceId, verb: 'confirm', target: origin, outcome: 'confirmed' })
  if (workspaceId === activeWorkspaceId) pushActivity()
}

/** Resolve the browser session an agentAct targets: an agent call carries its
 *  pane -> its OWN workspace; a human/IPC/smoke call (no pane) acts on the
 *  foreground workspace. */
function sessionForCtx(ctx?: { pane?: string }): { wsId: string; profile: BrowserProfile; allowed: boolean } | null {
  if (ctx?.pane && !isLivePane(ctx.pane)) return null
  const wsId = ctx?.pane ? workspaceIdForPane(ctx.pane) : activeWorkspaceId
  if (!wsId) return null
  return { wsId, profile: profileForWs(wsId), allowed: consentFor(wsId) }
}

/** Materialize a workspace's guest on demand (an agent may drive a workspace
 *  the human never opened) — ask the renderer to create it, then wait briefly. */
async function materializeGuest(wsId: string, p: BrowserProfile): Promise<WebContents | null> {
  let wc = guestWc(wsId, p)
  if (wc) return wc
  const win = getWin?.()
  if (win && !win.isDestroyed()) win.webContents.send(BrowserChannels.materialize, { workspaceId: wsId })
  for (let i = 0; i < 40 && !wc; i++) {
    await new Promise((r) => setTimeout(r, 100))
    wc = guestWc(wsId, p)
  }
  return wc
}

const ACT_VERBS: readonly BrowserAgentVerbName[] = ['navigate', 'click', 'type', 'select', 'eval']

/** `eval` answers with a JSON string of whatever the page returned — capped, because
 *  one `document.body.innerHTML` must not ship megabytes through the transport. */
const EVAL_VALUE_CAP = 8000

function gateAct(v: BrowserAgentVerb, wc: WebContents, wsId: string, prof: BrowserProfile): BrowserAgentResult | null {
  if (prof !== 'agent-web' || !ACT_VERBS.includes(v.verb)) return null
  const origin = v.verb === 'navigate' ? originOf(normalizeUrl(String(v.target ?? '')) ?? '') : originOf(wc.getURL())
  const s = wsa(wsId)
  const refuse = (outcome: 'refused', reason: string): BrowserAgentResult => {
    recordTrail({ ts: Date.now(), source: 'web', workspaceId: wsId, verb: v.verb, target: origin || '(no origin)', outcome, reason })
    return { ok: false, reason }
  }
  if (!origin) return refuse('refused', v.verb === 'navigate' ? 'badtarget' : 'no page to act on')
  if (isBlockedActOrigin(origin)) return refuse('refused', `blocked origin ${origin} — sensitive origins never accept act grants`)
  const grant = getIntegrationsGrant(wsId)
  if (grant.web !== 'signed-in' || !grant.actOrigins.includes(origin)) {
    return refuse('refused', `ungranted origin ${origin} — acting on a signed-in site needs this workspace's grant (the human adds it under Sites & grants)`)
  }
  if (!s.confirmed.has(origin)) {
    s.pendingConfirm = origin
    if (wsId === activeWorkspaceId) pushActivity()
    return refuse('refused', `awaiting the human's allow for ${origin} this session (the dock banner) — retry after they confirm`)
  }
  recordTrail({ ts: Date.now(), source: 'web', workspaceId: wsId, verb: v.verb, target: origin, outcome: 'ok' })
  return null
}

export async function agentAct(v: BrowserAgentVerb, ctx?: { pane?: string }): Promise<BrowserAgentResult> {
  const sess = sessionForCtx(ctx)
  if (!sess) return { ok: false, reason: ctx?.pane ? 'unknown-pane' : 'no-workspace' }
  if (!sess.allowed) return { ok: false, reason: 'disabled' }
  let wc = guestWc(sess.wsId, sess.profile)
  if (!wc) wc = await materializeGuest(sess.wsId, sess.profile) // an agent may drive a workspace the human never opened
  if (!wc) return { ok: false, reason: 'noview' }
  const run = (js: string): Promise<unknown> => wc.executeJavaScript(js, true)
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
  const operation = beginDriving(sess.wsId, v.verb, trailTarget, ctx?.pane)
  try {
    const refusal = gateAct(v, wc, sess.wsId, sess.profile)
    if (refusal) return refusal
    const ring = bufs.get(wc.id) ?? { console: [], net: [] }
    switch (v.verb) {
      case 'navigate': {
        // Navigate THIS agent's guest (not the foreground one).
        const url = normalizeUrl(String(v.target ?? ''))
        if (!url) return { ok: false, reason: 'badtarget' }
        await wc.loadURL(url)
        return operation.cancelled() ? { ok: false, reason: 'stopped' } : { ok: true }
      }
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
        return { ok: true }
      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
        return { ok: true }
      case 'reload':
        wc.reload()
        return { ok: true }
      case 'snapshot': {
        const snap = (await run(SNAPSHOT_JS)) as {
          nodes: BrowserSnapshotNode[]
          text: string
          truncated: boolean
          url: string
          title: string
        }
        return { ok: true, nodes: snap.nodes, text: snap.text, truncated: snap.truncated || undefined, url: snap.url, title: snap.title }
      }
      case 'screenshot': {
        const img = await wc.capturePage()
        return { ok: true, png: img.toDataURL() }
      }
      case 'click': {
        if (!v.target) return { ok: false, reason: 'badtarget' }
        const hit = await run(clickScript(v.target))
        return hit ? { ok: true } : { ok: false, reason: 'badtarget' }
      }
      case 'type': {
        if (!v.target) return { ok: false, reason: 'badtarget' }
        const hit = await run(typeScript(v.target, v.value ?? ''))
        return hit ? { ok: true } : { ok: false, reason: 'badtarget' }
      }
      case 'select': {
        if (!v.target) return { ok: false, reason: 'badtarget' }
        const hit = await run(selectScript(v.target, v.value ?? ''))
        return hit ? { ok: true } : { ok: false, reason: 'badtarget' }
      }
      case 'scroll': {
        await run(scrollScript(Number(v.dy ?? 400), v.to))
        return { ok: true }
      }
      case 'eval': {
        const out = await run(`(() => { try { return JSON.stringify((function(){ return (${String(v.target ?? 'undefined')}) })()) } catch (e) { return 'ERR: ' + e } })()`)
        const text = String(out ?? '')
        return { ok: true, value: text.length > EVAL_VALUE_CAP ? `${text.slice(0, EVAL_VALUE_CAP)} …[truncated]` : text }
      }
      case 'console':
        return { ok: true, lines: ring.console.slice(-Math.max(1, v.n ?? 30)) }
      case 'network_failures':
        return { ok: true, lines: ring.net.slice(-Math.max(1, v.n ?? 30)) }
      case 'wait_for': {
        const timeout = Math.min(30000, Math.max(100, v.n ?? 5000))
        const deadline = Date.now() + timeout
        while (Date.now() < deadline) {
          if (operation.cancelled()) return { ok: false, reason: 'stopped' }
          const found = await run(existsScript(String(v.target ?? '')))
          if (operation.cancelled()) return { ok: false, reason: 'stopped' }
          if (found) return { ok: true }
          await new Promise((r) => setTimeout(r, 150))
        }
        return { ok: false, reason: 'timeout' }
      }
      // ── Tabs (F4): management verbs — an agent holds a doc + the dev server at
      //    once. READ-tier (allowed under consent, no origin grant): a new tab can
      //    be READ freely, and ACTING on it is still gated by gateAct per-origin. ──
      case 'tab_list':
        return { ok: true, ...tabsSnapshot(sess.wsId, sess.profile) }
      case 'tab_new': {
        const before = (tabsCache.get(wpKey(sess.wsId, sess.profile))?.tabs ?? []).length
        const openUrl = v.target ? (normalizeUrl(v.target) ?? undefined) : undefined
        // Opening a tab TO a url IS a navigation of this profile — the renderer loads it,
        // NOT the gated `navigate` verb. On agent-web that would let tab_new point the
        // signed-in browser at a SENSITIVE or UNGRANTED origin (which navigate refuses at
        // both ends) and then read it. Gate the url exactly like navigate. Preview is free;
        // a blank tab_new (no url) is always allowed.
        if (openUrl && sess.profile === 'agent-web') {
          const refusal = gateAct({ verb: 'navigate', target: openUrl }, wc, sess.wsId, sess.profile)
          if (refusal) return refusal
        }
        const win = getWin?.()
        if (!win || win.isDestroyed()) return { ok: false, reason: 'noview' }
        win.webContents.send(BrowserChannels.tabOpen, { workspaceId: sess.wsId, profile: sess.profile, url: openUrl })
        await waitForTabs(sess.wsId, sess.profile, (tabs) => tabs.length > before)
        return { ok: true, ...tabsSnapshot(sess.wsId, sess.profile) }
      }
      case 'tab_select': {
        const target = String(v.target ?? '').trim()
        if (!target) return { ok: false, reason: 'badtarget' } // empty must not silently mean index 0
        const tabs = tabsCache.get(wpKey(sess.wsId, sess.profile))?.tabs ?? []
        const idx = /^\d+$/.test(target) ? Number(target) : -1
        const tab = idx >= 0 ? tabs[idx] : tabs.find((t) => t.id === target)
        if (!tab) return { ok: false, reason: 'badtarget' }
        const win = getWin?.()
        if (!win || win.isDestroyed()) return { ok: false, reason: 'noview' }
        win.webContents.send(BrowserChannels.tabSelect, { workspaceId: sess.wsId, profile: sess.profile, tabId: tab.id })
        activeTab.set(wpKey(sess.wsId, sess.profile), tab.id)
        await waitForTabs(sess.wsId, sess.profile, (_t, active) => active === tab.id)
        return { ok: true, ...tabsSnapshot(sess.wsId, sess.profile) }
      }
      default:
        return { ok: false, reason: 'badtarget' }
    }
  } catch (e) {
    return operation.cancelled()
      ? { ok: false, reason: 'stopped' }
      : { ok: false, reason: String(e).slice(0, 120) }
  } finally {
    operation.finish()
  }
}

// ── Agent-web session controls (8/04): the ACTIVE workspace's OWN partition ──

// BOTH partition variants for a workspace. The machine-global vault probe can flip
// persist ↔ mem mid-session, and an open guest keeps the partition it was CREATED with —
// so a "forget"/"clear" that targets only the CURRENT variant can clear the wrong jar and
// report false success. Inspect/clear both; the guest's real jar is always one of them.
const agentWebSessionsAll = (workspaceId = activeWorkspaceId): Session[] => {
  const names = new Set([browserAgentWebPartition(workspaceId, true), browserAgentWebPartition(workspaceId, false)])
  return [...names].map((n) => session.fromPartition(n))
}

async function signedInSites(workspaceId = activeWorkspaceId): Promise<BrowserSignedInSite[]> {
  const byHost = new Map<string, number>()
  for (const ses of agentWebSessionsAll(workspaceId)) {
    for (const c of await ses.cookies.get({})) {
      const host = (c.domain ?? '').replace(/^\./, '')
      if (host) byHost.set(host, (byHost.get(host) ?? 0) + 1)
    }
  }
  return [...byHost.entries()].map(([host, n]) => ({ host, cookies: n })).sort((a, b) => a.host.localeCompare(b.host))
}

async function forgetSite(host: string, workspaceId = activeWorkspaceId): Promise<void> {
  if (!host) return
  for (const ses of agentWebSessionsAll(workspaceId)) {
    const cookies = await ses.cookies.get({})
    for (const c of cookies) {
      const d = (c.domain ?? '').replace(/^\./, '')
      if (d !== host && !d.endsWith(`.${host}`)) continue
      const url = `${c.secure ? 'https' : 'http'}://${d}${c.path ?? '/'}`
      try {
        await ses.cookies.remove(url, c.name)
      } catch {
        /* already gone */
      }
    }
    for (const scheme of ['https', 'http']) {
      try {
        await ses.clearStorageData({ origin: `${scheme}://${host}` })
      } catch {
        /* nothing stored */
      }
    }
  }
}

async function clearAgentLogins(workspaceId = activeWorkspaceId): Promise<void> {
  for (const ses of agentWebSessionsAll(workspaceId)) await ses.clearStorageData()
}

export function agentControlDebug(): {
  allowed: boolean
  driving: boolean
  trail: BrowserAgentActivity['trail']
  profile: BrowserProfile
  pendingConfirm: string | null
  agentWebPersists: boolean
} {
  // The ACTIVE workspace's possession (the browser you see).
  const s = wsAgent.get(activeWorkspaceId)
  return {
    allowed: consentFor(activeWorkspaceId),
    driving: s?.driving ?? false,
    trail: (s?.recent ?? []).slice(),
    profile,
    pendingConfirm: s?.pendingConfirm ?? null,
    agentWebPersists
  }
}

/** Smoke-only (8/07c): the per-workspace possession snapshot — is an agent
 *  attached to / driving a NON-foreground workspace's browser. */
export function agentPossessionDebug(): { attached: string[]; driving: string[] } {
  const attached: string[] = []
  const driving: string[] = []
  for (const [wsId, s] of wsAgent) if (s.driving) driving.push(wsId)
  for (const wsId of lastAgentAct.keys()) if (agentAttached(wsId)) attached.push(wsId)
  return { attached, driving }
}

export function dockPageEval(js: string): Promise<unknown> | null {
  const wc = activeWc()
  return wc ? wc.executeJavaScript(js, true) : null
}

export function dockDebug(): {
  attached: boolean
  open: boolean
  url: string
  profile: BrowserProfile
  agentWebPersists: boolean
  workspaceId: string
} {
  const wc = activeWc()
  const url = wc?.getURL() ?? ''
  return { attached: !!wc, open, url: url === 'about:blank' ? '' : url, profile, agentWebPersists, workspaceId: activeWorkspaceId }
}

/** Smoke-only: recreate the ACTIVE workspace's agent-web guest so the
 *  persistence arm can prove a cookie survives (partition outlives element). */
export function destroyAgentWebViewForSmoke(): Promise<void> {
  const win = getWin?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send(BrowserChannels.recreateGuest, { workspaceId: activeWorkspaceId, profile: 'agent-web' })
  }
  return new Promise((resolve) => setTimeout(resolve, 800))
}
export const forgetSiteForSmoke = forgetSite
export const signedInSitesForSmoke = signedInSites

export function registerBrowserDock(winGetter: () => BrowserWindow | null): void {
  getWin = winGetter
  const store = (): ReturnType<typeof getSettingsStore> => getSettingsStore()
  refreshVault()

  // Harden a guest's session the INSTANT it attaches — before dom-ready, before its
  // first load — so a permission request racing the renderer's guest-ready IPC can never
  // hit Electron's permissive default (defense in depth; the deny-all + UA are idempotent
  // per session). The renderer still registers each guest by workspace × profile for
  // driving; this only front-runs the session policy.
  const host = winGetter()
  host?.webContents.on('did-attach-webview', (_e, guestWc) => {
    if (!guestWc.isDestroyed()) hardenSession(guestWc.session)
  })

  ipcMain.handle(BrowserChannels.init, (): BrowserDockInit => {
    const s = store()
    open = s?.getSetting(KV_OPEN) === '1'
    const width = Number(s?.getSetting(KV_WIDTH)) || DEFAULT_WIDTH
    const searchTemplate = s?.getSetting(KV_SEARCH) || DEFAULT_SEARCH_TEMPLATE
    refreshVault()
    return { open, width, agentWebPersists, searchTemplate }
  })

  ipcMain.on(BrowserChannels.guest, (_e, p: { workspaceId?: string; profile?: BrowserProfile; tabId?: string; id?: number }) => {
    if (typeof p?.workspaceId === 'string' && p.workspaceId && (p.profile === 'preview' || p.profile === 'agent-web') && typeof p.id === 'number') {
      registerGuest(p.workspaceId, p.profile, typeof p.tabId === 'string' && p.tabId ? p.tabId : BASE_TAB, p.id)
    }
  })
  ipcMain.on(BrowserChannels.guestGone, (_e, p: { workspaceId?: string; profile?: BrowserProfile; tabId?: string }) => {
    if (typeof p?.workspaceId === 'string' && (p.profile === 'preview' || p.profile === 'agent-web')) {
      guestIds.delete(guestKey(p.workspaceId, p.profile, typeof p.tabId === 'string' && p.tabId ? p.tabId : BASE_TAB))
    }
  })
  // Tabs (F4): the renderer owns tab lifecycle and tells main which is ACTIVE per
  // (workspace, profile), so the driver (activeWc) always resolves the tab you see.
  ipcMain.on(BrowserChannels.tabActivate, (_e, p: { workspaceId?: string; profile?: BrowserProfile; tabId?: string }) => {
    if (typeof p?.workspaceId === 'string' && p.workspaceId && (p.profile === 'preview' || p.profile === 'agent-web') && typeof p.tabId === 'string' && p.tabId) {
      activeTab.set(wpKey(p.workspaceId, p.profile), p.tabId)
      if (p.workspaceId === activeWorkspaceId && p.profile === profile) pushState()
    }
  })
  ipcMain.on(BrowserChannels.tabsState, (_e, s: BrowserTabsState) => {
    if (typeof s?.workspaceId === 'string' && s.workspaceId && (s.profile === 'preview' || s.profile === 'agent-web') && Array.isArray(s.tabs)) {
      const cap = (v: unknown): string => String(v ?? '').slice(0, 2048)
      const tabs = s.tabs
        // A non-empty id is required: an id:'' would set activeTab to '' (guestKey `${ws}:${p}#`
        // resolves nothing), wedging the workspace's tab resolution. Fields length-capped so a
        // compromised renderer can't cache megabytes that ride back to the agent via tab_list.
        .filter((t): t is BrowserTab => !!t && typeof t.id === 'string' && t.id.length > 0)
        .map((t) => ({ id: t.id.slice(0, 64), url: cap(t.url), title: cap(t.title) }))
        .slice(0, 50)
      const activeId = typeof s.activeId === 'string' && s.activeId ? s.activeId.slice(0, 64) : BASE_TAB
      tabsCache.set(wpKey(s.workspaceId, s.profile), { workspaceId: s.workspaceId, profile: s.profile, tabs, activeId })
      if (typeof s.activeId === 'string' && s.activeId) activeTab.set(wpKey(s.workspaceId, s.profile), activeId)
    }
  })

  ipcMain.handle(BrowserChannels.toggle, (_e, payload: { open: boolean; workspaceId?: string; persist?: boolean }) => {
    open = !!payload?.open
    // `persist:false` is the renderer's forced close/reopen around the zero-workspace
    // valley: the RUNTIME state changes, the saved preference does not — so a dock
    // that was open when the last workspace closed comes back with the next one.
    if (payload?.persist !== false) store()?.setSetting(KV_OPEN, open ? '1' : '')
    // ONE activation path. This used to restate activateWorkspace's assignments inline —
    // minus refreshVault/pushActivity — which is exactly the kind of sibling copy that
    // drifts. Restore is per-workspace, handled when each workspace's preview guest
    // registers — nothing to do here beyond activating/publishing.
    if (typeof payload?.workspaceId === 'string') activateWorkspace(payload.workspaceId)
    else pushState()
  })

  ipcMain.handle(BrowserChannels.activate, (_e, payload: { workspaceId?: string }) => {
    activateWorkspace(typeof payload?.workspaceId === 'string' ? payload.workspaceId : '')
  })

  ipcMain.handle(BrowserChannels.navigate, async (_e, payload: { url: string; workspaceId?: string }) => {
    await maybeFault(BrowserChannels.navigate) // ASYNCSTATE seam (finding 39) — inert unless armed
    const workspaceId = typeof payload?.workspaceId === 'string' ? payload.workspaceId : ''
    await waitForBrowserRaceAudit('navigate', workspaceId, String(payload?.url ?? ''))
    const ok = navigateWorkspace(workspaceId, String(payload?.url ?? ''))
    if (ok && workspaceId && profileForWs(workspaceId) === 'preview') {
      const url = normalizeUrl(String(payload.url))
      if (url) store()?.setSetting(kvLastUrl(workspaceId), url)
    }
    return ok
  })

  ipcMain.handle(BrowserChannels.nav, async (_e, payload: { action: BrowserNavAction; workspaceId?: string }) => {
    await maybeFault(BrowserChannels.nav)
    if (typeof payload?.workspaceId === 'string') navWorkspace(payload.workspaceId, payload?.action)
  })

  ipcMain.handle(BrowserChannels.lastUrl, async (_e, workspaceId: string) => {
    await waitForBrowserRaceAudit('lastUrl', String(workspaceId))
    return store()?.getSetting(kvLastUrl(String(workspaceId))) ?? null
  })

  ipcMain.handle(BrowserChannels.openExternal, (_e, payload: { url: string }) => {
    const url = normalizeUrl(String(payload?.url ?? ''))
    if (url) void shell.openExternal(url)
  })

  ipcMain.handle(BrowserChannels.devtools, (_e, payload: { x?: number; y?: number }) => {
    // Humans get the agent's console/network view (F8): DevTools on the guest the user
    // is looking at. Detached so it never steals the dock's layout.
    const wc = activeWc()
    if (!wc || wc.isDestroyed()) return
    if (typeof payload?.x === 'number' && typeof payload?.y === 'number') {
      try {
        wc.inspectElement(Math.round(payload.x), Math.round(payload.y))
      } catch {
        wc.openDevTools({ mode: 'detach' })
      }
    } else {
      wc.openDevTools({ mode: 'detach' })
    }
  })

  ipcMain.on(BrowserChannels.persistWidth, (_e, p: { dockWidth?: number }) => {
    const w = Number(p?.dockWidth)
    if (Number.isFinite(w) && w > 0) store()?.setSetting(KV_WIDTH, String(Math.round(w)))
  })

  // ── Agent control (6/05b) ─────────────────────────────────────────────────
  ipcMain.handle(BrowserChannels.consentGet, async (_e, wsId: string) => {
    await waitForBrowserRaceAudit('consentGet', String(wsId))
    return store()?.getSetting(kvConsent(String(wsId))) === '1'
  })
  // Returns {ok}, and the renderer OBEYS it (finding 33b). `store()?.setSetting(...)`
  // evaluates to undefined whether it wrote or not: with the store gone (called before
  // registerAppSettings, or after dispose on a shutdown-ordered IPC) the write vanished
  // and the toggle still slid over to ON — the same "reported saved while dropped" bug
  // the service-key store had to fix (service-keys.ts:63-65). The grant deciding whether
  // AGENTS MAY DRIVE A BROWSER is the last setting that should be optimistic about that.
  ipcMain.handle(BrowserChannels.consentSet, (_e, p: { workspaceId: string; allowed: boolean }): { ok: boolean } => {
    if (consumeConsentSetFailure()) return { ok: false } // BROWSERZERO gate: a dropped write, on purpose
    const wsId = String(p?.workspaceId ?? '')
    const s = store()
    if (!wsId || !s) return { ok: false }
    try {
      s.setSetting(kvConsent(wsId), p?.allowed ? '1' : '')
    } catch {
      return { ok: false } // a store that throws is a store that did not save
    }
    return { ok: true }
  })
  ipcMain.on(BrowserChannels.consent, (_e, payload: { allowed: boolean; workspaceId?: string }) => {
    recordBrowserRaceAudit('consentApply', String(payload?.workspaceId ?? ''), payload?.allowed ? 'on' : 'off')
    setAgentConsent(!!payload?.allowed, payload?.workspaceId)
  })
  ipcMain.handle(BrowserChannels.agentAct, (_e, v: BrowserAgentVerb) => agentAct(v))
  ipcMain.on(BrowserChannels.agentStop, (_event, payload: { workspaceId?: string } | undefined) => {
    agentStop(typeof payload?.workspaceId === 'string' ? payload.workspaceId : activeWorkspaceId)
  })

  // ── Agent web profile (8/04) ──────────────────────────────────────────────
  ipcMain.handle(BrowserChannels.profileGet, async (_e, wsId: string): Promise<BrowserProfile> => {
    await waitForBrowserRaceAudit('profileGet', String(wsId))
    return store()?.getSetting(kvProfile(String(wsId))) === 'agent-web' ? 'agent-web' : 'preview'
  })
  ipcMain.handle(BrowserChannels.profileSet, async (_e, p: { workspaceId?: string; profile: BrowserProfile }) => {
    const next: BrowserProfile = p?.profile === 'agent-web' ? 'agent-web' : 'preview'
    await waitForBrowserRaceAudit('profileSet', String(p?.workspaceId ?? ''), next)
    if (p?.workspaceId) {
      store()?.setSetting(kvProfile(String(p.workspaceId)), next)
      if (p.workspaceId === activeWorkspaceId) setProfile(next)
    }
  })
  // Missing/empty workspaceId falls back to the ACTIVE workspace — the same convention
  // every other verb here uses. Forcing '' instead minted phantom `wsa('')` sessions and
  // aimed cookie clears at a partition no workspace owns.
  const wsOrActive = (raw: unknown): string => (typeof raw === 'string' && raw ? raw : activeWorkspaceId)
  ipcMain.on(BrowserChannels.confirmOrigin, (_e, p: { workspaceId?: string; origin: string }) => {
    confirmPendingActOrigin(String(p?.origin ?? ''), wsOrActive(p?.workspaceId))
  })
  ipcMain.handle(BrowserChannels.signedInSites, async (_e, workspaceId: string) => {
    const wsId = wsOrActive(workspaceId)
    await waitForBrowserRaceAudit('signedInSites', wsId)
    return signedInSites(wsId)
  })
  ipcMain.handle(BrowserChannels.forgetSite, (_e, p: { workspaceId?: string; host?: string }) =>
    forgetSite(String(p?.host ?? ''), wsOrActive(p?.workspaceId))
  )
  ipcMain.handle(BrowserChannels.clearAgentLogins, (_e, workspaceId: string) => clearAgentLogins(wsOrActive(workspaceId)))
}
