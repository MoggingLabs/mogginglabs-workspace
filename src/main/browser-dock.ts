import { BrowserWindow, WebContentsView, ipcMain, shell, session, type Session } from 'electron'
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
 * The browser dock's MAIN side (Phase-6/05; 8/04 adds the agent web profile).
 * Split in two, deliberately:
 *   `dock`   — WebContentsView lifecycle, bounds, visibility, persistence.
 *   `driver` — verb-shaped navigate/read acts. The dock chrome calls these
 *              over IPC today; 6/05b hands the SAME verbs to agents via the
 *              phase-8 MCP server. Build nothing here that assumes a human.
 * TWO session profiles, one dock (ADR 0008.e — FINDINGS Branch C):
 *   preview   — `persist:browser-dock`, the 6/05 behavior byte-for-byte.
 *   agent-web — the dedicated signed-in profile the user logs into ON
 *               PURPOSE. Acts (click/type/select/eval/navigate) are gated per
 *               ORIGIN by the workspace integrations grant, sensitive origins
 *               refuse always, and every act/refusal/confirm lands in the
 *               trail. Persistence is VAULT-CONDITIONED (0008.h): no OS vault
 *               means a NON-persist partition — never weakly-protected
 *               cookies at rest.
 * ADR 0002 holds: we inject and read NOTHING from other browsers — the ONLY
 * cookie store touched is our own agent-web partition, at the user's request
 * (Signed-in sites / forget). Branch B (system cookie stores) stays parked.
 */

const KV_OPEN = 'browser.open'
const KV_WIDTH = 'browser.width'
const kvLastUrl = (workspaceId: string): string => `browser.lastUrl.${workspaceId}`
const kvProfile = (workspaceId: string): string => `browser.profile.${workspaceId}`
const DEFAULT_WIDTH = 420

const PREVIEW_PARTITION = 'persist:browser-dock'
const AGENTWEB_PARTITION = 'persist:agent-web'
const AGENTWEB_EPHEMERAL = 'agent-web-ephemeral' // no `persist:` -> memory only

let getWin: (() => BrowserWindow | null) | null = null
let lastBounds: BrowserDockBounds | null = null
let open = false
let widthPersistTimer: NodeJS.Timeout | null = null
// True while the dock is being dragged/window-resized: the native view is
// hidden and left un-resized so the page never reflows mid-drag (8/07 polish).
let resizing = false
// Mirrors the ACTIVE view's real setVisible state (smoke ground truth — the
// freeze is proven by this going false mid-resize and true again on release).
let viewShown = false

const views: Record<BrowserProfile, WebContentsView | null> = { preview: null, 'agent-web': null }
let profile: BrowserProfile = 'preview'
const activeView = (): WebContentsView | null => views[profile]

/** Resolved at agent-web view creation: false -> the ephemeral partition. */
let agentWebPersists = true
let vaultProbe: () => boolean = isKeyVaultAvailable
/** Smoke-only: force the vault-less arm without a second boot. */
export function setAgentWebVaultProbeForSmoke(probe: (() => boolean) | null): void {
  vaultProbe = probe ?? isKeyVaultAvailable
}

// ── Agent control state (6/05b) ────────────────────────────────────────────
// Consent is per-workspace, default OFF; the renderer pushes the ACTIVE
// workspace's grant here (there is ONE shared dock — the human sees the active
// workspace beside it, so its grant governs). `driving` latches while a verb is
// in flight + a grace beat, so possession is always visible.
let agentAllowed = false
let activeWorkspaceId = ''
let driving = false
let drivingClearTimer: NodeJS.Timeout | null = null
const trail: BrowserAgentActivity['trail'] = []
// 8/04: session-scoped human confirms — first ACT per granted origin raises
// the banner; cleared on Stop / consent-off / profile switch, never persisted.
const confirmedOrigins = new Set<string>()
let pendingConfirm: string | null = null
// Per-profile error-feedback rings (6/05b), so profiles never interleave.
const bufs: Record<BrowserProfile, { console: string[]; net: string[] }> = {
  preview: { console: [], net: [] },
  'agent-web': { console: [], net: [] }
}
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
  const wc = activeView()?.webContents
  const state: BrowserDockState = {
    url: wc?.getURL() ?? '',
    title: wc?.getTitle() ?? '',
    canGoBack: wc?.navigationHistory.canGoBack() ?? false,
    canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    loading: wc?.isLoading() ?? false,
    profile,
    agentWebPersists
  }
  win.webContents.send(BrowserChannels.state, state)
}

