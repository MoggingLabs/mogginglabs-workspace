import { BrowserWindow, ipcMain, shell, session, webContents, type Session, type WebContents } from 'electron'
import {
  BrowserChannels,
  browserAgentWebPartition,
  type BrowserAgentActivity,
  type BrowserAgentResult,
  type BrowserAgentVerb,
  type BrowserAgentVerbName,
  type BrowserDockInit,
  type BrowserDockState,
  type BrowserNavAction,
  type BrowserProfile,
  type BrowserSignedInSite,
  type BrowserSnapshotNode
} from '@contracts'
import { isBlockedActOrigin } from '@backend/features/integrations'
import { getSettingsStore } from './app-settings'
import { getIntegrationsGrant } from './integrations'
import { isKeyVaultAvailable } from './usage-keys'
import { recordTrail } from './trail'

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
const kvLastUrl = (workspaceId: string): string => `browser.lastUrl.${workspaceId}`
const kvProfile = (workspaceId: string): string => `browser.profile.${workspaceId}`
const DEFAULT_WIDTH = 420

let getWin: (() => BrowserWindow | null) | null = null
let open = false
let profile: BrowserProfile = 'preview' // the ACTIVE workspace's profile
let activeWorkspaceId = ''

// Guest webContents ids, keyed `${workspaceId}:${profile}` (registered by the
// renderer's per-workspace <webview>s on dom-ready).
const guestKey = (workspaceId: string, p: BrowserProfile): string => `${workspaceId}:${p}`
const guestIds = new Map<string, number>()
const wiredGuests = new Set<number>()
const hardenedSessions = new WeakSet<Session>()
const pendingNav = new Map<string, string>()
// Per-GUEST console/network rings (keyed by webContents id) so workspaces and
// profiles never interleave.
const bufs = new Map<number, { console: string[]; net: string[] }>()
const RING = 200

// Vault-conditioned agent-web persistence (ADR 0008.h) — machine-global.
let agentWebPersists = true
let vaultProbe: () => boolean = isKeyVaultAvailable
export function setAgentWebVaultProbeForSmoke(probe: (() => boolean) | null): void {
  vaultProbe = probe ?? isKeyVaultAvailable
}
function refreshVault(): void {
  agentWebPersists = !process.env.MOGGING_TEST_NO_VAULT && vaultProbe()
}
const agentWebPartitionFor = (workspaceId: string): string => browserAgentWebPartition(workspaceId, agentWebPersists)

// ── Agent control state (6/05b) ────────────────────────────────────────────
let agentAllowed = false
let driving = false
let drivingClearTimer: NodeJS.Timeout | null = null
const trail: BrowserAgentActivity['trail'] = []
const confirmedOrigins = new Set<string>()
let pendingConfirm: string | null = null

