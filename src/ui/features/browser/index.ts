import type { UiFeature } from '../../core/registry/feature-registry'
import {
  BrowserChannels,
  ClipboardChannels,
  DEFAULT_SEARCH_TEMPLATE,
  IntegrationsChannels,
  browserAgentWebPartition,
  browserPreviewPartition,
  resolveAddressInput,
  searchUrlFor,
  type BrowserAgentActivity,
  type BrowserContextMenuParams,
  type BrowserDockInit,
  type BrowserDockState,
  type BrowserGuestChord,
  type BrowserNavAction,
  type BrowserPossession,
  type BrowserProfile,
  type BrowserSignedInSite,
  type TrailEntry,
  type WorkspaceIntegrationsGrant
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { IconButton, clear, confirmDialog, el, icon, openContextMenu, showToast } from '../../components'
import { assignmentForPane, getWorkspaces, onWorkspacesChange } from '../../core/workspace/workspace-info-port'
import { setCommands } from '../../core/commands/command-port'
import { isModKey } from '../../core/commands/shortcuts'
import { createAsyncGuard } from '../../core/async/async-state'
import { shortcutsBlocked } from '../../core/commands/context'
import { getTelemetry } from '../../core/telemetry'
import { normalizeBrowserOrigin } from '../../core/browser-origin'
import { dockLayoutBudget, onDockLayoutChange, requestDockLayout } from '../../core/layout/dock-budget'

/**
 * The browser dock (Phase-6/05): a toggleable right dock previewing what the
 * agents build — chrome beside the grid, never a tenant of it. The renderer
 * owns the chrome AND hosts the page as in-DOM <webview> guests (8/07), so the
 * dock resizes them in lockstep with the chrome. The guests run out-of-process
 * in their own partitions; main drives them by webContents id. ADR 0002: this
 * renderer touches no sessions, cookies, or credentials — the guest is isolated.
 */

/** The `<webview>` element methods/events the chrome drives directly — find,
 *  zoom, stop, and the page-status events are viewport concerns that never need
 *  a main round-trip (the element IS in this renderer). */
interface WebviewEl extends HTMLElement {
  stop(): void
  reload(): void
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  setZoomLevel(level: number): void
  setAudioMuted(muted: boolean): void
  isAudioMuted(): boolean
  loadURL(url: string): Promise<void>
  getURL(): string
}
export const browserFeature: UiFeature = {
  name: 'browser',
  mount(ctx) {
    const bridge = getBridge()
    let open = false
    let width = 420
    let searchTemplate = DEFAULT_SEARCH_TEMPLATE // the omnibox engine (F3); set from the store at boot
    let state: BrowserDockState = {
      workspaceId: '',
      url: '',
      title: '',
      canGoBack: false,
      canGoForward: false,
      loading: false,
      profile: 'preview',
      agentWebPersists: true
    }

    // ── Dock skeleton: header (chrome) + view host (the WebContentsView's rect) ──
    const dock = el('aside', { class: 'browser-dock', hidden: true })
    dock.setAttribute('aria-label', 'Browser preview')
    const handle = el('div', { class: 'browser-dock-handle' })
    handle.tabIndex = 0
    handle.setAttribute('role', 'separator')
    handle.setAttribute('aria-orientation', 'vertical')
    handle.setAttribute('aria-label', 'Resize browser dock')

    const back = IconButton({ icon: 'chevron-left', label: 'Back', title: 'Back', onClick: () => nav('back') })
    const forward = IconButton({ icon: 'chevron-right', label: 'Forward', title: 'Forward', onClick: () => nav('forward') })
    // Reload doubles as Stop while a page loads (F13) — one button, Comet/Chrome-style.
    const reload = IconButton({
      icon: 'rotate-cw',
      label: 'Reload',
      title: 'Reload',
      onClick: () => {
        if (state.loading) activeGuest()?.stop()
        else nav('reload')
      }
    })
    // The address bar's leading indicator (F13): a favicon / lock (https) / not-secure
    // (http) / search glyph, exactly where a browser puts it.
    const urlLead = el('span', { class: 'browser-url-lead' })
    const urlInput = el('input', { class: 'browser-url' }) as HTMLInputElement
    urlInput.placeholder = 'Search or enter address'
    urlInput.setAttribute('aria-label', 'Address and search bar')
    urlInput.spellcheck = false
    const urlWrap = el('div', { class: 'browser-url-wrap' }, [urlLead, urlInput])
    const external = IconButton({
      icon: 'external-link',
      label: 'Open in system browser',
      title: 'Open in system browser',
      onClick: () => {
        if (state.url) void bridge.invoke(BrowserChannels.openExternal, { url: state.url })
      }
    })
    // Audio indicator + mute (F15): appears only while the active guest is making
    // sound (a background workspace's video keeps playing invisibly — this is the way
    // to notice and silence it), Chrome/Comet-style.
    const audioBtn = IconButton({
      icon: 'bell',
      label: 'Mute tab audio',
      title: 'Mute this page',
      onClick: () => toggleMute()
    })
    audioBtn.hidden = true
    const close = IconButton({ icon: 'x', label: 'Close browser', title: 'Close (Ctrl+Shift+U)', onClick: () => toggle(false) })
    const loading = el('div', { class: 'browser-loading' })
    // Profile switch (8/04): Preview ⇄ Agent web, persisted per workspace.
    const profilePreviewBtn = el('button', { class: 'browser-profile-opt is-active', type: 'button', text: 'Preview' }) as HTMLButtonElement
    profilePreviewBtn.title = 'The empty preview profile (no logins)'
    const profileAgentBtn = el('button', { class: 'browser-profile-opt', type: 'button', text: 'Agent web' }) as HTMLButtonElement
    profileAgentBtn.title = 'The signed-in profile — agents act only on origins you grant'
    const profileSwitch = el('div', { class: 'browser-profile-switch' }, [profilePreviewBtn, profileAgentBtn])
    profilePreviewBtn.onclick = (): void => void setProfile('preview')
    profileAgentBtn.onclick = (): void => void setProfile('agent-web')
    const header = el('div', { class: 'browser-dock-header' }, [back, forward, reload, urlWrap, profileSwitch, audioBtn, external, close])
    // The tab strip (F4): Chrome/Comet-style, above the address bar. Shown whenever
    // the dock has a workspace, so "new tab" is always one click away.
    const tabStrip = el('div', { class: 'browser-tab-strip', hidden: true })

    // ── Agent possession (6/05b): visible whenever an agent holds the wheel ──
    const stopBtn = el('button', { class: 'browser-agent-stop', type: 'button', text: 'Stop' }) as HTMLButtonElement
    stopBtn.title = 'Revoke agent control now'
    let activityWorkspaceId = ''
    stopBtn.onclick = (): void => {
      if (activityWorkspaceId) bridge.send(BrowserChannels.agentStop, { workspaceId: activityWorkspaceId })
    }
    // The Comet possession pill: WHO is driving + the LIVE action, an animated
    // indicator, and Stop — so at a glance you see which agent is at the wheel and
    // what it is doing right now (goals 5 + 6).
    const agentDot = el('span', { class: 'browser-agent-dot' }) // the animated "working" indicator
    const agentName = el('span', { class: 'browser-agent-name', text: 'Agent' })
    const agentAction = el('span', { class: 'browser-agent-action' }) // "Reading page…" — the live verb
    const trailBtn = IconButton({ icon: 'more', label: 'Agent activity', title: 'Recent agent actions', onClick: () => {
      trailMenu.hidden = !trailMenu.hidden
    } })
    const agentLabelGroup = el('span', { class: 'browser-agent-label-group' }, [
      agentName,
      el('span', { class: 'browser-agent-sep', text: 'is browsing' }),
      agentAction
    ])
    const banner = el('div', { class: 'browser-agent-banner', hidden: true }, [
      agentDot,
      agentLabelGroup,
      el('div', { class: 'browser-agent-spacer' }),
      trailBtn,
      stopBtn
    ])
    banner.setAttribute('role', 'status')
    banner.setAttribute('aria-live', 'polite')
    const trailMenu = el('div', { class: 'menu browser-agent-trail', hidden: true })

    // pane id (its provider assignment) → the agent's display name (goal 6).
    const AGENT_LABEL: Record<string, string> = {
      claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', aider: 'Aider', opencode: 'OpenCode'
    }
    function agentNameFor(pane: string | undefined): string {
      if (!pane) return 'An agent'
      const provider = assignmentForPane(Number(pane))
      const label = provider ? (AGENT_LABEL[provider] ?? provider) : null
      return label ? `${label} · pane ${pane}` : `Agent · pane ${pane}`
    }

    // ── Agent web profile chrome (8/04) ─────────────────────────────────────
    // The quiet notice: sessions persist here (or the vault-less honesty),
    // plus the door to Sites & grants. Rendered only in the agent-web profile.
    const noteText = el('span', { class: 'browser-agentweb-note-text' })
    const sitesBtn = el('button', { class: 'browser-agentweb-sites', type: 'button', text: 'Sites & grants…' }) as HTMLButtonElement
    const agentWebNote = el('div', { class: 'browser-agentweb-note', hidden: true }, [
      noteText,
      el('div', { class: 'browser-agent-spacer' }),
      sitesBtn
    ])
    // The session-scoped confirm: first ACT per granted origin per possession.
    const confirmBtn = el('button', { class: 'browser-confirm-btn', type: 'button' }) as HTMLButtonElement
    const confirmBar = el('div', { class: 'browser-confirm-bar', hidden: true }, [
      el('span', { class: 'browser-confirm-text', text: 'An agent wants to act on a signed-in site:' }),
      confirmBtn
    ])
    let pendingOrigin = ''
    confirmBtn.onclick = (): void => {
      if (pendingOrigin && activityWorkspaceId) {
        bridge.send(BrowserChannels.confirmOrigin, { workspaceId: activityWorkspaceId, origin: pendingOrigin })
      }
    }
    // Recent acts (8/05): the last 3 TRAIL entries for the possessing
    // workspace — the audit surface's compact face on the possession chrome.
    const recentActs = el('div', { class: 'browser-recent-acts', hidden: true })
    let recentActsTimer: number | undefined
    function refreshRecentActs(): void {
      window.clearTimeout(recentActsTimer)
      recentActsTimer = window.setTimeout(async () => {
        const capture = captureWorkspace()
        const wsId = capture.id
        if (!wsId || state.profile !== 'agent-web') {
          recentActs.hidden = true
          return
        }
        const entries = (await bridge.invoke(IntegrationsChannels.trailList, wsId)) as TrailEntry[]
        if (!workspaceStillCurrent(capture) || state.profile !== 'agent-web') return
        const last = entries.filter((t) => t.source === 'web').slice(-3).reverse()
        clear(recentActs)
        for (const t of last) {
          recentActs.append(
            el('span', { class: `browser-recent-act is-${t.outcome}`, text: `${t.verb} · ${t.target} · ${t.outcome}` })
          )
        }
        recentActs.hidden = last.length === 0
      }, 400)
    }
    // Origin-change alert: the signed-in profile crossed origins (transient).
    const originAlert = el('div', { class: 'browser-origin-alert', hidden: true })
    const permChip = el('div', { class: 'browser-perm-chip', hidden: true }) // blocked-permission chip (F16)
    let originAlertTimer: number | undefined
    bridge.on(BrowserChannels.originAlert, (payload) => {
      const p = payload as { workspaceId?: string; from: string; to: string }
      if (p.workspaceId !== activeWsId()) return
      originAlert.textContent = `Crossed origins: ${p.from} → ${p.to}`
      originAlert.hidden = false
      window.clearTimeout(originAlertTimer)
      originAlertTimer = window.setTimeout(() => {
        originAlert.hidden = true
      }, 6000)
    })
    // Sites & grants panel: signed-in sites in OUR agent-web partition (forget /
    // clear) + the minimal act-origin grant editor (Settings § Browser is the
    // full home).
    const sitesMenu = el('div', { class: 'menu browser-sites-menu', hidden: true })
    sitesBtn.onclick = (): void => {
      sitesMenu.hidden = !sitesMenu.hidden
      if (!sitesMenu.hidden) void refreshSitesMenu()
    }

    // Workspace-preview chip: shown when the active workspace remembers a
    // DIFFERENT url than the one on screen (switching never auto-navigates).
    const wsChip = el('button', { class: 'browser-ws-chip', type: 'button', hidden: true }) as HTMLButtonElement

    // The empty state is the only place the dock explains itself, so ONE function writes
    // its copy (renderEmptyCopy) — it must never chirp "Enter a URL above" over a URL bar
    // that cannot be typed into (finding 33).
    const emptyTitle = el('div', { class: 'browser-empty-title' })
    const emptyHint = el('div', { class: 'browser-empty-hint' })
    const quickChips = el('div', { class: 'browser-quick-chips' }) // pinned + recent URLs (F14)
    const empty = el('div', { class: 'browser-empty' }, [icon('globe', 28), emptyTitle, emptyHint, quickChips])

    // ── Load-error / crash overlay (F10): a real browser explains a dead page ──
    const errorTitle = el('div', { class: 'browser-error-title' })
    const errorDesc = el('div', { class: 'browser-error-desc' })
    const errorRetry = el('button', { class: 'browser-error-retry', type: 'button', text: 'Retry' }) as HTMLButtonElement
    const loadError = el('div', { class: 'browser-load-error', hidden: true }, [
      icon('alert', 26),
      errorTitle,
      errorDesc,
      errorRetry
    ])
    errorRetry.onclick = (): void => {
      loadError.hidden = true
      activeGuest()?.reload()
    }

    // ── Find-in-page bar (F5) ────────────────────────────────────────────────
    const findInput = el('input', { class: 'browser-find-input' }) as HTMLInputElement
    findInput.placeholder = 'Find in page'
    findInput.setAttribute('aria-label', 'Find in page')
    findInput.spellcheck = false
    const findCount = el('span', { class: 'browser-find-count', text: '' })
    const findPrev = IconButton({ icon: 'chevron-up', label: 'Previous match', title: 'Previous (Shift+Enter)', onClick: () => runFind(false) })
    const findNext = IconButton({ icon: 'chevron-down', label: 'Next match', title: 'Next (Enter)', onClick: () => runFind(true) })
    const findClose = IconButton({ icon: 'x', label: 'Close find', title: 'Close (Esc)', onClick: () => closeFind() })
    const findBar = el('div', { class: 'browser-find-bar', hidden: true }, [findInput, findCount, findPrev, findNext, findClose])

    // A transient zoom badge (F6), Chrome-style.
    const zoomBadge = el('div', { class: 'browser-zoom-badge', hidden: true })

    // The viewHost holds the guest <webview>s (8/07). They ARE the page — in
    // the DOM, so the dock resizes them in LOCKSTEP with the chrome (one
    // compositor, no main-owned view to position). Two guests (preview /
    // agent-web) stay live and stacked; the active one is on top, the empty
    // state (and the load-error overlay) sit above both.
    const viewHost = el('div', { class: 'browser-dock-view' }, [empty, loadError, zoomBadge])
    dock.append(handle, tabStrip, header, findBar, agentWebNote, banner, recentActs, confirmBar, originAlert, permChip, trailMenu, sitesMenu, loading, wsChip, viewHost)
    // The dock is #content's flex sibling inside #main — inserted, not slotted,
    // so the shell stays feature-agnostic.
    ctx.content.insertAdjacentElement('afterend', dock)

    // ── Per-workspace guest webviews (8/07b) ────────────────────────────────
    // Every workspace has its OWN browser: two <webview>s (preview / agent-web)
    // with WORKSPACE-SCOPED partitions, so each keeps its own live page AND its
    // own cookie jar/logins. Switching workspaces shows that workspace's
    // browser. Guests are kept per workspace with an LRU cap so memory stays
    // bounded; an evicted workspace re-creates + restores its last url on return.
    const GUEST_CAP = 3 // live workspaces with browsers (× 2 profiles)
    const guests = new Map<string, HTMLElement>()
    const lru: string[] = [] // workspace ids, most-recent last
    const pinnedWs = new Set<string>() // agent-attached — never evicted (8/07c)
    let agentWebPersists = true
    // Tabs (F4): each (workspace, profile) holds an ordered set of tabs, one <webview>
    // each. The base tab (t0) is the pre-tabs single guest — restore + lastUrl ride it.
    const BASE_TAB = 't0'
    let tabSeq = 0
    const newTabId = (): string => `t${++tabSeq}` // t1, t2, … (base is always t0)
    interface Tab { id: string; url: string; title: string; favicon: string; pending?: string }
    const wpk = (wsId: string, p: BrowserProfile): string => `${wsId}:${p}`
    const tabsMap = new Map<string, Tab[]>() // wpk -> ordered tabs
    const activeTabMap = new Map<string, string>() // wpk -> active tab id
    const tabsFor = (wsId: string, p: BrowserProfile): Tab[] => {
      const k = wpk(wsId, p)
      let list = tabsMap.get(k)
      if (!list) {
        list = [{ id: BASE_TAB, url: '', title: '', favicon: '' }]
        tabsMap.set(k, list)
      }
      return list
    }
    const activeTabId = (wsId: string, p: BrowserProfile): string => activeTabMap.get(wpk(wsId, p)) ?? BASE_TAB
    const gkey = (wsId: string, p: BrowserProfile, tabId: string): string => `${wsId}:${p}#${tabId}`
    const activeWsId = (): string => getWorkspaces().activeId ?? ''
    let workspaceGeneration = 0
    const captureWorkspace = (): { id: string; generation: number } => ({
      id: activeWsId(),
      generation: workspaceGeneration
    })
    const workspaceStillCurrent = (capture: { id: string; generation: number }): boolean =>
      capture.id === activeWsId() && capture.generation === workspaceGeneration
    // Last-known profile PER WORKSPACE (state pushes + profileGet fill it). activeKey
    // must not read `state.profile` at a switch boundary: that is still the PREVIOUS
    // workspace's profile until main's push lands, and for one beat the wrong guest sat
    // on top — possibly the signed-in one over a preview workspace (finding B9). A miss
    // falls to 'preview', the safe direction (new workspaces are preview by default).
    const wsProfile = new Map<string, BrowserProfile>()
    const activeProfile = (): BrowserProfile => wsProfile.get(activeWsId()) ?? 'preview'
    const activeKey = (): string => {
      const wsId = activeWsId()
      const p = activeProfile()
      return gkey(wsId, p, activeTabId(wsId, p))
    }

    function makeGuest(wsId: string, p: BrowserProfile, tabId: string): HTMLElement {
      const partition = p === 'preview' ? browserPreviewPartition(wsId) : browserAgentWebPartition(wsId, agentWebPersists)
      const wv = document.createElement('webview')
      wv.className = 'browser-guest'
      wv.setAttribute('partition', partition)
      wv.setAttribute('src', 'about:blank')
      wv.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=yes,nodeIntegration=no')
      // OAuth needs popups (F1). Without `allowpopups` a webview blocks window.open
      // outright and main's window-open handler never sees it; WITH it, every popup
      // is still funneled through that handler (http(s) only, hardened child) — the
      // guest can request a window, main decides what it becomes.
      wv.setAttribute('allowpopups', '')
      const tab = (): Tab | undefined => tabsFor(wsId, p).find((t) => t.id === tabId)
      wv.addEventListener('dom-ready', () => {
        readyGuests.add(wv) // its <webview> methods are safe to call now
        try {
          bridge.send(BrowserChannels.guest, { workspaceId: wsId, profile: p, tabId, id: (wv as unknown as { getWebContentsId(): number }).getWebContentsId() })
        } catch {
          /* not attached yet */
        }
        applyZoom() // a re-created guest inherits its workspace's zoom
        const t = tab()
        if (t?.pending) {
          const u = t.pending
          t.pending = undefined
          void (wv as WebviewEl).loadURL(u) // a new tab's initial url, raced-free
        }
      })
      // Per-tab metadata for the strip (title/url/favicon), tracked on EVERY tab so an
      // inactive tab still shows the right label.
      const onNav = (e: Event): void => {
        const url = (e as unknown as { url?: string }).url
        const t = tab()
        if (t && typeof url === 'string') {
          t.url = url === 'about:blank' ? '' : url
          publishTabs(wsId, p)
        }
      }
      wv.addEventListener('did-navigate', onNav)
      wv.addEventListener('did-navigate-in-page', onNav)
      wv.addEventListener('page-title-updated', (e) => {
        const t = tab()
        if (t) {
          t.title = String((e as unknown as { title?: string }).title ?? '')
          publishTabs(wsId, p)
        }
      })
      // Page-status events fire on the element (renderer-side); they touch the chrome
      // ONLY for the guest currently on top, so a background workspace's page can't
      // repaint the header you're looking at.
      wv.addEventListener('page-favicon-updated', (e) => {
        const urls = (e as unknown as { favicons?: string[] }).favicons ?? []
        const t = tab()
        if (t) t.favicon = urls[0] ?? ''
        if (urls[0]) wsFavicon.set(wsId, urls[0])
        else wsFavicon.delete(wsId)
        if (isActiveGuest(wv)) renderUrlLead()
        publishTabs(wsId, p)
      })
      wv.addEventListener('did-start-loading', () => {
        if (isActiveGuest(wv)) loadError.hidden = true // a new attempt clears the last failure
      })
      wv.addEventListener('did-fail-load', (e) => {
        const ev = e as unknown as { errorCode: number; errorDescription: string; isMainFrame: boolean }
        if (ev.errorCode === -3 || !ev.isMainFrame) return // -3 = aborted (a normal redirect)
        if (isActiveGuest(wv)) showLoadError(ev.errorCode, ev.errorDescription)
      })
      wv.addEventListener('crashed', () => {
        if (isActiveGuest(wv)) showCrash()
      })
      wv.addEventListener('found-in-page', (e) => {
        if (!isActiveGuest(wv)) return
        const r = (e as unknown as { result?: { matches: number; activeMatchOrdinal: number } }).result
        if (!r) return
        findCount.textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : 'No results'
      })
      // Audio state (F15): show the mute control while THIS guest makes sound, and
      // re-apply the workspace's mute choice when a fresh media element starts.
      wv.addEventListener('media-started-playing', () => {
        playingGuests.add(wv)
        if (mutedWs.has(wsId)) (wv as WebviewEl).setAudioMuted(true)
        if (isActiveGuest(wv)) refreshAudioChrome()
      })
      wv.addEventListener('media-paused', () => {
        playingGuests.delete(wv)
        if (isActiveGuest(wv)) refreshAudioChrome()
      })
      return wv
    }

    /** Create a tab's guest webview (idempotent) and slot it into the host. */
    function ensureTabGuest(wsId: string, p: BrowserProfile, tabId: string): HTMLElement {
      const k = gkey(wsId, p, tabId)
      let wv = guests.get(k)
      if (!wv) {
        wv = makeGuest(wsId, p, tabId)
        guests.set(k, wv)
        viewHost.append(wv)
      }
      return wv
    }

    function evictWorkspace(wsId: string): void {
      for (const p of ['preview', 'agent-web'] as const) {
        for (const t of tabsFor(wsId, p)) {
          const k = gkey(wsId, p, t.id)
          const wv = guests.get(k)
          if (wv) {
            bridge.send(BrowserChannels.guestGone, { workspaceId: wsId, profile: p, tabId: t.id })
            wv.remove()
            guests.delete(k)
          }
        }
        tabsMap.delete(wpk(wsId, p)) // its tabs are ephemeral; a return restores the base tab
        activeTabMap.delete(wpk(wsId, p))
      }
    }

    /** Ensure the given workspace's BASE-tab guests exist (lazy per workspace), touch
     *  its LRU position, and evict the oldest beyond the cap (never the active). Extra
     *  tabs are created on demand and not restored after eviction. */
    function ensureGuests(wsId: string): void {
      if (!wsId) return
      const at = lru.indexOf(wsId)
      if (at >= 0) lru.splice(at, 1)
      lru.push(wsId)
      if (!guests.has(gkey(wsId, 'preview', BASE_TAB))) {
        for (const p of ['preview', 'agent-web'] as const) {
          tabsFor(wsId, p) // init the base tab record
          ensureTabGuest(wsId, p, BASE_TAB)
          // Fresh, or returning after LRU eviction: main may still hold an activeTab/tabsCache
          // pointing at a dropped extra tab (e.g. t2) whose guest is gone — the driver would
          // resolve `noview`. Re-sync main to the base tab we just (re)created.
          activeTabMap.set(wpk(wsId, p), BASE_TAB)
          publishTabs(wsId, p)
        }
      }
      while (lru.length > GUEST_CAP) {
        // Evict the oldest workspace that is NOT active and NOT agent-attached
        // (a browser an agent is working in is never torn down).
        const victim = lru.find((w) => w !== wsId && w !== activeWsId() && !pinnedWs.has(w))
        if (!victim) break
        lru.splice(lru.indexOf(victim), 1)
        evictWorkspace(victim)
      }
    }

    function applyGuestVisibility(): void {
      const active = open ? activeKey() : ''
      for (const [k, wv] of guests) wv.classList.toggle('is-active', k === active)
      applyZoom() // the active guest may have changed — carry its workspace's zoom
      refreshAudioChrome() // and its audio/mute state
      renderTabStrip()
    }

    // ── Tab lifecycle (F4) ──────────────────────────────────────────────────────
    /** Tell main the tab list + active id for a (workspace, profile) so the driver and
     *  browser_tab_* verbs stay in sync; also refreshes the strip. */
    function publishTabs(wsId: string, p: BrowserProfile): void {
      const tabs = tabsFor(wsId, p).map((t) => ({ id: t.id, url: t.url, title: t.title }))
      bridge.send(BrowserChannels.tabsState, { workspaceId: wsId, profile: p, tabs, activeId: activeTabId(wsId, p) })
      if (wsId === activeWsId() && p === activeProfile()) renderTabStrip()
    }
    function selectTab(wsId: string, p: BrowserProfile, tabId: string): void {
      if (!tabsFor(wsId, p).some((t) => t.id === tabId)) return
      activeTabMap.set(wpk(wsId, p), tabId)
      bridge.send(BrowserChannels.tabActivate, { workspaceId: wsId, profile: p, tabId })
      // Also publish the tab list: selecting an ALREADY-loaded tab fires no navigation, so
      // without this main's tabsCache.activeId never updates and the tab_select verb's
      // waitForTabs never sees the switch (burns its whole timeout, returns the old active tab).
      publishTabs(wsId, p)
      applyGuestVisibility()
      // The header follows the newly-active tab's url immediately.
      const t = tabsFor(wsId, p).find((x) => x.id === tabId)
      if (t && wsId === activeWsId() && p === activeProfile() && document.activeElement !== urlInput) {
        urlInput.value = t.url
        renderUrlLead()
      }
    }
    function newTab(wsId: string, p: BrowserProfile, url?: string): string {
      const id = newTabId()
      // The initial url rides `pending` and loads on the new guest's dom-ready — no race
      // with main's active-tab (which a navigate IPC would depend on).
      tabsFor(wsId, p).push({ id, url: '', title: '', favicon: '', pending: url })
      ensureTabGuest(wsId, p, id)
      selectTab(wsId, p, id)
      publishTabs(wsId, p)
      return id
    }
    function closeTab(wsId: string, p: BrowserProfile, tabId: string): void {
      const list = tabsFor(wsId, p)
      if (list.length <= 1 || tabId === BASE_TAB) return // never close the last / base tab
      const idx = list.findIndex((t) => t.id === tabId)
      if (idx < 0) return
      const k = gkey(wsId, p, tabId)
      const wv = guests.get(k)
      if (wv) {
        bridge.send(BrowserChannels.guestGone, { workspaceId: wsId, profile: p, tabId })
        wv.remove()
        guests.delete(k)
      }
      list.splice(idx, 1)
      if (activeTabId(wsId, p) === tabId) selectTab(wsId, p, list[Math.max(0, idx - 1)].id)
      publishTabs(wsId, p)
    }
    const hostOfUrl = (url: string): string => {
      try {
        return new URL(url).host
      } catch {
        return ''
      }
    }
    function renderTabStrip(): void {
      const wsId = activeWsId()
      const p = activeProfile()
      const tabs = wsId ? tabsFor(wsId, p) : []
      tabStrip.hidden = !(open && !!wsId)
      if (tabStrip.hidden) return
      clear(tabStrip)
      const activeId = activeTabId(wsId, p)
      for (const t of tabs) {
        const tabEl = el('button', { class: `browser-tab${t.id === activeId ? ' is-active' : ''}`, type: 'button' }) as HTMLButtonElement
        if (t.favicon) {
          const img = el('img', { class: 'browser-tab-favicon' }) as HTMLImageElement
          img.src = t.favicon
          img.alt = ''
          img.onerror = (): void => img.replaceWith(icon('globe', 12))
          tabEl.append(img)
        } else {
          tabEl.append(icon('globe', 12))
        }
        tabEl.append(el('span', { class: 'browser-tab-label', text: t.title || hostOfUrl(t.url) || 'New tab' }))
        tabEl.title = t.url || 'New tab'
        tabEl.onclick = (): void => selectTab(wsId, p, t.id)
        if (t.id !== BASE_TAB) {
          const x = el('span', { class: 'browser-tab-close', text: '×' })
          x.setAttribute('role', 'button')
          x.setAttribute('aria-label', 'Close tab')
          x.onclick = (e): void => {
            e.stopPropagation()
            closeTab(wsId, p, t.id)
          }
          tabEl.append(x)
        }
        tabStrip.append(tabEl)
      }
      const plus = IconButton({ icon: 'plus', label: 'New tab', title: 'New tab', onClick: () => newTab(wsId, p) })
      plus.classList.add('browser-tab-new')
      tabStrip.append(plus)
    }

    // Tab requests from MAIN (window.open / agent verbs).
    bridge.on(BrowserChannels.tabOpen, (payload) => {
      const q = payload as { workspaceId?: string; profile?: BrowserProfile; url?: string }
      if (!q.workspaceId || (q.profile !== 'preview' && q.profile !== 'agent-web')) return
      newTab(q.workspaceId, q.profile, q.url)
    })
    bridge.on(BrowserChannels.tabSelect, (payload) => {
      const q = payload as { workspaceId?: string; profile?: BrowserProfile; tabId?: string }
      if (!q.workspaceId || (q.profile !== 'preview' && q.profile !== 'agent-web') || !q.tabId) return
      selectTab(q.workspaceId, q.profile, q.tabId)
    })

    // A guest's <webview> methods (setZoomLevel, findInPage, stop, …) THROW if called
    // before its dom-ready — so the driveable handle is gated on readiness. Every
    // element-method caller goes through activeGuest(), so one gate makes them all safe.
    const readyGuests = new WeakSet<HTMLElement>()
    /** The active workspace's active-profile guest as a driveable <webview> — null until
     *  it is attached AND dom-ready. */
    const activeGuest = (): WebviewEl | null => {
      const g = guests.get(activeKey())
      return g && readyGuests.has(g) ? (g as WebviewEl) : null
    }

    // ── Per-workspace zoom (F6), persisted like the app's other view prefs ──────
    const zoomKey = (wsId: string): string => `browser.zoom.${wsId}`
    const readZoom = (wsId: string): number => {
      const v = Number(localStorage.getItem(zoomKey(wsId)))
      return Number.isFinite(v) ? Math.max(-3, Math.min(4, v)) : 0
    }
    function applyZoom(): void {
      const wsId = activeWsId()
      if (!wsId) return
      activeGuest()?.setZoomLevel(readZoom(wsId))
    }
    let zoomBadgeTimer: number | undefined
    function bumpZoom(delta: number | 'reset'): void {
      const wsId = activeWsId()
      if (!wsId || !activeGuest()) return
      const next = delta === 'reset' ? 0 : Math.max(-3, Math.min(4, readZoom(wsId) + delta))
      localStorage.setItem(zoomKey(wsId), String(next))
      applyZoom()
      // A transient badge, Chrome-style — the zoom % while you adjust, then it fades.
      zoomBadge.textContent = `${Math.round(100 * 1.2 ** next)}%`
      zoomBadge.hidden = false
      window.clearTimeout(zoomBadgeTimer)
      zoomBadgeTimer = window.setTimeout(() => (zoomBadge.hidden = true), 1400)
    }

    const isActiveGuest = (wv: HTMLElement): boolean => guests.get(activeKey()) === wv

    // ── Audio indicator + mute (F15) ───────────────────────────────────────────
    const playingGuests = new WeakSet<HTMLElement>()
    const mutedWs = new Set<string>() // workspaces the user muted this session
    function refreshAudioChrome(): void {
      const g = guests.get(activeKey())
      const playing = !!g && playingGuests.has(g)
      audioBtn.hidden = !(open && playing)
      const muted = mutedWs.has(activeWsId())
      audioBtn.replaceChildren(icon(muted ? 'x' : 'bell'))
      audioBtn.title = muted ? 'Unmute this page' : 'Mute this page'
      audioBtn.setAttribute('aria-label', muted ? 'Unmute tab audio' : 'Mute tab audio')
    }
    function toggleMute(): void {
      const wsId = activeWsId()
      const g = activeGuest()
      if (!wsId || !g) return
      const next = !mutedWs.has(wsId)
      if (next) mutedWs.add(wsId)
      else mutedWs.delete(wsId)
      g.setAudioMuted(next)
      refreshAudioChrome()
    }

    // ── Pins + recents (F14): the empty preview becomes a dev-loop new-tab page ──
    const readList = (key: string): string[] => {
      try {
        const v = JSON.parse(localStorage.getItem(key) ?? '[]')
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
      } catch {
        return []
      }
    }
    const pinsKey = (wsId: string): string => `browser.pins.${wsId}`
    const recentsKey = (wsId: string): string => `browser.recents.${wsId}`
    const isPinned = (wsId: string, url: string): boolean => readList(pinsKey(wsId)).includes(url)
    function togglePin(wsId: string, url: string): void {
      if (!wsId || !url) return
      const pins = readList(pinsKey(wsId))
      const next = pins.includes(url) ? pins.filter((u) => u !== url) : [url, ...pins].slice(0, 12)
      localStorage.setItem(pinsKey(wsId), JSON.stringify(next))
      renderQuickChips()
    }
    function noteVisit(wsId: string, url: string): void {
      if (!wsId || !/^https?:/i.test(url)) return
      const recents = [url, ...readList(recentsKey(wsId)).filter((u) => u !== url)].slice(0, 8)
      localStorage.setItem(recentsKey(wsId), JSON.stringify(recents))
    }
    function renderQuickChips(): void {
      clear(quickChips)
      const wsId = activeWsId()
      if (!wsId || state.profile === 'agent-web') return // preview's new-tab page only
      const pins = readList(pinsKey(wsId))
      const recents = readList(recentsKey(wsId)).filter((u) => !pins.includes(u))
      const entries: { url: string; pinned: boolean }[] = [
        ...pins.map((url) => ({ url, pinned: true })),
        ...recents.map((url) => ({ url, pinned: false }))
      ].slice(0, 8)
      for (const { url, pinned } of entries) {
        let host = url
        try {
          host = new URL(url).host
        } catch {
          continue
        }
        const chip = el('button', { class: 'browser-quick-chip', type: 'button' }) as HTMLButtonElement
        if (pinned) chip.append(icon('bookmark', 12))
        chip.append(el('span', { text: host }))
        chip.title = url
        chip.onclick = (): void => {
          const capture = captureWorkspace()
          void bridge.invoke(BrowserChannels.navigate, { url, workspaceId: capture.id })
        }
        quickChips.append(chip)
      }
    }

    // ── Blocked-permission chip (F16): honest, transient ────────────────────────
    const PERM_LABEL: Record<string, string> = {
      media: 'camera & microphone', geolocation: 'location', notifications: 'notifications',
      midi: 'MIDI', midiSysex: 'MIDI', pointerLock: 'pointer lock', fullscreen: 'fullscreen',
      'clipboard-read': 'clipboard', 'display-capture': 'screen share'
    }
    let permChipTimer: number | undefined
    bridge.on(BrowserChannels.permissionBlocked, (payload) => {
      const permission = String((payload as { permission?: string }).permission ?? '')
      if (!open) return
      permChip.textContent = `Blocked: ${PERM_LABEL[permission] ?? permission}`
      permChip.hidden = false
      window.clearTimeout(permChipTimer)
      permChipTimer = window.setTimeout(() => (permChip.hidden = true), 4000)
    })

    // ── Find in page (F5) ──────────────────────────────────────────────────────
    let findActiveQuery = ''
    function runFind(forward: boolean): void {
      const g = activeGuest()
      if (!g) return
      const q = findInput.value
      if (!q) {
        g.stopFindInPage('clearSelection')
        findCount.textContent = ''
        findActiveQuery = ''
        return
      }
      const findNext = q === findActiveQuery // same query → step; new query → fresh search
      findActiveQuery = q
      g.findInPage(q, { forward, findNext })
    }
    function openFind(): void {
      if (!activeGuest()) return
      findBar.hidden = false
      findInput.focus()
      findInput.select()
    }
    function closeFind(): void {
      findBar.hidden = true
      findActiveQuery = ''
      findCount.textContent = ''
      activeGuest()?.stopFindInPage('clearSelection')
    }
    findInput.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        runFind(!e.shiftKey)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closeFind()
      }
    })
    findInput.addEventListener('input', () => runFind(true))

    // ── Reload ⇄ Stop (F13) ────────────────────────────────────────────────────
    function setLoadingChrome(loading: boolean): void {
      reload.replaceChildren(icon(loading ? 'square' : 'rotate-cw'))
      reload.title = loading ? 'Stop loading' : 'Reload'
      reload.setAttribute('aria-label', loading ? 'Stop loading' : 'Reload')
    }

    // ── The address bar's leading indicator (F13): favicon / lock / not-secure ──
    const wsFavicon = new Map<string, string>() // active-guest favicon per workspace
    function renderUrlLead(): void {
      clear(urlLead)
      urlLead.className = 'browser-url-lead'
      urlLead.removeAttribute('title')
      const u = state.url
      if (!u) {
        urlLead.append(icon('search', 14))
        return
      }
      if (/^https:/i.test(u)) {
        urlLead.classList.add('is-secure')
        // The ACTIVE tab's favicon (per tab, F4) — falling back to the workspace's last-seen
        // one — so switching to an already-loaded tab shows ITS icon, not the previous tab's.
        const wsId = activeWsId()
        const activeT = tabsFor(wsId, activeProfile()).find((t) => t.id === activeTabId(wsId, activeProfile()))
        const fav = activeT?.favicon || wsFavicon.get(wsId)
        if (fav) {
          const img = el('img', { class: 'browser-favicon' }) as HTMLImageElement
          img.src = fav
          img.alt = ''
          img.onerror = (): void => img.replaceWith(icon('lock', 14)) // a dead favicon falls back to the lock
          urlLead.append(img)
        } else {
          urlLead.append(icon('lock', 14))
        }
      } else if (/^http:/i.test(u)) {
        urlLead.classList.add('is-insecure')
        urlLead.title = 'Not secure — this connection is not encrypted'
        urlLead.append(icon('alert', 14))
      } else {
        urlLead.append(icon('search', 14))
      }
    }

    // ── Load-error / crash overlay (F10) ───────────────────────────────────────
    function showLoadError(code: number, desc: string): void {
      errorTitle.textContent = 'This site can’t be reached'
      errorDesc.textContent = `${desc || 'The page could not be loaded'}${code ? ` (${code})` : ''}`
      empty.hidden = true
      loadError.hidden = false
    }
    function showCrash(): void {
      errorTitle.textContent = 'This page crashed'
      errorDesc.textContent = 'The page stopped responding. Reload to try again.'
      empty.hidden = true
      loadError.hidden = false
    }

    // Recreate one guest on request (smoke persistence arm) — the partition
    // session outlives the element, so its cookies survive the recreation.
    bridge.on(BrowserChannels.recreateGuest, (payload) => {
      const { workspaceId, profile: p } = payload as { workspaceId?: string; profile?: BrowserProfile }
      if (!workspaceId || !p) return
      const k = gkey(workspaceId, p, BASE_TAB) // the persistence arm recreates the base tab
      if (!guests.has(k)) return
      bridge.send(BrowserChannels.guestGone, { workspaceId, profile: p, tabId: BASE_TAB })
      guests.get(k)?.remove()
      const wv = makeGuest(workspaceId, p, BASE_TAB)
      guests.set(k, wv)
      viewHost.append(wv)
      applyGuestVisibility()
    })

    // ── Guest context menu (F7): main forwards the right-click; we draw the house menu ──
    bridge.on(BrowserChannels.contextMenu, (payload) => {
      const p = payload as BrowserContextMenuParams
      if (p.workspaceId !== activeWsId()) return
      const rect = viewHost.getBoundingClientRect()
      const x = rect.left + p.x
      const y = rect.top + p.y
      const items = []
      if (p.linkURL) {
        items.push(
          { label: 'Open link in system browser', icon: 'globe' as const, onSelect: () => void bridge.invoke(BrowserChannels.openExternal, { url: p.linkURL }) },
          { label: 'Copy link address', icon: 'copy' as const, onSelect: () => void bridge.invoke(ClipboardChannels.write, { text: p.linkURL }) },
          { separator: true as const }
        )
      }
      if (p.selectionText) {
        items.push(
          { label: 'Copy', icon: 'copy' as const, onSelect: () => void bridge.invoke(ClipboardChannels.write, { text: p.selectionText }) },
          { separator: true as const }
        )
      }
      const pageUrl = state.url
      const pinned = !!pageUrl && isPinned(activeWsId(), pageUrl)
      items.push(
        { label: 'Back', icon: 'chevron-left' as const, disabled: !state.canGoBack, onSelect: () => nav('back') },
        { label: 'Forward', icon: 'chevron-right' as const, disabled: !state.canGoForward, onSelect: () => nav('forward') },
        { label: 'Reload', icon: 'rotate-cw' as const, onSelect: () => nav('reload') },
        { separator: true as const },
        { label: 'Find in page…', icon: 'search' as const, hint: 'Ctrl+F', onSelect: () => openFind() },
        { label: pinned ? 'Unpin this page' : 'Pin this page', icon: 'bookmark' as const, disabled: !pageUrl || state.profile === 'agent-web', onSelect: () => togglePin(activeWsId(), pageUrl) },
        { label: 'Open in system browser', icon: 'external-link' as const, disabled: !state.url, onSelect: () => { if (state.url) void bridge.invoke(BrowserChannels.openExternal, { url: state.url }) } },
        { label: 'Inspect element', icon: 'terminal' as const, onSelect: () => void bridge.invoke(BrowserChannels.devtools, { x: p.x, y: p.y }) }
      )
      openContextMenu({ items, x, y, ariaLabel: 'Page actions' })
    })

    // ── App-shortcut relay (F12): a chord pressed while the guest held focus ──
    bridge.on(BrowserChannels.guestChord, (payload) => {
      const c = payload as BrowserGuestChord
      if (c.workspaceId !== activeWsId()) return
      const synthetic = { key: c.key, code: c.code, ctrlKey: c.ctrl, metaKey: c.meta, shiftKey: c.shift, altKey: c.alt }
      // The dock's own shortcuts first (find/zoom/address); then the global toggle.
      if (handleDockShortcut(synthetic)) return
      if ((c.ctrl || c.meta) && c.shift && c.code === 'KeyU') toggle(!open)
      // Rail (Ctrl+Shift+B) / explorer (Ctrl+Shift+E) / palette (Ctrl+K) live in other
      // features; re-dispatch a trusted-shaped event so their document listeners run.
      else document.dispatchEvent(new KeyboardEvent('keydown', synthetic))
    })

    // Auto-switch: when the active workspace changes with the dock open, show
    // that workspace's own browser (creating it on first visit).
    onWorkspacesChange(() => {
      workspaceGeneration++
      const workspaceId = activeWsId()
      // Workspace-scoped async surfaces must go blank at the switch boundary;
      // generation checks stop late writes, while this prevents already-rendered
      // controls from the previous workspace remaining actionable meanwhile.
      sitesMenu.hidden = true
      sitesMenu.replaceChildren()
      wsChip.hidden = true
      wsChip.onclick = null
      recentActs.hidden = true
      recentActs.replaceChildren()
      // A load error / find bar belong to the page you were on — reset them on a switch.
      loadError.hidden = true
      closeFind()
      // The LAST workspace closing is a workspace change too (finding 33): the dock stays
      // open over the home screen, so its controls must go back to disabled-and-explained
      // here, not wait for main's reply.
      applyWorkspaceGating()
      void bridge.invoke(BrowserChannels.activate, { workspaceId })
      if (open) {
        ensureGuests(workspaceId)
        applyGuestVisibility()
      }
      applyTabPossession() // tabs rebuilt on switch — re-mark agent-browsing ones
    })

    // An agent may drive a workspace the human never opened — main asks us to
    // materialize it (pinned; possession follows). Create even if the dock is
    // closed so the agent can work headless (its tab shows possession).
    bridge.on(BrowserChannels.materialize, (payload) => {
      const wsId = (payload as { workspaceId?: string }).workspaceId
      if (wsId) ensureGuests(wsId)
    })

    // Visible possession across workspaces (8/07c): pin agent-attached
    // workspaces from eviction and mark their tabs.
    let attachedWs: string[] = []
    let drivingWs: string[] = []
    let possessionDrivers: Record<string, string> = {} // wsId -> driving pane (goal 6)
    const globalPossession = el('div', {
      class: 'browser-global-possession',
      role: 'status',
      hidden: true,
      attrs: { 'aria-live': 'polite' }
    })
    const globalPossessionLabel = el('span', { text: 'Agent driving browser' })
    const globalStop = el('button', { class: 'browser-global-stop', type: 'button', text: 'Stop' }) as HTMLButtonElement
    globalStop.onclick = (): void => {
      const workspaceId = drivingWs[0]
      if (workspaceId) bridge.send(BrowserChannels.agentStop, { workspaceId })
    }
    globalPossession.append(icon('sparkles', 12), globalPossessionLabel, globalStop)
    document.querySelector('.titlebar-right')?.prepend(globalPossession)
    function applyTabPossession(): void {
      document.querySelectorAll<HTMLElement>('.workspace-tab').forEach((tab) => {
        const id = tab.dataset.wsId ?? ''
        const browsing = attachedWs.includes(id)
        const driving = drivingWs.includes(id)
        tab.classList.toggle('is-agent-browsing', browsing)
        tab.classList.toggle('is-agent-driving', driving)
        // Name the driver on the tab (goal 6): hovering the possession dot says who.
        if (browsing || driving) tab.title = `${agentNameFor(possessionDrivers[id])} is ${driving ? 'browsing' : 'using the browser'}`
        else if (tab.title.includes('the browser') || tab.title.includes('is browsing')) tab.removeAttribute('title')
      })
    }
    bridge.on(BrowserChannels.possession, (payload) => {
      const p = payload as BrowserPossession
      attachedWs = p.attached ?? []
      drivingWs = p.driving ?? []
      possessionDrivers = p.drivers ?? {}
      globalPossession.hidden = drivingWs.length === 0
      // Name the driver in the titlebar pill (goal 6), or a count when several drive.
      globalPossessionLabel.textContent =
        drivingWs.length > 1
          ? `${drivingWs.length} agents driving browsers`
          : `${agentNameFor(possessionDrivers[drivingWs[0] ?? ''])} is browsing`
      pinnedWs.clear()
      for (const w of attachedWs) pinnedWs.add(w)
      applyTabPossession()
    })

    // ── Width drag (pure DOM now — the webview resizes with the chrome) ──────
    let widthPersistTimer: number | undefined
    const applyWidth = (persist = true): void => {
      const budget = dockLayoutBudget()
      width = Math.max(budget.browserMin, Math.min(budget.browserMax, Math.round(width)))
      dock.style.width = `${width}px`
      handle.setAttribute('aria-valuemin', String(budget.browserMin))
      handle.setAttribute('aria-valuemax', String(Math.round(budget.browserMax)))
      handle.setAttribute('aria-valuenow', String(width))
      if (!persist) return
      window.clearTimeout(widthPersistTimer)
      widthPersistTimer = window.setTimeout(() => bridge.send(BrowserChannels.persistWidth, { dockWidth: width }), 400)
    }
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      handle.setPointerCapture(e.pointerId)
      const startX = e.clientX
      const startW = width
      const move = (ev: PointerEvent): void => {
        width = startW + (startX - ev.clientX)
        applyWidth()
      }
      const up = (): void => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    })
    handle.addEventListener('keydown', (e) => {
      const budget = dockLayoutBudget()
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      if (e.key === 'ArrowLeft') width += e.shiftKey ? 64 : 16
      else if (e.key === 'ArrowRight') width -= e.shiftKey ? 64 : 16
      else if (e.key === 'Home') width = budget.browserMin
      else width = budget.browserMax
      applyWidth()
    })
    onDockLayoutChange(() => applyWidth(false))

    // ── Toggle ───────────────────────────────────────────────────────────────
    const toggleBtn = IconButton({
      icon: 'globe',
      label: 'Browser',
      title: 'Browser (Ctrl+Shift+U)',
      onClick: () => toggle(!open)
    })
    ctx.titlebarRight.append(toggleBtn)

    function toggle(next: boolean): void {
      open = next
      dock.hidden = !open
      requestDockLayout()
      toggleBtn.classList.toggle('is-active', open)
      // Honest the instant it opens: main's state push is an IPC round-trip away, and the
      // globe is reachable from the zero-workspace home screen.
      applyWorkspaceGating()
      if (open) ensureGuests(activeWsId()) // spawn the active workspace's guests on first use
      void bridge.invoke(BrowserChannels.toggle, { open, workspaceId: getWorkspaces().activeId ?? undefined })
      applyGuestVisibility()
      if (open && !urlInput.disabled) urlInput.focus() // never park the caret in a dead field
      getTelemetry().captureEvent({ name: 'browser.dock', props: { open } }) // boolean only — never URLs (ADR 0005)
    }

    document.addEventListener('keydown', (e) => {
      // Finding 28: this read `e.ctrlKey` alone, so the dock's ONE shortcut was dead on
      // every Mac. isModKey is the single correct way to ask (Ctrl or ⌘).
      if (!isModKey(e) || !e.shiftKey || e.altKey || e.code !== 'KeyU') return
      // Finding 29: a raw global listener owes the user this question BEFORE it acts.
      // The app's shortcuts are CAPTURE-phase, so the stopPropagation() calls sprinkled
      // through its text fields never blocked them — nothing had begun to bubble yet.
      // Sliding a dock out from under an open modal, or eating a keystroke mid-sentence,
      // is not a shortcut; it is a surprise.
      if (shortcutsBlocked(e.target)) return
      e.preventDefault()
      toggle(!open)
    })
    // Find + zoom, active when the dock is open and its OWN chrome holds focus (the
    // in-page-focus case is relayed from main — see the guest-chord handler). Ctrl+F,
    // Ctrl+= / Ctrl+- / Ctrl+0. Ctrl+L focuses the address bar (F13 / U-item).
    function handleDockShortcut(e: { key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault?: () => void }): boolean {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || e.altKey || !open) return false
      if (e.code === 'KeyF' && !e.shiftKey) { openFind(); return true }
      if (e.code === 'KeyL' && !e.shiftKey) { urlInput.focus(); return true }
      if (e.shiftKey) return false
      if (e.code === 'Equal' || e.key === '+' || e.key === '=') { bumpZoom(1); return true }
      if (e.code === 'Minus' || e.key === '-') { bumpZoom(-1); return true }
      if (e.code === 'Digit0' || e.key === '0') { bumpZoom('reset'); return true }
      return false
    }
    document.addEventListener('keydown', (e) => {
      // Only when focus is already inside the dock chrome — otherwise a page-focused
      // shortcut arrives via main's relay, and an app-wide Ctrl+F elsewhere is not ours.
      if (!dock.contains(e.target as Node)) return
      if (handleDockShortcut(e)) e.preventDefault()
    })
    setCommands('browser', [
      { id: 'browser.toggle', title: 'Toggle browser dock', hint: 'Browser', kbd: 'Ctrl+Shift+U', run: () => toggle(!open) }
    ])

    // ── Navigation ───────────────────────────────────────────────────────────
    // Both of these were `void invoke(...)` with no catch: a rejected IPC was an unhandled
    // promise, and a REFUSED url (ok === false) was indistinguishable from a successful one —
    // in both cases the dock simply sat there looking like it had done what you asked
    // (finding 39). A navigation that does not happen has to say so.
    const NAV_LABEL: Record<BrowserNavAction, string> = {
      back: 'go back',
      forward: 'go forward',
      reload: 'reload the page'
    }
    const navGuard = createAsyncGuard<void>()
    const urlGuard = createAsyncGuard<boolean>()

    function nav(action: BrowserNavAction): void {
      const workspaceId = activeWsId()
      if (!workspaceId) return
      void navGuard.run(
        () => bridge.invoke(BrowserChannels.nav, { action, workspaceId }) as Promise<void>,
        { action: NAV_LABEL[action] }
      )
    }
    urlInput.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        // Abandon the edit — restore the live url and hand focus back to the page.
        urlInput.value = state.url
        urlInput.blur()
        return
      }
      if (e.key !== 'Enter') return
      const raw = urlInput.value.trim()
      if (!raw) return
      const capture = captureWorkspace()
      if (!capture.id) return
      // The omnibox rule (F3): a URL opens; anything else is a search. Comet/Chrome
      // behavior — the address bar never "refuses" a query, it runs it.
      const resolved = resolveAddressInput(raw)
      if (!resolved) return
      const target = resolved.kind === 'url' ? resolved.url : searchUrlFor(searchTemplate, resolved.query)
      urlInput.blur() // committing hands focus to the page, like a real browser
      void urlGuard.run(
        () => bridge.invoke(BrowserChannels.navigate, { url: target, workspaceId: capture.id }) as Promise<boolean>,
        {
          action: resolved.kind === 'url' ? `open ${raw}` : `search ${raw}`,
          onSuccess: (ok) => {
            if (!workspaceStillCurrent(capture)) return
            if (ok) empty.hidden = true
            // A resolved URL that main still refuses is a blocked/sensitive host — the
            // one case left that deserves a sentence (a query can't land here).
            else showToast({ tone: 'danger', title: 'That address was refused', body: target })
          }
        }
      )
    })
    // Focus selects all (a real address bar) so the next keystroke replaces the url.
    urlInput.addEventListener('focus', () => urlInput.select())

    // ── Profile switch + agent-web chrome (8/04) ─────────────────────────────
    async function setProfile(p: BrowserProfile): Promise<void> {
      const capture = captureWorkspace()
      if (!capture.id) return
      await bridge.invoke(BrowserChannels.profileSet, { workspaceId: capture.id, profile: p })
      if (!workspaceStillCurrent(capture)) return
      wsProfile.set(capture.id, p)
      applyGuestVisibility() // don't wait for the state push to lift the chosen guest
      getTelemetry().captureEvent({ name: 'browser.profile', props: { agentWeb: p === 'agent-web' } }) // boolean only (ADR 0005)
    }
    function renderProfileChrome(): void {
      const agentWeb = state.profile === 'agent-web'
      profilePreviewBtn.classList.toggle('is-active', !agentWeb)
      profileAgentBtn.classList.toggle('is-active', agentWeb)
      agentWebNote.hidden = !agentWeb
      noteText.textContent = state.agentWebPersists
        ? 'Signed-in browser — sessions persist on this machine; agents act only on origins you grant.'
        : 'No at-rest encryption on this machine — logins here last until the dock closes.'
      agentWebNote.classList.toggle('no-vault', !state.agentWebPersists)
      if (!agentWeb) sitesMenu.hidden = true
    }

    /** The empty state's words, profile-aware — and workspace-aware, which is the whole
     *  point: with no workspace there is no URL to enter, so it must not say to enter one. */
    function renderEmptyCopy(hasWorkspace: boolean): void {
      if (!hasWorkspace) {
        emptyTitle.textContent = 'No workspace open'
        emptyHint.textContent =
          'The browser is per-workspace — its own page, its own logins. Create or open a workspace to preview its dev server here.'
        return
      }
      const agentWeb = state.profile === 'agent-web'
      emptyTitle.textContent = agentWeb ? 'The agents’ signed-in browser' : 'Preview what the agents build'
      emptyHint.textContent = agentWeb
        ? 'Sign in here on purpose. Sessions stay in this profile — never your system browser.'
        : 'Enter a URL above — your dev server, docs, anything http(s).'
    }

    /**
     * The zero-workspace dock (finding 33). The titlebar globe renders in EVERY view —
     * including the zero-workspace home screen — but a browser has nowhere to live here:
     * every concept in the dock is keyed BY workspace (browser-dock.ts: guestKey,
     * kvLastUrl, kvProfile, kvConsent) and ensureGuests() has always refused to create a
     * guest without one. What shipped was the entire chrome — URL bar, back/forward/reload,
     * profile switch — rendered live and silently inert: typing a URL and pressing Enter
     * fell out at `if (!capture.id)` and did NOTHING, with an empty state cheerfully
     * saying "Enter a URL above". A control that cannot act must not look like it can.
     * (A real workspace-less guest was the other option, and it would have meant inventing
     * where an orphan session's state goes when the first workspace appears. It doesn't.)
     */
    function applyWorkspaceGating(): void {
      // Re-derived from the renderer's OWN truth, not from the last state push: with zero
      // workspaces main pushes nothing until the dock is toggled, so a gate that only ran
      // in the state handler would render one dishonest frame on the way in. Inside that
      // handler the two agree by construction — it drops any push whose workspaceId isn't
      // the active one, so `state.workspaceId === activeWsId()` there by the time we run.
      const hasWorkspace = !!activeWsId()
      dock.classList.toggle('is-no-workspace', !hasWorkspace)
      urlInput.disabled = !hasWorkspace
      // The nav verbs stay bound to their own truth when a workspace IS open — a workspace
      // does not make Back possible, history does.
      back.disabled = !hasWorkspace || !state.canGoBack
      forward.disabled = !hasWorkspace || !state.canGoForward
      reload.disabled = !hasWorkspace
      external.disabled = !hasWorkspace || !state.url // it opens state.url; with none it was a live-looking no-op
      profilePreviewBtn.disabled = !hasWorkspace
      profileAgentBtn.disabled = !hasWorkspace
      // Nothing can be loaded without a workspace, so the explanation is always on screen.
      empty.hidden = hasWorkspace && state.url !== ''
      renderEmptyCopy(hasWorkspace)
      if (!empty.hidden) renderQuickChips() // the empty preview is a dev-loop new-tab page (F14)
      // Close (and the resize handle) stay live: you must always be able to shut a dock.
    }
    // Follow the ACTIVE workspace's stored profile (per-workspace persisted).
    async function applyWorkspaceProfile(): Promise<void> {
      const capture = captureWorkspace()
      if (!capture.id) return
      const stored = (await bridge.invoke(BrowserChannels.profileGet, capture.id)) as BrowserProfile
      if (!workspaceStillCurrent(capture)) return
      wsProfile.set(capture.id, stored)
      applyGuestVisibility() // the cache just learned this workspace's real profile
      if (stored !== state.profile) {
        await bridge.invoke(BrowserChannels.profileSet, { workspaceId: capture.id, profile: stored })
      }
    }
    onWorkspacesChange(() => void applyWorkspaceProfile())

    async function refreshSitesMenu(): Promise<void> {
      const capture = captureWorkspace()
      const wsId = capture.id
      clear(sitesMenu)
      sitesMenu.append(el('div', { class: 'menu-note browser-sites-head', text: 'Signed-in sites (agent web profile)' }))
      if (!wsId) {
        sitesMenu.append(el('div', { class: 'menu-note', text: 'No active workspace.' }))
        return
      }
      const sites = (await bridge.invoke(BrowserChannels.signedInSites, wsId)) as BrowserSignedInSite[]
      if (!workspaceStillCurrent(capture)) return
      if (!sites.length) sitesMenu.append(el('div', { class: 'menu-note', text: 'No sign-ins yet — log into a site in this profile.' }))
      for (const s of sites) {
        const forget = el('button', { class: 'browser-sites-forget', type: 'button', text: 'Forget' }) as HTMLButtonElement
        forget.onclick = async (): Promise<void> => {
          const ok = await confirmDialog({
            title: `Forget ${s.host}?`,
            message: 'Its saved login for the agent web profile is erased — the agent will need to sign in again.',
            confirmLabel: 'Forget site',
            danger: true
          })
          if (!ok || !workspaceStillCurrent(capture)) return
          await bridge.invoke(BrowserChannels.forgetSite, { workspaceId: wsId, host: s.host })
          if (!workspaceStillCurrent(capture)) return
          void refreshSitesMenu()
        }
        sitesMenu.append(
          el('div', { class: 'browser-sites-row' }, [
            el('span', { class: 'browser-sites-host', text: s.host }),
            el('span', { class: 'browser-sites-count', text: `${s.cookies} cookie${s.cookies === 1 ? '' : 's'}` }),
            forget
          ])
        )
      }
      if (sites.length) {
        const clearAll = el('button', { class: 'browser-sites-clear', type: 'button', text: 'Clear all agent logins' }) as HTMLButtonElement
        clearAll.onclick = async (): Promise<void> => {
          const ok = await confirmDialog({
            title: 'Clear all agent logins?',
            message: 'Every saved sign-in in the agent web profile is erased. This can’t be undone.',
            confirmLabel: 'Clear all',
            danger: true
          })
          if (!ok || !workspaceStillCurrent(capture)) return
          await bridge.invoke(BrowserChannels.clearAgentLogins, wsId)
          if (!workspaceStillCurrent(capture)) return
          void refreshSitesMenu()
        }
        sitesMenu.append(clearAll)
      }
      // The minimal act-origin grant editor (Settings § Browser is the full
      // home). Origins agents may ACT on, for the ACTIVE workspace.
      sitesMenu.append(el('div', { class: 'menu-note browser-sites-head', text: 'Origins agents may act on (this workspace)' }))
      const grant = (await bridge.invoke(IntegrationsChannels.grantGet, wsId)) as WorkspaceIntegrationsGrant
      if (!workspaceStillCurrent(capture)) return
      for (const origin of grant.actOrigins) {
        const drop = el('button', { class: 'browser-sites-forget', type: 'button', text: 'Revoke' }) as HTMLButtonElement
        drop.onclick = async (): Promise<void> => {
          if (!workspaceStillCurrent(capture)) return
          drop.disabled = true
          try {
            await bridge.invoke(IntegrationsChannels.grantMutate, {
              workspaceId: wsId,
              field: 'origin',
              op: 'remove',
              origin
            })
            if (workspaceStillCurrent(capture)) void refreshSitesMenu()
          } catch (error) {
            showToast({ tone: 'danger', title: 'Origin was not revoked', body: String(error) })
          } finally {
            if (drop.isConnected) drop.disabled = false
          }
        }
        sitesMenu.append(
          el('div', { class: 'browser-sites-row' }, [el('span', { class: 'browser-sites-host', text: origin }), drop])
        )
      }
      if (!grant.actOrigins.length) {
        sitesMenu.append(el('div', { class: 'menu-note', text: 'None granted — reads always work; acts refuse.' }))
      }
      const addInput = el('input', { class: 'browser-sites-input' }) as HTMLInputElement
      addInput.placeholder = 'github.com'
      addInput.setAttribute('aria-label', 'Origin to grant')
      addInput.spellcheck = false
      addInput.addEventListener('keydown', (e) => e.stopPropagation())
      const addNote = el('div', { class: 'menu-note browser-sites-refused', hidden: true })
      const addBtn = el('button', { class: 'browser-sites-add', type: 'button', text: 'Grant origin' }) as HTMLButtonElement
      addBtn.onclick = async (): Promise<void> => {
        if (!workspaceStillCurrent(capture)) return
        const raw = addInput.value.trim()
        if (!raw) return
        addBtn.disabled = true
        try {
          const saved = (await bridge.invoke(IntegrationsChannels.grantMutate, {
            workspaceId: wsId,
            field: 'origin',
            op: 'add',
            origin: raw
          })) as WorkspaceIntegrationsGrant | null
          if (!workspaceStillCurrent(capture)) return
          const normalized = normalizeBrowserOrigin(raw)
          if (!saved || !normalized || !saved.actOrigins.includes(normalized)) {
            addNote.textContent = `“${raw}” was refused — sensitive or invalid origins never accept act grants.`
            addNote.hidden = false
            return
          }
          void refreshSitesMenu()
        } catch (error) {
          showToast({ tone: 'danger', title: 'Origin was not granted', body: String(error) })
        } finally {
          if (addBtn.isConnected) addBtn.disabled = false
        }
      }
      sitesMenu.append(el('div', { class: 'browser-sites-addrow' }, [addInput, addBtn]), addNote)
    }

    // ── State from main (header truth) ───────────────────────────────────────
    bridge.on(BrowserChannels.state, (payload) => {
      const next = payload as BrowserDockState
      if (next.workspaceId !== activeWsId()) return
      state = next
      if (state.workspaceId) wsProfile.set(state.workspaceId, state.profile) // keeps activeKey honest across switches
      agentWebPersists = state.agentWebPersists // machine-global; keeps new-guest partitions truthful
      if (document.activeElement !== urlInput) urlInput.value = state.url
      loading.classList.toggle('is-loading', state.loading)
      setLoadingChrome(state.loading) // Reload ⇄ Stop
      renderUrlLead() // favicon / lock / not-secure for the new url
      if (!state.loading && state.url) noteVisit(state.workspaceId, state.url) // F14 recents
      renderProfileChrome()
      // Owns the nav/url/profile enablement and the empty overlay (which covers a guest
      // sitting at about:blank) — one writer, so a workspace-less dock can't be re-enabled
      // from under it by a stale push.
      applyWorkspaceGating()
      applyGuestVisibility() // the profile may have flipped (active guest on top)
      void refreshChip()
    })

    // ── The per-workspace preview chip (switching never navigates) ──────────
    async function refreshChip(): Promise<void> {
      const capture = captureWorkspace()
      const wsId = capture.id
      // A PREVIEW affordance only: in agent-web, main routes navigation to the STORED
      // profile's guest, so this chip would load the preview url into the SIGNED-IN
      // browser while claiming to "open the preview" (finding B4).
      if (!wsId || !open || state.profile === 'agent-web') {
        wsChip.hidden = true
        return
      }
      const last = (await bridge.invoke(BrowserChannels.lastUrl, wsId)) as string | null
      if (!workspaceStillCurrent(capture)) return
      let host: string | null = null
      if (last && last !== state.url) {
        try {
          host = new URL(last).host
        } catch {
          host = null // a corrupt stored url must not kill the chip pipeline (finding B7)
        }
      }
      wsChip.hidden = !host
      if (host && last) {
        wsChip.textContent = `Open this workspace's preview — ${host}`
        wsChip.onclick = (): void => {
          if (!workspaceStillCurrent(capture)) return
          void bridge.invoke(BrowserChannels.navigate, { url: last, workspaceId: wsId })
          wsChip.hidden = true
        }
      }
    }
    onWorkspacesChange(() => void refreshChip())

    // ── Agent control: consent follows the active workspace (default OFF).
    //    8/04: the workspace id rides along so act-origin grants resolve. ────
    async function pushConsent(): Promise<void> {
      const capture = captureWorkspace()
      const allowed = !!capture.id && (await bridge.invoke(BrowserChannels.consentGet, capture.id)) === true
      if (!workspaceStillCurrent(capture)) return
      bridge.send(BrowserChannels.consent, { allowed, workspaceId: capture.id || undefined })
    }
    onWorkspacesChange(() => void pushConsent())

    // Possession state from main: brand the dock, show Stop, list the trail.
    const VERB_LABEL: Record<string, string> = {
      navigate: 'Navigated', back: 'Back', forward: 'Forward', reload: 'Reloaded',
      snapshot: 'Read page', screenshot: 'Screenshot', click: 'Clicked', type: 'Typed',
      scroll: 'Scrolled', select: 'Selected', eval: 'Ran script', console: 'Read console',
      network_failures: 'Read failures', wait_for: 'Waited for',
      tab_list: 'Listed tabs', tab_new: 'Opened a tab', tab_select: 'Switched tab'
    }
    // Present-continuous for the LIVE action line (Comet reads "…is working"): the pill
    // says what the agent is doing right now, the trail keeps the past-tense history.
    const VERB_ACTIVE: Record<string, string> = {
      navigate: 'Navigating…', back: 'Going back…', forward: 'Going forward…', reload: 'Reloading…',
      snapshot: 'Reading the page…', screenshot: 'Capturing…', click: 'Clicking…', type: 'Typing…',
      scroll: 'Scrolling…', select: 'Selecting…', eval: 'Running a script…', console: 'Reading the console…',
      network_failures: 'Checking errors…', wait_for: 'Waiting…',
      tab_list: 'Listing tabs…', tab_new: 'Opening a tab…', tab_select: 'Switching tabs…'
    }
    bridge.on(BrowserChannels.activity, (payload) => {
      const a = payload as BrowserAgentActivity
      if (a.workspaceId !== activeWsId()) return
      activityWorkspaceId = a.workspaceId
      banner.hidden = !a.driving
      dock.classList.toggle('agent-driving', a.driving)
      // WHO + WHAT (goals 5/6): the driving agent's name and its live action.
      if (a.driving) {
        agentName.textContent = agentNameFor(a.pane)
        agentAction.textContent = a.lastVerb ? (VERB_ACTIVE[a.lastVerb] ?? '') : ''
      }
      // 8/04: the session-scoped confirm rides the activity push.
      pendingOrigin = a.pendingConfirm ?? ''
      confirmBar.hidden = !pendingOrigin
      if (pendingOrigin) confirmBtn.textContent = `Allow acting on ${pendingOrigin} this session`
      refreshRecentActs() // debounced; agent verbs are exactly when the trail moves
      clear(trailMenu)
      for (const t of [...a.trail].reverse()) {
        const row = el('div', { class: 'menu-note browser-trail-row' })
        // Verb + target REF only — never page content, typed text, or eval bodies.
        row.textContent = t.target ? `${VERB_LABEL[t.verb] ?? t.verb} · ${t.target}` : (VERB_LABEL[t.verb] ?? t.verb)
        trailMenu.append(row)
      }
      if (!a.trail.length) trailMenu.append(el('div', { class: 'menu-note', text: 'No agent actions yet.' }))
    })

    // ── Persisted boot state + guest creation ────────────────────────────────
    void (bridge.invoke(BrowserChannels.init, undefined) as Promise<BrowserDockInit>).then((init) => {
      width = init.width
      applyWidth()
      agentWebPersists = init.agentWebPersists // per-workspace partitions derive from this
      if (init.searchTemplate) searchTemplate = init.searchTemplate
      if (init.open) toggle(true)
      void pushConsent() // make the active workspace's stored grant live at boot
      void applyWorkspaceProfile() // and its stored profile (8/04)
    })

    document.addEventListener('click', (e) => {
      if (!(e.target instanceof Node) || (!trailMenu.contains(e.target) && !banner.contains(e.target))) trailMenu.hidden = true
      if (e.target instanceof Node && !sitesMenu.contains(e.target) && !agentWebNote.contains(e.target)) sitesMenu.hidden = true
    })
    // Escape closes the dock's own menus (U-item: they closed only on outside-click).
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      if (!trailMenu.hidden || !sitesMenu.hidden) {
        trailMenu.hidden = true
        sitesMenu.hidden = true
      }
    })

    // Paint the gate once at mount, hidden dock and all: the chrome should never EXIST in
    // the live-looking/dead-underneath state, not even for the frame before it is shown.
    applyWorkspaceGating()

    exposeForDev()
    function exposeForDev(): void {
      if (!import.meta.env.DEV) return
      const w = window as unknown as { __mogging?: Record<string, unknown> }
      w.__mogging = w.__mogging ?? {}
      w.__mogging.browser = {
        toggle: (next: boolean) => toggle(next),
        navigate: (url: string) =>
          bridge.invoke(BrowserChannels.navigate, { url, workspaceId: getWorkspaces().activeId ?? undefined }),
        isOpen: () => open,
        width: () => width,
        setWidth: (px: number) => {
          width = px
          applyWidth()
        },
        viewRect: () => {
          const r = viewHost.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        },
        state: () => ({ ...state }),
        // 6/05b: agent-control surface for the smoke — write per-workspace
        // consent, make it live, and read the possession banner's live state.
        // Returns whether main actually SAVED it (33b) — a consent that was dropped is
        // never made live, here or in Settings.
        setConsent: async (allowed: boolean): Promise<boolean> => {
          const wsId = getWorkspaces().activeId
          if (!wsId) return false
          const saved = (await bridge.invoke(BrowserChannels.consentSet, { workspaceId: wsId, allowed })) as
            | { ok?: boolean }
            | undefined
          if (!saved?.ok) return false
          await pushConsent()
          return true
        },
        driving: () => !banner.hidden,
        trailCount: () => trailMenu.querySelectorAll('.browser-trail-row').length,
        // Comet possession surface (goals 5/6): who is driving + the live action.
        agentBannerName: () => (banner.hidden ? '' : (agentName.textContent ?? '')),
        agentBannerAction: () => (banner.hidden ? '' : (agentAction.textContent ?? '')),
        globalPossessionText: () => (globalPossession.hidden ? '' : (globalPossessionLabel.textContent ?? '')),
        dockDrivingGlow: () => dock.classList.contains('agent-driving'),
        // 8/07: the guest is an in-DOM <webview> now — its rect IS the viewHost
        // rect, so a resize is atomic with the chrome (proven by guestRect ==
        // viewRect and the guest being present).
        guestReady: () => !!guests.get(activeKey()),
        guestRect: () => {
          const g = guests.get(activeKey())
          if (!g) return null
          const r = g.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        },
        // 8/04: agent-web profile surface for the smoke.
        profile: () => state.profile,
        setProfile: (p: BrowserProfile) => setProfile(p),
        agentWebNote: () => (agentWebNote.hidden ? '' : (noteText.textContent ?? '')),
        pendingConfirm: () => pendingOrigin || null,
        confirmPending: () => confirmBtn.click(),
        originAlertText: () => (originAlert.hidden ? '' : (originAlert.textContent ?? '')),
        openSites: async () => {
          sitesMenu.hidden = false
          await refreshSitesMenu()
        },
        sitesText: () => sitesMenu.textContent ?? '',
        recentActsText: () => (recentActs.hidden ? '' : (recentActs.textContent ?? '')),
        // ── Wave 3 chrome surface for the BROWSERUX gate ──────────────────────
        // Omnibox (F3): submit through the REAL input path; resolve without navigating.
        omniboxSubmit: (text: string) => {
          urlInput.value = text
          urlInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        },
        omniboxResolve: (text: string): string | null => {
          const r = resolveAddressInput(text)
          return r ? (r.kind === 'url' ? r.url : searchUrlFor(searchTemplate, r.query)) : null
        },
        urlLeadClass: () => urlLead.className,
        faviconSrc: () => urlLead.querySelector('img')?.getAttribute('src') ?? null,
        faviconCaptured: () => wsFavicon.get(activeWsId()) ?? null,
        reloadIsStop: () => !!reload.querySelector('svg') && reload.title === 'Stop loading',
        // Find (F5)
        openFind: () => openFind(),
        findVisible: () => !findBar.hidden,
        hasActiveGuest: () => !!activeGuest(),
        findRaw: (text: string) => {
          const g = activeGuest()
          return g ? g.findInPage(text) : -1 // request id (>0) proves the guest method ran
        },
        findType: (text: string) => {
          findInput.value = text
          findInput.dispatchEvent(new Event('input', { bubbles: true }))
        },
        findCountText: () => findCount.textContent ?? '',
        closeFind: () => closeFind(),
        // Zoom (F6)
        bumpZoom: (delta: number | 'reset') => bumpZoom(delta),
        zoomFactor: () => {
          const g = activeGuest() as unknown as { getZoomFactor?: () => number } | null
          return g?.getZoomFactor?.() ?? 1
        },
        // Error overlay (F10)
        errorVisible: () => !loadError.hidden,
        errorText: () => (loadError.hidden ? '' : (errorTitle.textContent ?? '')),
        // Context menu (F7) / shortcut relay (F12) are driven by MAIN sending the real
        // IPC in the gate; this only reads whether the house menu opened.
        contextMenuOpen: () => !!document.querySelector('.ctx-menu'),
        // Permission chip (F16): read the last blocked-permission chip text.
        permChipText: () => (permChip.hidden ? '' : (permChip.textContent ?? '')),
        // Pins/recents (F14): drive + read the quick-chip surface.
        pinCurrent: () => togglePin(activeWsId(), state.url),
        isPinnedCurrent: () => isPinned(activeWsId(), state.url),
        forceRenderChips: () => renderQuickChips(),
        quickChipHosts: () => Array.from(quickChips.querySelectorAll('span')).map((s) => s.textContent ?? ''),
        recentsCount: () => readList(recentsKey(activeWsId())).length,
        // Tabs (F4)
        tabCount: () => tabsFor(activeWsId(), activeProfile()).length,
        activeTabIndex: () => tabsFor(activeWsId(), activeProfile()).findIndex((t) => t.id === activeTabId(activeWsId(), activeProfile())),
        tabLabels: () => Array.from(tabStrip.querySelectorAll('.browser-tab-label')).map((s) => s.textContent ?? ''),
        tabStripShown: () => !tabStrip.hidden,
        newTab: (url?: string) => newTab(activeWsId(), activeProfile(), url),
        selectTabIndex: (i: number) => {
          const t = tabsFor(activeWsId(), activeProfile())[i]
          if (t) selectTab(activeWsId(), activeProfile(), t.id)
        },
        closeTabIndex: (i: number) => {
          const t = tabsFor(activeWsId(), activeProfile())[i]
          if (t) closeTab(activeWsId(), activeProfile(), t.id)
        },
        // Hardening (S1): try to attach a webview on a FOREIGN partition — the
        // will-attach-webview guard must refuse it (no dom-ready → returns false).
        probeRogueWebview: async (): Promise<boolean> => {
          const rogue = document.createElement('webview')
          rogue.setAttribute('partition', 'persist:evil-not-ours')
          rogue.setAttribute('src', 'about:blank')
          viewHost.append(rogue)
          const attached = await new Promise<boolean>((resolve) => {
            let done = false
            const settle = (v: boolean): void => { if (!done) { done = true; resolve(v) } }
            rogue.addEventListener('dom-ready', () => settle(true))
            window.setTimeout(() => settle(false), 2500)
          })
          rogue.remove()
          return attached
        }
      }
    }
  }
}