function applyBounds(): void {
  const view = activeView()
  if (!view || !lastBounds) return
  view.setBounds({
    x: Math.round(lastBounds.x),
    y: Math.round(lastBounds.y),
    width: Math.round(lastBounds.width),
    height: Math.round(lastBounds.height)
  })
  // Stay hidden while a resize is in flight — never re-show mid-drag (the
  // resize handler flips `resizing` off before it calls applyBounds to snap).
  const vis = !resizing && open && lastBounds.visible
  view.setVisible(vis)
  viewShown = vis
  // Attach-swap: the inactive profile's view never paints.
  const other = views[profile === 'preview' ? 'agent-web' : 'preview']
  other?.setVisible(false)
}

/** The 6/05 hardening, ONE function for BOTH profiles: deny-all permissions,
 *  scoped to the given partition only (the app's own session is untouched). */
function hardenSession(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
}

/** Lazily create a profile's view on first use — until then the renderer's
 *  empty state shows through (and the gallery can shoot the dock offline). */
function ensureView(p: BrowserProfile): WebContentsView {
  const existing = views[p]
  if (existing) return existing
  let partition = PREVIEW_PARTITION
  if (p === 'agent-web') {
    // Vault-conditioned persistence (ADR 0008.h): Chromium's cookie encryption
    // rides the same OS facility as our vault — no vault, no cookies at rest.
    agentWebPersists = !process.env.MOGGING_TEST_NO_VAULT && vaultProbe()
    partition = agentWebPersists ? AGENTWEB_PARTITION : AGENTWEB_EPHEMERAL
  }
  const ses = session.fromPartition(partition)
  hardenSession(ses)
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  views[p] = view
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
    wc.on(ev as never, () => {
      if (views[p] === activeView()) pushState()
    })
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
    bufs[p].console.push(`[${level}] ${message}`)
    if (bufs[p].console.length > RING) bufs[p].console.shift()
  })
  wc.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return // ABORTED — user/nav churn, not a failure
    bufs[p].net.push(`${code} ${desc} ${url}`)
    if (bufs[p].net.length > RING) bufs[p].net.shift()
  })
  wc.on('did-start-navigation', (_e, _url, _inPage, isMainFrame) => {
    if (isMainFrame) {
      bufs[p].console.length = 0
      bufs[p].net.length = 0
    }
  })
  if (p === 'agent-web') {
    // Origin-change watch (8/04): crossing origins in the signed-in profile is
    // exactly where a hijacked agent (or a hostile redirect) becomes dangerous
    // — alert the human, land a trail event. ORIGINS only, never page content.
    let lastOrigin = ''
    wc.on('did-navigate', (_e, url) => {
      const next = originOf(url)
      if (lastOrigin && next && next !== lastOrigin) {
        const win = getWin?.()
        if (win && !win.isDestroyed()) win.webContents.send(BrowserChannels.originAlert, { from: lastOrigin, to: next })
        recordTrail({
          ts: Date.now(),
          source: 'web',
          workspaceId: activeWorkspaceId,
          verb: 'origin-change',
          target: next,
          outcome: 'ok',
          reason: `from ${lastOrigin}`
        })
      }
      if (next) lastOrigin = next
    })
  }
  const win = getWin?.()
  if (win && !win.isDestroyed()) win.contentView.addChildView(view)
  applyBounds()
  return view
}

/** Switch the dock between profiles (attach-swap; per-workspace persisted by
 *  the IPC handler). Confirms are session-scoped and do not cross profiles. */
function setProfile(next: BrowserProfile): void {
  if (profile === next) return
  profile = next
  pendingConfirm = null
  confirmedOrigins.clear()
  // Resolve the persistence verdict as soon as the profile shows, so the
  // banner copy is honest BEFORE the first navigation creates the view.
  if (next === 'agent-web' && !views['agent-web']) {
    agentWebPersists = !process.env.MOGGING_TEST_NO_VAULT && vaultProbe()
  }
  if (views[next]) applyBounds()
  else views[profile === 'preview' ? 'agent-web' : 'preview']?.setVisible(false)
  pushState()
  pushActivity()
}

