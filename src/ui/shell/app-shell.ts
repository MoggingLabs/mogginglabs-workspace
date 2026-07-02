import type { ShellContext } from '../core/registry/feature-registry'
import { onViewChange } from '../core/shell/view-port'
import { createTitlebar } from './titlebar'

const RAIL_COLLAPSED_KEY = 'mogging.railCollapsed'

/**
 * Builds the app chrome as ONE organic surface: a full-height workspace rail (its top
 * corner is the brand + a drag region) beside a content column headed by a slim,
 * draggable toolbar. The window is frameless (titleBarStyle hidden) — only the native
 * window controls overlay the app, so nothing reads as chrome glued on top. The shell
 * owns only structure: rail collapse and which view (home/grid) the content shows.
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

  // Left: the rail, full height. Its brand corner doubles as a window drag region
  // (and clears the macOS traffic lights via the platform class).
  const rail = document.createElement('nav')
  rail.id = 'rail'
  rail.setAttribute('aria-label', 'Workspaces')

  const brand = document.createElement('div')
  brand.className = 'rail-brand'
  const logo = document.createElement('img')
  logo.className = 'brand-logo'
  logo.src = './logo.png'
  logo.alt = ''
  const name = document.createElement('span')
  name.className = 'brand-name'
  name.textContent = 'MoggingLabs Workspace'
  brand.append(logo, name)
  rail.append(brand)

  // Right: header strip + content views.
  const { el: titlebar, left, right } = createTitlebar(toggleRail)
  const content = document.createElement('div')
  content.id = 'content'
  const column = document.createElement('div')
  column.id = 'right-col'
  column.append(titlebar, content)

  app.append(rail, column)
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
  })

  return { content, rail, titlebarLeft: left, titlebarRight: right }
}
