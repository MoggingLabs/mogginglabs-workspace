import type { UiFeature } from '../../core/registry/feature-registry'
import {
  BrowserChannels,
  IntegrationsChannels,
  type BrowserAgentActivity,
  type BrowserDockBounds,
  type BrowserDockInit,
  type BrowserDockState,
  type BrowserNavAction,
  type BrowserProfile,
  type BrowserSignedInSite,
  type TrailEntry,
  type WorkspaceIntegrationsGrant
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { IconButton, el, icon } from '../../components'
import { getWorkspaces, onWorkspacesChange } from '../../core/workspace/workspace-info-port'
import { setCommands } from '../../core/commands/command-port'
import { getTelemetry } from '../../core/telemetry'

/**
 * The browser dock (Phase-6/05): a toggleable right dock previewing what the
 * agents build — chrome beside the grid, never a tenant of it. The renderer
 * owns ONLY the chrome (header, empty state, resize handle) and reports the
 * rect main's WebContentsView must cover; the page itself never enters the
 * renderer. ADR 0002: nothing here touches sessions, cookies, or credentials.
 */
export const browserFeature: UiFeature = {
  name: 'browser',
  mount(ctx) {
    const bridge = getBridge()
    let open = false
    let width = 420
    let state: BrowserDockState = {
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
    handle.setAttribute('aria-hidden', 'true')

    const back = IconButton({ icon: 'chevron-left', label: 'Back', title: 'Back', onClick: () => nav('back') })
    const forward = IconButton({ icon: 'chevron-right', label: 'Forward', title: 'Forward', onClick: () => nav('forward') })
    const reload = IconButton({ icon: 'rotate-cw', label: 'Reload', title: 'Reload', onClick: () => nav('reload') })
    const urlInput = el('input', { class: 'browser-url' }) as HTMLInputElement
    urlInput.placeholder = 'localhost:3000'
    urlInput.setAttribute('aria-label', 'Address')
    urlInput.spellcheck = false
    const external = IconButton({
      icon: 'globe',
      label: 'Open in system browser',
      title: 'Open in system browser',
      onClick: () => {
        if (state.url) void bridge.invoke(BrowserChannels.openExternal, { url: state.url })
      }
    })
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
    const header = el('div', { class: 'browser-dock-header' }, [back, forward, reload, urlInput, profileSwitch, external, close])

    // ── Agent possession (6/05b): visible whenever an agent holds the wheel ──
    const stopBtn = el('button', { class: 'browser-agent-stop', type: 'button', text: 'Stop' }) as HTMLButtonElement
    stopBtn.title = 'Revoke agent control now'
    stopBtn.onclick = (): void => bridge.send(BrowserChannels.agentStop, undefined)
    const agentLabel = el('span', { class: 'browser-agent-label', text: 'Agent driving' })
    const trailBtn = IconButton({ icon: 'more', label: 'Agent activity', title: 'Recent agent actions', onClick: () => {
      trailMenu.hidden = !trailMenu.hidden
    } })
    const banner = el('div', { class: 'browser-agent-banner', hidden: true }, [
      icon('sparkles', 14),
      agentLabel,
      el('div', { class: 'browser-agent-spacer' }),
      trailBtn,
      stopBtn
    ])
    const trailMenu = el('div', { class: 'menu browser-agent-trail', hidden: true })

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
      if (pendingOrigin) bridge.send(BrowserChannels.confirmOrigin, { origin: pendingOrigin })
    }
    // Recent acts (8/05): the last 3 TRAIL entries for the possessing
    // workspace — the audit surface's compact face on the possession chrome.
    const recentActs = el('div', { class: 'browser-recent-acts', hidden: true })
    let recentActsTimer: number | undefined
    function refreshRecentActs(): void {
      window.clearTimeout(recentActsTimer)
      recentActsTimer = window.setTimeout(async () => {
        const wsId = getWorkspaces().activeId
        if (!wsId || state.profile !== 'agent-web') {
          recentActs.hidden = true
          return
        }
        const entries = (await bridge.invoke(IntegrationsChannels.trailList, wsId)) as TrailEntry[]
        const last = entries.filter((t) => t.source === 'web').slice(-3).reverse()
        recentActs.innerHTML = ''
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
    let originAlertTimer: number | undefined
    bridge.on(BrowserChannels.originAlert, (payload) => {
      const p = payload as { from: string; to: string }
      originAlert.textContent = `Crossed origins: ${p.from} → ${p.to}`
      originAlert.hidden = false
      window.clearTimeout(originAlertTimer)
      originAlertTimer = window.setTimeout(() => {
        originAlert.hidden = true
      }, 6000)
    })
    // Sites & grants panel: signed-in sites in OUR agent-web partition (forget /
    // clear) + the minimal act-origin grant editor (06 builds the full home).
    const sitesMenu = el('div', { class: 'menu browser-sites-menu', hidden: true })
    sitesBtn.onclick = (): void => {
      sitesMenu.hidden = !sitesMenu.hidden
      if (!sitesMenu.hidden) void refreshSitesMenu()
    }

    // Workspace-preview chip: shown when the active workspace remembers a
    // DIFFERENT url than the one on screen (switching never auto-navigates).
    const wsChip = el('button', { class: 'browser-ws-chip', type: 'button', hidden: true }) as HTMLButtonElement

    const empty = el('div', { class: 'browser-empty' }, [
      icon('globe', 28),
      el('div', { class: 'browser-empty-title', text: 'Preview what the agents build' }),
      el('div', { class: 'browser-empty-hint', text: 'Enter a URL above — your dev server, docs, anything http(s).' })
    ])
    // Shown over the (hidden) native view during a resize so the freeze reads
    // as intentional — the page's host, faint — not a blank pane.
    const resizeHint = el('div', { class: 'browser-resize-hint', hidden: true })
    const viewHost = el('div', { class: 'browser-dock-view' }, [empty, resizeHint])
    const hostOf = (u: string): string => {
      try {
        return new URL(u).host
      } catch {
        return ''
      }
    }
    dock.append(handle, header, agentWebNote, banner, recentActs, confirmBar, originAlert, trailMenu, sitesMenu, loading, wsChip, viewHost)
    // The dock is #content's flex sibling inside #main — inserted, not slotted,
    // so the shell stays feature-agnostic.
    ctx.content.insertAdjacentElement('afterend', dock)

    // ── Bounds: the ONE rect main must cover (rAF-throttled) ────────────────
    let rafPending = false
    let resizing = false
    let winResizeTimer: number | undefined
    const computeBounds = (): BrowserDockBounds => {
      const r = viewHost.getBoundingClientRect()
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        dockWidth: width,
        visible: open && r.width > 0 && state.url !== ''
      }
    }
    const sendBounds = (): void => {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        bridge.send(BrowserChannels.bounds, computeBounds())
      })
    }
    // During a CONTINUOUS resize (dragging the handle, or the OS window drag)
    // the native WebContentsView reflows the whole page on every frame — on a
    // real page that is 10–50 ms of relayout, so the preview visibly TRAILS the
    // chrome. Freeze it: hide the live view, let the CSS chrome resize alone at
    // 60 fps, and snap the view to the final rect once on release/settle.
    const beginResize = (): void => {
      if (resizing) return
      resizing = true
      dock.classList.add('is-resizing')
      resizeHint.textContent = hostOf(state.url)
      resizeHint.hidden = !state.url
      bridge.send(BrowserChannels.resizing, { active: true })
    }
    const endResize = (): void => {
      if (!resizing) return
      resizing = false
      dock.classList.remove('is-resizing')
      resizeHint.hidden = true
      bridge.send(BrowserChannels.resizing, { active: false, bounds: computeBounds() })
    }
    new ResizeObserver(sendBounds).observe(viewHost)
    window.addEventListener('resize', () => {
      // The OS window drag fires 'resize' continuously — freeze until it
      // settles (a quiet gap), then snap. The ResizeObserver above keeps
      // main's stored rect fresh throughout; main ignores it while frozen.
      beginResize()
      window.clearTimeout(winResizeTimer)
      winResizeTimer = window.setTimeout(endResize, 140)
    })

    // ── Width drag ───────────────────────────────────────────────────────────
    const applyWidth = (): void => {
      width = Math.max(320, Math.min(Math.round(window.innerWidth * 0.6), width))
      dock.style.width = `${width}px`
      // While frozen, resize the CSS chrome only — no per-frame bounds/reflow.
      if (!resizing) sendBounds()
    }
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      handle.setPointerCapture(e.pointerId)
      beginResize()
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
        endResize()
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    })

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
      toggleBtn.classList.toggle('is-active', open)
      void bridge.invoke(BrowserChannels.toggle, { open, workspaceId: getWorkspaces().activeId ?? undefined })
      sendBounds()
      if (open) urlInput.focus()
      getTelemetry().captureEvent({ name: 'browser.dock', props: { open } }) // boolean only — never URLs (ADR 0005)
    }

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyU') {
        e.preventDefault()
        toggle(!open)
      }
    })
    setCommands('browser', [
      { id: 'browser.toggle', title: 'Toggle browser dock', hint: 'Browser', kbd: 'Ctrl+Shift+U', run: () => toggle(!open) }
    ])

    // ── Navigation ───────────────────────────────────────────────────────────
    function nav(action: BrowserNavAction): void {
      void bridge.invoke(BrowserChannels.nav, { action })
    }
    urlInput.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key !== 'Enter') return
      const raw = urlInput.value.trim()
      if (!raw) return
      void bridge
        .invoke(BrowserChannels.navigate, { url: raw, workspaceId: getWorkspaces().activeId ?? undefined })
        .then((ok) => {
          if (ok) empty.hidden = true
        })
    })

    // ── Profile switch + agent-web chrome (8/04) ─────────────────────────────
    async function setProfile(p: BrowserProfile): Promise<void> {
      await bridge.invoke(BrowserChannels.profileSet, { workspaceId: getWorkspaces().activeId ?? undefined, profile: p })
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
      const titleEl = empty.querySelector('.browser-empty-title')
      const hintEl = empty.querySelector('.browser-empty-hint')
      if (titleEl && hintEl) {
        titleEl.textContent = agentWeb ? 'The agents’ signed-in browser' : 'Preview what the agents build'
        hintEl.textContent = agentWeb
          ? 'Sign in here on purpose. Sessions stay in this profile — never your system browser.'
          : 'Enter a URL above — your dev server, docs, anything http(s).'
      }
      if (!agentWeb) sitesMenu.hidden = true
    }
    // Follow the ACTIVE workspace's stored profile (per-workspace persisted).
    async function applyWorkspaceProfile(): Promise<void> {
      const wsId = getWorkspaces().activeId
      if (!wsId) return
      const stored = (await bridge.invoke(BrowserChannels.profileGet, wsId)) as BrowserProfile
      if (stored !== state.profile) await setProfile(stored)
    }
    onWorkspacesChange(() => void applyWorkspaceProfile())

    async function refreshSitesMenu(): Promise<void> {
      const wsId = getWorkspaces().activeId
      sitesMenu.innerHTML = ''
      sitesMenu.append(el('div', { class: 'menu-note browser-sites-head', text: 'Signed-in sites (agent web profile)' }))
      const sites = (await bridge.invoke(BrowserChannels.signedInSites, undefined)) as BrowserSignedInSite[]
      if (!sites.length) sitesMenu.append(el('div', { class: 'menu-note', text: 'No sign-ins yet — log into a site in this profile.' }))
      for (const s of sites) {
        const forget = el('button', { class: 'browser-sites-forget', type: 'button', text: 'Forget' }) as HTMLButtonElement
        forget.onclick = async (): Promise<void> => {
          await bridge.invoke(BrowserChannels.forgetSite, s.host)
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
          await bridge.invoke(BrowserChannels.clearAgentLogins, undefined)
          void refreshSitesMenu()
        }
        sitesMenu.append(clearAll)
      }
      // The minimal act-origin grant editor (Settings § Integrations is the
      // full home, 06). Origins agents may ACT on, for the ACTIVE workspace.
      sitesMenu.append(el('div', { class: 'menu-note browser-sites-head', text: 'Origins agents may act on (this workspace)' }))
      if (!wsId) {
        sitesMenu.append(el('div', { class: 'menu-note', text: 'No active workspace.' }))
        return
      }
      const grant = (await bridge.invoke(IntegrationsChannels.grantGet, wsId)) as WorkspaceIntegrationsGrant
      for (const origin of grant.actOrigins) {
        const drop = el('button', { class: 'browser-sites-forget', type: 'button', text: 'Revoke' }) as HTMLButtonElement
        drop.onclick = async (): Promise<void> => {
          await bridge.invoke(IntegrationsChannels.grantSet, {
            ...grant,
            actOrigins: grant.actOrigins.filter((o) => o !== origin)
          })
          void refreshSitesMenu()
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
        const raw = addInput.value.trim()
        if (!raw) return
        const saved = (await bridge.invoke(IntegrationsChannels.grantSet, {
          ...grant,
          web: 'signed-in', // granting an origin IS opting into the signed-in tier
          actOrigins: [...grant.actOrigins, raw]
        })) as WorkspaceIntegrationsGrant | null
        const landed = !!saved && saved.actOrigins.length > grant.actOrigins.length
        if (!landed) {
          addNote.textContent = `“${raw}” was refused — sensitive origins never accept act grants.`
          addNote.hidden = false
          return
        }
        void refreshSitesMenu()
      }
      sitesMenu.append(el('div', { class: 'browser-sites-addrow' }, [addInput, addBtn]), addNote)
    }

    // ── State from main (header truth) ───────────────────────────────────────
    bridge.on(BrowserChannels.state, (payload) => {
      state = payload as BrowserDockState
      if (document.activeElement !== urlInput) urlInput.value = state.url
      back.disabled = !state.canGoBack
      forward.disabled = !state.canGoForward
      loading.classList.toggle('is-loading', state.loading)
      empty.hidden = state.url !== ''
      renderProfileChrome()
      sendBounds() // visibility depends on url presence
      void refreshChip()
    })

    // ── The per-workspace preview chip (switching never navigates) ──────────
    async function refreshChip(): Promise<void> {
      const wsId = getWorkspaces().activeId
      if (!wsId || !open) {
        wsChip.hidden = true
        return
      }
      const last = (await bridge.invoke(BrowserChannels.lastUrl, wsId)) as string | null
      const differs = !!last && last !== state.url
      wsChip.hidden = !differs
      if (differs && last) {
        wsChip.textContent = `Open this workspace's preview — ${new URL(last).host}`
        wsChip.onclick = (): void => {
          void bridge.invoke(BrowserChannels.navigate, { url: last, workspaceId: wsId })
          wsChip.hidden = true
        }
      }
    }
    onWorkspacesChange(() => void refreshChip())

    // ── Agent control: consent follows the active workspace (default OFF).
    //    8/04: the workspace id rides along so act-origin grants resolve. ────
    async function pushConsent(): Promise<void> {
      const wsId = getWorkspaces().activeId
      const allowed = !!wsId && (await bridge.invoke(BrowserChannels.consentGet, wsId)) === true
      bridge.send(BrowserChannels.consent, { allowed, workspaceId: wsId ?? undefined })
    }
    onWorkspacesChange(() => void pushConsent())

    // Possession state from main: brand the dock, show Stop, list the trail.
    const VERB_LABEL: Record<string, string> = {
      navigate: 'Navigated', back: 'Back', forward: 'Forward', reload: 'Reloaded',
      snapshot: 'Read page', screenshot: 'Screenshot', click: 'Clicked', type: 'Typed',
      scroll: 'Scrolled', select: 'Selected', eval: 'Ran script', console: 'Read console',
      network_failures: 'Read failures', wait_for: 'Waited for'
    }
    bridge.on(BrowserChannels.activity, (payload) => {
      const a = payload as BrowserAgentActivity
      banner.hidden = !a.driving
      dock.classList.toggle('agent-driving', a.driving)
      // 8/04: the session-scoped confirm rides the activity push.
      pendingOrigin = a.pendingConfirm ?? ''
      confirmBar.hidden = !pendingOrigin
      if (pendingOrigin) confirmBtn.textContent = `Allow acting on ${pendingOrigin} this session`
      refreshRecentActs() // debounced; agent verbs are exactly when the trail moves
      if (a.driving) trailBtn.classList.remove('is-hidden')
      trailMenu.innerHTML = ''
      for (const t of [...a.trail].reverse()) {
        const row = el('div', { class: 'menu-note browser-trail-row' })
        // Verb + target REF only — never page content, typed text, or eval bodies.
        row.textContent = t.target ? `${VERB_LABEL[t.verb] ?? t.verb} · ${t.target}` : (VERB_LABEL[t.verb] ?? t.verb)
        trailMenu.append(row)
      }
      if (!a.trail.length) trailMenu.append(el('div', { class: 'menu-note', text: 'No agent actions yet.' }))
    })

    // ── Persisted boot state ─────────────────────────────────────────────────
    void (bridge.invoke(BrowserChannels.init, undefined) as Promise<BrowserDockInit>).then((init) => {
      width = init.width
      applyWidth()
      if (init.open) toggle(true)
      void pushConsent() // make the active workspace's stored grant live at boot
      void applyWorkspaceProfile() // and its stored profile (8/04)
    })

    document.addEventListener('click', (e) => {
      if (!(e.target instanceof Node) || (!trailMenu.contains(e.target) && !banner.contains(e.target))) trailMenu.hidden = true
      if (e.target instanceof Node && !sitesMenu.contains(e.target) && !agentWebNote.contains(e.target)) sitesMenu.hidden = true
    })

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
        setConsent: async (allowed: boolean) => {
          const wsId = getWorkspaces().activeId
          if (!wsId) return
          await bridge.invoke(BrowserChannels.consentSet, { workspaceId: wsId, allowed })
          await pushConsent()
        },
        driving: () => !banner.hidden,
        trailCount: () => trailMenu.querySelectorAll('.browser-trail-row').length,
        // 8/07 resize-freeze surface for the BROWSER smoke.
        beginResize: () => beginResize(),
        endResize: () => endResize(),
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
        recentActsText: () => (recentActs.hidden ? '' : (recentActs.textContent ?? ''))
      }
    }
  }
}
