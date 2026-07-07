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
import { getIntegrationsGrant, workspaceIdForPane } from './integrations'
import { setVaultProbeForSmoke, vaultAvailable } from './vault'
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
const kvConsent = (workspaceId: string): string => `browser.agentControl.${workspaceId}`
const DEFAULT_WIDTH = 420
// A workspace stays "agent-attached" (pinned from LRU eviction, indicator on
// its tab) this long after an agent last drove its browser (8/07c).
const AGENT_ATTACH_MS = 5 * 60_000

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

// Vault-conditioned agent-web persistence (ADR 0008.h) — machine-global,
// governed by the ONE shared vault probe (8/08).
let agentWebPersists = true
export function setAgentWebVaultProbeForSmoke(probe: (() => boolean) | null): void {
  setVaultProbeForSmoke(probe)
}
function refreshVault(): void {
  agentWebPersists = !process.env.MOGGING_TEST_NO_VAULT && vaultAvailable()
}
const agentWebPartitionFor = (workspaceId: string): string => browserAgentWebPartition(workspaceId, agentWebPersists)

// ── Agent control state (6/05b), now PER-WORKSPACE (8/07c) ──────────────────
// Each agent drives ITS OWN workspace's browser (resolved from its pane), gated
// by that workspace's consent/grant — never the foreground one. So possession,
// confirms, and the recent-acts trail are all keyed by workspace.
interface WsAgent {
  driving: boolean
  drivingTimer: NodeJS.Timeout | null
  confirmed: Set<string> // origins the human allowed this possession
  pendingConfirm: string | null
  recent: BrowserAgentActivity['trail'] // recent verbs for the dock's ⋯ menu
}
const wsAgent = new Map<string, WsAgent>()
const lastAgentAct = new Map<string, number>() // ws -> last agent verb (pin window)
function wsa(wsId: string): WsAgent {
  let s = wsAgent.get(wsId)
  if (!s) {
    s = { driving: false, drivingTimer: null, confirmed: new Set(), pendingConfirm: null, recent: [] }
    wsAgent.set(wsId, s)
  }
  return s
}
const consentFor = (wsId: string): boolean => getSettingsStore()?.getSetting(kvConsent(wsId)) === '1'
const profileForWs = (wsId: string): BrowserProfile =>
  getSettingsStore()?.getSetting(kvProfile(wsId)) === 'agent-web' ? 'agent-web' : 'preview'
const agentAttached = (wsId: string): boolean => Date.now() - (lastAgentAct.get(wsId) ?? 0) < AGENT_ATTACH_MS

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

// ── Agent control (6/05b), per-workspace (8/07c) ────────────────────────────

/** The dock shows the ACTIVE workspace's possession (the browser you see). */
function pushActivity(): void {
  const win = getWin?.()
  if (!win || win.isDestroyed()) return
  const s = wsAgent.get(activeWorkspaceId)
  const activity: BrowserAgentActivity = {
    driving: s?.driving ?? false,
    allowed: consentFor(activeWorkspaceId),
    trail: (s?.recent ?? []).slice(-12),
    pendingConfirm: s?.pendingConfirm ?? undefined
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
  for (const [wsId, s] of wsAgent) {
    if (s.driving) driving.push(wsId)
  }
  for (const wsId of lastAgentAct.keys()) if (agentAttached(wsId)) attached.push(wsId)
  win.webContents.send(BrowserChannels.possession, { attached, driving })
}

function markDriving(wsId: string, verb: BrowserAgentVerbName, target?: string): void {
  const s = wsa(wsId)
  s.recent.push({ verb, target, at: Date.now() })
  if (s.recent.length > 50) s.recent.shift()
  s.driving = true
  lastAgentAct.set(wsId, Date.now())
  if (s.drivingTimer) clearTimeout(s.drivingTimer)
  s.drivingTimer = setTimeout(() => {
    s.driving = false
    pushActivity()
    pushPossession()
  }, 1500)
  pushActivity()
  pushPossession()
}

/** Revoke possession of the ACTIVE workspace's browser (the dock Stop button —
 *  it governs the browser you're looking at). */
export function agentStop(): void {
  const s = wsAgent.get(activeWorkspaceId)
  if (s) {
    s.driving = false
    if (s.drivingTimer) clearTimeout(s.drivingTimer)
    s.confirmed.clear()
    s.pendingConfirm = null
  }
  lastAgentAct.delete(activeWorkspaceId)
  try {
    activeWc()?.stop()
  } catch {
    /* nothing loading */
  }
  pushActivity()
  pushPossession()
}

export function setAgentConsent(allowed: boolean, workspaceId?: string): void {
  const wsId = typeof workspaceId === 'string' && workspaceId ? workspaceId : activeWorkspaceId
  if (wsId) {
    getSettingsStore()?.setSetting(kvConsent(wsId), allowed ? '1' : '')
    if (wsId !== activeWorkspaceId) {
      activeWorkspaceId = wsId
      pushState() // switching workspaces switches the shown browser
    }
  }
  if (!allowed && wsId === activeWorkspaceId) agentStop()
  else {
    pushActivity()
    pushPossession()
  }
}

export function confirmPendingActOrigin(origin: string): void {
  const s = wsa(activeWorkspaceId)
  if (!origin || origin !== s.pendingConfirm) return
  s.confirmed.add(origin)
  s.pendingConfirm = null
  recordTrail({ ts: Date.now(), source: 'web', workspaceId: activeWorkspaceId, verb: 'confirm', target: origin, outcome: 'confirmed' })
  pushActivity()
}

/** Resolve the browser session an agentAct targets: an agent call carries its
 *  pane -> its OWN workspace; a human/IPC/smoke call (no pane) acts on the
 *  foreground workspace. */
function sessionForCtx(ctx?: { pane?: string }): { wsId: string; profile: BrowserProfile; allowed: boolean } {
  const wsId = ctx?.pane ? (workspaceIdForPane(ctx.pane) ?? activeWorkspaceId) : activeWorkspaceId
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
  markDriving(sess.wsId, v.verb, trailTarget)
  const refusal = gateAct(v, wc, sess.wsId, sess.profile)
  if (refusal) return refusal
  const ring = bufs.get(wc.id) ?? { console: [], net: [] }
  try {
    switch (v.verb) {
      case 'navigate': {
        // Navigate THIS agent's guest (not the foreground one).
        const url = normalizeUrl(String(v.target ?? ''))
        if (!url) return { ok: false, reason: 'badtarget' }
        void wc.loadURL(url)
        return { ok: true }
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