/** The verb seam (6/05b exposes these to agents — keep them human-free). */
export const browserDriver = {
  navigate(rawUrl: string): boolean {
    const url = normalizeUrl(rawUrl)
    if (!url) return false
    void ensureView(profile).webContents.loadURL(url)
    return true
  },
  nav(action: BrowserNavAction): void {
    const wc = activeView()?.webContents
    if (!wc) return
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
  },
  state(): BrowserDockState {
    const wc = activeView()?.webContents
    return {
      url: wc?.getURL() ?? '',
      title: wc?.getTitle() ?? '',
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      loading: wc?.isLoading() ?? false,
      profile,
      agentWebPersists
    }
  }
}

// ── Agent control (6/05b): the wheel, consent-gated + visibly possessed ──────

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
 *  workspace set it; this just drops the in-flight possession latch — and the
 *  session-scoped origin confirms die with the possession (8/04). */
export function agentStop(): void {
  driving = false
  if (drivingClearTimer) clearTimeout(drivingClearTimer)
  confirmedOrigins.clear()
  pendingConfirm = null
  // A hard stop also halts whatever is loading, so "Stop" is literal.
  try {
    activeView()?.webContents.stop()
  } catch {
    /* nothing loading */
  }
  pushActivity()
}

export function setAgentConsent(allowed: boolean, workspaceId?: string): void {
  agentAllowed = allowed
  if (typeof workspaceId === 'string') activeWorkspaceId = workspaceId
  if (!allowed) agentStop()
  else pushActivity()
}

