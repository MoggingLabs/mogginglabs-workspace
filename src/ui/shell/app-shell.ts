import { ShellChannels, type WindowStateEvent } from '@contracts'
import type { ShellContext } from '../core/registry/feature-registry'
import { getBridge } from '../core/ipc/bridge'
import { clear } from '../components'
import { onViewChange } from '../core/shell/view-port'
import { getWorkspaces, onWorkspacesChange } from '../core/workspace/workspace-info-port'
import { applyCalmMotion } from '../core/a11y/motion-port'
import { createTitlebar } from './titlebar'

const RAIL_COLLAPSED_KEY = 'mogging.railCollapsed'

/**
 * App chrome: a classic full-width top bar (logo · name · version on the left; feature
 * triggers, rail toggle, settings and the native window-control overlay on the right)
 * over a two-column main region (workspace rail + content). Frameless window — the top
 * bar is the drag surface. The shell owns only structure: rail collapse state and which
 * view (home/grid) the content shows; it knows nothing about individual features.
 */
export function createAppShell(root: HTMLElement): ShellContext {
  clear(root)

  // A file dropped ANYWHERE a listener has not claimed makes Chromium navigate the window
  // to that file — the app is simply replaced by the dropped document, with no way back.
  // This is the backstop for every pixel outside a terminal pane. It sits on `window`, so
  // it runs LAST as the event bubbles: a pane's own drop handler (deeper in the tree) has
  // already run and consumed the drop by then. Both call preventDefault, which is what
  // suppresses the navigation; neither needs to stop propagation.
  for (const type of ['dragover', 'drop'] as const) {
    window.addEventListener(type, (e) => e.preventDefault())
  }

  const app = document.createElement('div')
  app.id = 'app'
  if (navigator.platform.toUpperCase().includes('MAC')) app.classList.add('platform-darwin')

  const toggleRail = (): void => {
    // With no workspaces the rail does not render (Home owns the app), so a toggle
    // has nothing to toggle: refuse — the button below also reads disabled, and this
    // guard covers the shortcut path too. Nothing to gray IN the rail: it is gone.
    if (getWorkspaces().workspaces.length === 0) return
    const collapsed = app.classList.toggle('rail-collapsed')
    try {
      localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '')
    } catch {
      /* storage unavailable — collapse just won't persist */
    }
  }

  const { el: titlebar, left, center, right, end, railToggle } = createTitlebar(toggleRail)

  // The toggle wears the truth: disabled (grayed) until a workspace exists — at the
  // zero-workspace Home there is no rail to collapse, and a button that silently
  // did nothing taught people it was broken. Re-enabled the moment one appears.
  // The ROOT carries the same truth as a class: the rail renders only where it
  // means something, and an empty rail beside the zero-workspace wizard meant
  // nothing — the wizard runs full-bleed until there are workspaces to show
  // (global.css keys the rail's display off this).
  onWorkspacesChange((snapshot) => {
    const none = snapshot.workspaces.length === 0
    app.classList.toggle('no-workspaces', none)
    railToggle.disabled = none
    railToggle.title = none ? 'Workspace rail — create a workspace first' : 'Toggle rail (Ctrl+Shift+B)'
  })

  const main = document.createElement('div')
  main.id = 'main'

  const rail = document.createElement('nav')
  rail.id = 'rail'
  rail.setAttribute('aria-label', 'Workspaces')

  const content = document.createElement('div')
  content.id = 'content'

  main.append(rail, content)
  app.append(titlebar, main)
  root.append(app)

  try {
    if (localStorage.getItem(RAIL_COLLAPSED_KEY)) app.classList.add('rail-collapsed')
  } catch {
    /* default: expanded */
  }
  applyCalmMotion() // Settings § Appearance "Calm motion" — stamp :root before first paint

  // Ctrl/Cmd+Shift+B toggles the rail. Shift is required on purpose: plain Ctrl+B is a
  // real terminal keystroke (tmux prefix, readline cursor-back) and must reach the PTY.
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        e.stopPropagation()
        toggleRail()
      }
    },
    true
  )

  // The content region shows exactly one view; the ROOT carries the view class too
  // (Phase-5/05) so top-level views can own the whole app — the rail renders only
  // in the grid (pure CSS show/hide: panes are never re-mounted by a view trip).
  onViewChange((view) => {
    for (const v of ['home', 'grid', 'board', 'settings', 'wizard', 'brain'] as const) {
      app.classList.toggle(`view-${v}`, view === v)
      content.classList.toggle(`view-${v}`, view === v)
    }
  })

  // Window-state chrome classes (Phase-5/04): fullscreen collapses the native-
  // controls reserve; maximized drops the rounded bottom corners. Event-driven
  // from main — the renderer never polls.
  try {
    getBridge().on(ShellChannels.windowState, (payload) => {
      const s = payload as WindowStateEvent
      app.classList.toggle('is-fullscreen', s.fullscreen === true)
      app.classList.toggle('is-maximized', s.maximized === true)
      app.dataset.chromeState = s.fullscreen ? 'fullscreen' : s.maximized ? 'maximized' : 'restored'
    })
  } catch {
    /* no bridge (tests) — chrome classes stay at the restored defaults */
  }

  return { content, rail, titlebarLeft: left, titlebarCenter: center, titlebarRight: right, titlebarEnd: end }
}
