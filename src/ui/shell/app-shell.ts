import type { ShellContext } from '../core/registry/feature-registry'
import { onViewChange } from '../core/shell/view-port'
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
  root.innerHTML = ''

  const app = document.createElement('div')
  app.id = 'app'
  if (navigator.platform.toUpperCase().includes('MAC')) app.classList.add('platform-darwin')

  const toggleRail = (): void => {
    const collapsed = app.classList.toggle('rail-collapsed')
    try {
      localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '')
    } catch {
      /* storage unavailable — collapse just won't persist */
    }
  }

  const { el: titlebar, left, right } = createTitlebar(toggleRail)

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

  // The content region shows exactly one view: Home or the workspace grids.
  onViewChange((view) => {
    content.classList.toggle('view-home', view === 'home')
    content.classList.toggle('view-board', view === 'board')
  })

  return { content, rail, titlebarLeft: left, titlebarRight: right }
}
