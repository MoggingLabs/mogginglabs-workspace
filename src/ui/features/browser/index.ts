import type { UiFeature } from '../../core/registry/feature-registry'
import {
  BrowserChannels,
  type BrowserDockBounds,
  type BrowserDockInit,
  type BrowserDockState,
  type BrowserNavAction
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
    let state: BrowserDockState = { url: '', title: '', canGoBack: false, canGoForward: false, loading: false }

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
    const header = el('div', { class: 'browser-dock-header' }, [back, forward, reload, urlInput, external, close])

    // Workspace-preview chip: shown when the active workspace remembers a
    // DIFFERENT url than the one on screen (switching never auto-navigates).
    const wsChip = el('button', { class: 'browser-ws-chip', type: 'button', hidden: true }) as HTMLButtonElement

    const empty = el('div', { class: 'browser-empty' }, [
      icon('globe', 28),
      el('div', { class: 'browser-empty-title', text: 'Preview what the agents build' }),
      el('div', { class: 'browser-empty-hint', text: 'Enter a URL above — your dev server, docs, anything http(s).' })
    ])
    const viewHost = el('div', { class: 'browser-dock-view' }, [empty])
    dock.append(handle, header, loading, wsChip, viewHost)
    // The dock is #content's flex sibling inside #main — inserted, not slotted,
    // so the shell stays feature-agnostic.
    ctx.content.insertAdjacentElement('afterend', dock)

    // ── Bounds: the ONE rect main must cover (rAF-throttled) ────────────────
    let rafPending = false
    const sendBounds = (): void => {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        const r = viewHost.getBoundingClientRect()
        const b: BrowserDockBounds = {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          dockWidth: width,
          visible: open && r.width > 0 && state.url !== ''
        }
        bridge.send(BrowserChannels.bounds, b)
      })
    }
    new ResizeObserver(sendBounds).observe(viewHost)
    window.addEventListener('resize', sendBounds)

    // ── Width drag ───────────────────────────────────────────────────────────
    const applyWidth = (): void => {
      width = Math.max(320, Math.min(Math.round(window.innerWidth * 0.6), width))
      dock.style.width = `${width}px`
      sendBounds()
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
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
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

    // ── State from main (header truth) ───────────────────────────────────────
    bridge.on(BrowserChannels.state, (payload) => {
      state = payload as BrowserDockState
      if (document.activeElement !== urlInput) urlInput.value = state.url
      back.disabled = !state.canGoBack
      forward.disabled = !state.canGoForward
      loading.classList.toggle('is-loading', state.loading)
      empty.hidden = state.url !== ''
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

    // ── Persisted boot state ─────────────────────────────────────────────────
    void (bridge.invoke(BrowserChannels.init, undefined) as Promise<BrowserDockInit>).then((init) => {
      width = init.width
      applyWidth()
      if (init.open) toggle(true)
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
        state: () => ({ ...state })
      }
    }
  }
}