/** The human's session-scoped allow ("acting on {origin} this session"). */
export function confirmPendingActOrigin(origin: string): void {
  if (!origin || origin !== pendingConfirm) return
  confirmedOrigins.add(origin)
  pendingConfirm = null
  recordTrail({
    ts: Date.now(),
    source: 'web',
    workspaceId: activeWorkspaceId,
    verb: 'confirm',
    target: origin,
    outcome: 'confirmed'
  })
  pushActivity()
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

/** The verbs that ACT on a page (IMPLEMENTATION §04's gate list — mirrors the
 *  catalog's `access:'act'` set). `eval` has NO read-tier exception, ever.
 *  Cross-origin iframes are structurally shut: refs come from the TOP frame's
 *  DOM (executeJavaScript cannot reach into a cross-origin frame), so no ref
 *  can name an element there — the gate below governs the top origin. */
const ACT_VERBS: readonly BrowserAgentVerbName[] = ['navigate', 'click', 'type', 'select', 'eval']

/** 8/04 act gate, AT DISPATCH TIME — the one choke point every transport
 *  funnels through. Returns null to proceed, or a refusal result (trailed). */
function gateAct(v: BrowserAgentVerb, wc: Electron.WebContents): BrowserAgentResult | null {
  if (profile !== 'agent-web' || !ACT_VERBS.includes(v.verb)) return null
  const origin = v.verb === 'navigate' ? originOf(normalizeUrl(String(v.target ?? '')) ?? '') : originOf(wc.getURL())
  const refuse = (outcome: 'refused', reason: string): BrowserAgentResult => {
    recordTrail({
      ts: Date.now(),
      source: 'web',
      workspaceId: activeWorkspaceId,
      verb: v.verb,
      target: origin || '(no origin)',
      outcome,
      reason
    })
    return { ok: false, reason }
  }
  if (!origin) return refuse('refused', v.verb === 'navigate' ? 'badtarget' : 'no page to act on')
  // The blocklist beats any grant, persisted or not (ADR 0008.e).
  if (isBlockedActOrigin(origin)) {
    return refuse('refused', `blocked origin ${origin} — sensitive origins never accept act grants`)
  }
  const grant = getIntegrationsGrant(activeWorkspaceId)
  if (grant.web !== 'signed-in' || !grant.actOrigins.includes(origin)) {
    return refuse(
      'refused',
      `ungranted origin ${origin} — acting on a signed-in site needs this workspace's grant (the human adds it under Sites & grants)`
    )
  }
  if (!confirmedOrigins.has(origin)) {
    pendingConfirm = origin
    pushActivity()
    return refuse('refused', `awaiting the human's allow for ${origin} this session (the dock banner) — retry after they confirm`)
  }
  recordTrail({
    ts: Date.now(),
    source: 'web',
    workspaceId: activeWorkspaceId,
    verb: v.verb,
    target: origin,
    outcome: 'ok'
  })
  return null
}

/** Dispatch one agent verb. `origin: 'agent'` verbs are consent-gated; the dock
 *  chrome's own navigate/nav go through browserDriver directly (human, ungated). */
export async function agentAct(v: BrowserAgentVerb): Promise<BrowserAgentResult> {
  if (!agentAllowed) return { ok: false, reason: 'disabled' }
  const wc = activeView()?.webContents ?? ensureView(profile).webContents
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
  // 8/04: the per-origin act gate, at dispatch, inside the choke point.
  const refusal = gateAct(v, wc)
  if (refusal) return refusal
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
        return { ok: true, lines: bufs[profile].console.slice(-Math.max(1, v.n ?? 30)) }
      case 'network_failures':
        return { ok: true, lines: bufs[profile].net.slice(-Math.max(1, v.n ?? 30)) }
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

// ── Agent-web session controls (8/04): OUR partition only, ever ─────────────

const agentWebSession = (): Session | null => {
  const view = views['agent-web']
  return view ? view.webContents.session : null
}

async function signedInSites(): Promise<BrowserSignedInSite[]> {
  const ses = agentWebSession()
  if (!ses) return []
  const cookies = await ses.cookies.get({})
  const byHost = new Map<string, number>()
  for (const c of cookies) {
    const host = (c.domain ?? '').replace(/^\./, '')
    if (host) byHost.set(host, (byHost.get(host) ?? 0) + 1)
  }
  return [...byHost.entries()].map(([host, n]) => ({ host, cookies: n })).sort((a, b) => a.host.localeCompare(b.host))
}

async function forgetSite(host: string): Promise<void> {
  const ses = agentWebSession()
  if (!ses || !host) return
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
  const ses = agentWebSession()
  if (!ses) return
  await ses.clearStorageData() // all storages incl. cookies — OUR partition only
}

/** Smoke-only: read the possession state main-side. */
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

/** Smoke-only: switch profiles / destroy the agent-web view so persistence and
 *  the vault-less arm are provable in ONE app run. Never used by features. */
export function setProfileForSmoke(p: BrowserProfile): void {
  setProfile(p)
}
export async function destroyAgentWebViewForSmoke(): Promise<void> {
  const view = views['agent-web']
  if (!view) return
  try {
    await view.webContents.session.cookies.flushStore() // disk truth before the view dies
  } catch {
    /* ephemeral partition */
  }
  const win = getWin?.()
  try {
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view)
  } catch {
    /* already detached */
  }
  try {
    view.webContents.close()
  } catch {
    /* already closed */
  }
  views['agent-web'] = null
}
export const forgetSiteForSmoke = forgetSite
export const signedInSitesForSmoke = signedInSites

/** Smoke-only: run script INSIDE the dock page (the window.open denial probe
 *  needs the attempt to originate from page context). Never used by features. */
export function dockPageEval(js: string): Promise<unknown> | null {
  const view = activeView()
  return view ? view.webContents.executeJavaScript(js, true) : null
}

/** Smoke-only ground truth (main-side): where the view actually is. */
export function dockDebug(): {
  attached: boolean
  visible: boolean
  bounds: BrowserDockBounds | null
  url: string
  resizing: boolean
  viewShown: boolean
} {
  const view = activeView()
  return {
    attached: !!view,
    visible: !!view && open && !!lastBounds?.visible,
    bounds: lastBounds,
    url: view?.webContents.getURL() ?? '',
    resizing,
    viewShown
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
    // First open with nothing loaded -> restore this workspace's last PREVIEW
    // url (the agent-web profile restores nothing — signed-in pages reopen on
    // the user's own navigation, never automatically).
    if (open && profile === 'preview' && !views.preview && payload?.workspaceId) {
      const last = store()?.getSetting(kvLastUrl(payload.workspaceId))
      if (last) browserDriver.navigate(last)
    }
    applyBounds()
    pushState()
  })

  ipcMain.handle(BrowserChannels.navigate, (_e, payload: { url: string; workspaceId?: string }) => {
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

  const persistWidth = (dockWidth: number): void => {
    if (widthPersistTimer) clearTimeout(widthPersistTimer)
    widthPersistTimer = setTimeout(() => store()?.setSetting(KV_WIDTH, String(Math.round(dockWidth))), 500)
  }

  ipcMain.on(BrowserChannels.bounds, (_e, b: BrowserDockBounds) => {
    lastBounds = b
    // During a CONTINUOUS resize (handle drag / OS-window drag) the view is
    // FROZEN (hidden) — store the rect but do NOT resize the WebContents every
    // frame. Resizing a real page relayouts it (10–50 ms); doing that 60×/s is
    // exactly the lag the user sees, the native layer trailing the chrome.
    if (resizing) return
    applyBounds()
    persistWidth(b.dockWidth)
  })

  // The freeze signal (8/07 polish). The renderer resizes the CSS chrome alone
  // at 60 fps during the drag; we snap the native view to the FINAL rect once
  // on release — no per-frame reflow, no trailing.
  ipcMain.on(BrowserChannels.resizing, (_e, p: { active?: boolean; bounds?: BrowserDockBounds }) => {
    resizing = !!p?.active
    if (resizing) {
      activeView()?.setVisible(false)
      viewShown = false
      return
    }
    if (p?.bounds) lastBounds = p.bounds
    applyBounds()
    if (lastBounds) persistWidth(lastBounds.dockWidth)
  })

  // ── Agent control (6/05b) ─────────────────────────────────────────────────
  const kvConsent = (wsId: string): string => `browser.agentControl.${wsId}`
  ipcMain.handle(BrowserChannels.consentGet, (_e, wsId: string) => store()?.getSetting(kvConsent(String(wsId))) === '1')
  ipcMain.handle(BrowserChannels.consentSet, (_e, p: { workspaceId: string; allowed: boolean }) => {
    store()?.setSetting(kvConsent(String(p?.workspaceId)), p?.allowed ? '1' : '')
  })
  // The renderer makes the ACTIVE workspace's stored grant LIVE (on switch/boot).
  // 8/04: the workspace id rides along — act-origin grants resolve against it.
  ipcMain.on(BrowserChannels.consent, (_e, payload: { allowed: boolean; workspaceId?: string }) => {
    setAgentConsent(!!payload?.allowed, payload?.workspaceId)
  })
  // An agent verb. Today the smoke calls this directly; the phase-8 MCP server
  // (8/02) registers each verb as a tool that lands HERE — one driver, one
  // gate, whatever the transport. Consent is re-checked inside agentAct.
  ipcMain.handle(BrowserChannels.agentAct, (_e, v: BrowserAgentVerb) => agentAct(v))
  ipcMain.on(BrowserChannels.agentStop, () => agentStop())

  // ── Agent web profile (8/04) ──────────────────────────────────────────────
  ipcMain.handle(BrowserChannels.profileGet, (_e, wsId: string): BrowserProfile => {
    return store()?.getSetting(kvProfile(String(wsId))) === 'agent-web' ? 'agent-web' : 'preview'
  })
  ipcMain.handle(BrowserChannels.profileSet, (_e, p: { workspaceId?: string; profile: BrowserProfile }) => {
    const next: BrowserProfile = p?.profile === 'agent-web' ? 'agent-web' : 'preview'
    if (p?.workspaceId) store()?.setSetting(kvProfile(String(p.workspaceId)), next)
    setProfile(next)
  })
  ipcMain.on(BrowserChannels.confirmOrigin, (_e, p: { origin: string }) => {
    confirmPendingActOrigin(String(p?.origin ?? ''))
  })
  ipcMain.handle(BrowserChannels.signedInSites, () => signedInSites())
  ipcMain.handle(BrowserChannels.forgetSite, (_e, host: string) => forgetSite(String(host ?? '')))
  ipcMain.handle(BrowserChannels.clearAgentLogins, () => clearAgentLogins())
}