function guestWc(workspaceId: string, p: BrowserProfile): WebContents | null {
  const id = guestIds.get(guestKey(workspaceId, p))
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

/** Deny-all permissions on a guest's ACTUAL session (correct regardless of the
 *  partition name), the app's own session untouched. Idempotent per session. */
function hardenSession(ses: Session): void {
  if (hardenedSessions.has(ses)) return
  hardenedSessions.add(ses)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
}

/** Attach the driver's listeners to a freshly-registered guest — idempotent
 *  per webContents id. `wsId` is the OWNING workspace (its trail entries). */
function wireGuest(p: BrowserProfile, wc: WebContents, wsId: string): void {
  if (wiredGuests.has(wc.id)) return
  wiredGuests.add(wc.id)
  hardenSession(wc.session)
  bufs.set(wc.id, { console: [], net: [] })
  const ring = bufs.get(wc.id)!
  wc.setWindowOpenHandler(({ url }) => {
    const ok = normalizeUrl(url)
    if (ok && !Object.keys(process.env).some((k) => k.startsWith('MOGGING_'))) void shell.openExternal(ok)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (!normalizeUrl(url) && url !== 'about:blank') e.preventDefault()
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
    ring.console.push(`[${level}] ${message}`)
    if (ring.console.length > RING) ring.console.shift()
  })
  wc.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return
    ring.net.push(`${code} ${desc} ${url}`)
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
        if (win && !win.isDestroyed()) win.webContents.send(BrowserChannels.originAlert, { from: lastOrigin, to: next })
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

function registerGuest(wsId: string, p: BrowserProfile, id: number): void {
  const wc = webContents.fromId(id)
  if (!wc || wc.isDestroyed()) return
  const key = guestKey(wsId, p)
  guestIds.set(key, id)
  wireGuest(p, wc, wsId)
  const queued = pendingNav.get(key)
  if (queued) {
    pendingNav.delete(key)
    void wc.loadURL(queued)
  } else if (p === 'preview') {
    // Restore this workspace's last preview url the first time its guest exists
    // (agent-web restores nothing — signed-in pages reopen on the user's nav).
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
  pendingConfirm = null
  confirmedOrigins.clear()
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
    const wc = activeWc()
    if (wc) void wc.loadURL(url)
    else pendingNav.set(guestKey(activeWorkspaceId, profile), url)
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

// ── Agent control (6/05b) ────────────────────────────────────────────────────

function pushActivity(): void {
  const win = getWin?.()
  if (!win || win.isDestroyed()) return
  const activity: BrowserAgentActivity = {
    driving,
    allowed: agentAllowed,
    trail: trail.slice(-12),
    pendingConfirm: pendingConfirm ?? undefined
  }
  win.webContents.send(BrowserChannels.activity, activity)
}

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

export function agentStop(): void {
  driving = false
  if (drivingClearTimer) clearTimeout(drivingClearTimer)
  confirmedOrigins.clear()
  pendingConfirm = null
  try {
    activeWc()?.stop()
  } catch {
    /* nothing loading */
  }
  pushActivity()
}

export function setAgentConsent(allowed: boolean, workspaceId?: string): void {
  agentAllowed = allowed
  if (typeof workspaceId === 'string' && workspaceId) {
    if (workspaceId !== activeWorkspaceId) {
      activeWorkspaceId = workspaceId
      pushState() // switching workspaces switches the shown browser
    }
  }
  if (!allowed) agentStop()
  else pushActivity()
}

export function confirmPendingActOrigin(origin: string): void {
  if (!origin || origin !== pendingConfirm) return
  confirmedOrigins.add(origin)
  pendingConfirm = null
  recordTrail({ ts: Date.now(), source: 'web', workspaceId: activeWorkspaceId, verb: 'confirm', target: origin, outcome: 'confirmed' })
  pushActivity()
}

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

const ACT_VERBS: readonly BrowserAgentVerbName[] = ['navigate', 'click', 'type', 'select', 'eval']

function gateAct(v: BrowserAgentVerb, wc: WebContents): BrowserAgentResult | null {
  if (profile !== 'agent-web' || !ACT_VERBS.includes(v.verb)) return null
  const origin = v.verb === 'navigate' ? originOf(normalizeUrl(String(v.target ?? '')) ?? '') : originOf(wc.getURL())
  const refuse = (outcome: 'refused', reason: string): BrowserAgentResult => {
    recordTrail({ ts: Date.now(), source: 'web', workspaceId: activeWorkspaceId, verb: v.verb, target: origin || '(no origin)', outcome, reason })
    return { ok: false, reason }
  }
  if (!origin) return refuse('refused', v.verb === 'navigate' ? 'badtarget' : 'no page to act on')
  if (isBlockedActOrigin(origin)) return refuse('refused', `blocked origin ${origin} — sensitive origins never accept act grants`)
  const grant = getIntegrationsGrant(activeWorkspaceId)
  if (grant.web !== 'signed-in' || !grant.actOrigins.includes(origin)) {
    return refuse('refused', `ungranted origin ${origin} — acting on a signed-in site needs this workspace's grant (the human adds it under Sites & grants)`)
  }
  if (!confirmedOrigins.has(origin)) {
    pendingConfirm = origin
    pushActivity()
    return refuse('refused', `awaiting the human's allow for ${origin} this session (the dock banner) — retry after they confirm`)
  }
  recordTrail({ ts: Date.now(), source: 'web', workspaceId: activeWorkspaceId, verb: v.verb, target: origin, outcome: 'ok' })
  return null
}

export async function agentAct(v: BrowserAgentVerb): Promise<BrowserAgentResult> {
  if (!agentAllowed) return { ok: false, reason: 'disabled' }
  const wc = activeWc()
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
  markDriving(v.verb, trailTarget)
  const refusal = gateAct(v, wc)
  if (refusal) return refusal
  const ring = bufs.get(wc.id) ?? { console: [], net: [] }
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
        const out = await run(`(() => { try { return JSON.stringify((function(){ return (${String(v.target ?? 'undefined')}) })()) } catch (e) { return 'ERR: ' + e } })()`)
        return { ok: true, value: String(out ?? '') }
      }
      case 'console':
        return { ok: true, lines: ring.console.slice(-Math.max(1, v.n ?? 30)) }
      case 'network_failures':
        return { ok: true, lines: ring.net.slice(-Math.max(1, v.n ?? 30)) }
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

// ── Agent-web session controls (8/04): the ACTIVE workspace's OWN partition ──

const agentWebSession = (): Session => session.fromPartition(agentWebPartitionFor(activeWorkspaceId))

async function signedInSites(): Promise<BrowserSignedInSite[]> {
  const cookies = await agentWebSession().cookies.get({})
  const byHost = new Map<string, number>()
  for (const c of cookies) {
    const host = (c.domain ?? '').replace(/^\./, '')
    if (host) byHost.set(host, (byHost.get(host) ?? 0) + 1)
  }
  return [...byHost.entries()].map(([host, n]) => ({ host, cookies: n })).sort((a, b) => a.host.localeCompare(b.host))
}

async function forgetSite(host: string): Promise<void> {
  const ses = agentWebSession()
  if (!host) return
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

async function clearAgentLogins(): Promise<void> {
  await agentWebSession().clearStorageData()
}

export function agentControlDebug(): {
  allowed: boolean
  driving: boolean
  trail: BrowserAgentActivity['trail']
  profile: BrowserProfile
  pendingConfirm: string | null
  agentWebPersists: boolean
} {
  return { allowed: agentAllowed, driving, trail: trail.slice(), profile, pendingConfirm, agentWebPersists }
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

  ipcMain.handle(BrowserChannels.init, (): BrowserDockInit => {
    const s = store()
    open = s?.getSetting(KV_OPEN) === '1'
    const width = Number(s?.getSetting(KV_WIDTH)) || DEFAULT_WIDTH
    refreshVault()
    return { open, width, agentWebPersists }
  })

  ipcMain.on(BrowserChannels.guest, (_e, p: { workspaceId?: string; profile?: BrowserProfile; id?: number }) => {
    if (typeof p?.workspaceId === 'string' && p.workspaceId && (p.profile === 'preview' || p.profile === 'agent-web') && typeof p.id === 'number') {
      registerGuest(p.workspaceId, p.profile, p.id)
    }
  })
  ipcMain.on(BrowserChannels.guestGone, (_e, p: { workspaceId?: string; profile?: BrowserProfile }) => {
    if (typeof p?.workspaceId === 'string' && (p.profile === 'preview' || p.profile === 'agent-web')) {
      guestIds.delete(guestKey(p.workspaceId, p.profile))
    }
  })

  ipcMain.handle(BrowserChannels.toggle, (_e, payload: { open: boolean; workspaceId?: string }) => {
    open = !!payload?.open
    store()?.setSetting(KV_OPEN, open ? '1' : '')
    if (typeof payload?.workspaceId === 'string' && payload.workspaceId) activeWorkspaceId = payload.workspaceId
    // Restore is per-workspace, handled when each workspace's preview guest
    // registers — nothing to do here beyond publishing state.
    pushState()
  })

  ipcMain.handle(BrowserChannels.navigate, (_e, payload: { url: string; workspaceId?: string }) => {
    if (typeof payload?.workspaceId === 'string' && payload.workspaceId) activeWorkspaceId = payload.workspaceId
    const ok = browserDriver.navigate(String(payload?.url ?? ''))
    if (ok && payload?.workspaceId && profile === 'preview') {
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

  ipcMain.on(BrowserChannels.persistWidth, (_e, p: { dockWidth?: number }) => {
    const w = Number(p?.dockWidth)
    if (Number.isFinite(w) && w > 0) store()?.setSetting(KV_WIDTH, String(Math.round(w)))
  })

  // ── Agent control (6/05b) ─────────────────────────────────────────────────
  const kvConsent = (wsId: string): string => `browser.agentControl.${wsId}`
  ipcMain.handle(BrowserChannels.consentGet, (_e, wsId: string) => store()?.getSetting(kvConsent(String(wsId))) === '1')
  ipcMain.handle(BrowserChannels.consentSet, (_e, p: { workspaceId: string; allowed: boolean }) => {
    store()?.setSetting(kvConsent(String(p?.workspaceId)), p?.allowed ? '1' : '')
  })
  ipcMain.on(BrowserChannels.consent, (_e, payload: { allowed: boolean; workspaceId?: string }) => {
    setAgentConsent(!!payload?.allowed, payload?.workspaceId)
  })
  ipcMain.handle(BrowserChannels.agentAct, (_e, v: BrowserAgentVerb) => agentAct(v))
  ipcMain.on(BrowserChannels.agentStop, () => agentStop())

  // ── Agent web profile (8/04) ──────────────────────────────────────────────
  ipcMain.handle(BrowserChannels.profileGet, (_e, wsId: string): BrowserProfile => {
    return store()?.getSetting(kvProfile(String(wsId))) === 'agent-web' ? 'agent-web' : 'preview'
  })
  ipcMain.handle(BrowserChannels.profileSet, (_e, p: { workspaceId?: string; profile: BrowserProfile }) => {
    const next: BrowserProfile = p?.profile === 'agent-web' ? 'agent-web' : 'preview'
    if (p?.workspaceId) {
      store()?.setSetting(kvProfile(String(p.workspaceId)), next)
      activeWorkspaceId = p.workspaceId
    }
    setProfile(next)
  })
  ipcMain.on(BrowserChannels.confirmOrigin, (_e, p: { origin: string }) => {
    confirmPendingActOrigin(String(p?.origin ?? ''))
  })
  ipcMain.handle(BrowserChannels.signedInSites, () => signedInSites())
  ipcMain.handle(BrowserChannels.forgetSite, (_e, host: string) => forgetSite(String(host ?? '')))
  ipcMain.handle(BrowserChannels.clearAgentLogins, () => clearAgentLogins())
}
