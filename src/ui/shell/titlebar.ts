import { TelemetryChannels, type TelemetryRendererConfig } from '@contracts'
import { IconButton } from '../components'
import { getBridge } from '../core/ipc/bridge'
import { activeView, goBack, onViewChange, setActiveView } from '../core/shell/view-port'

/**
 * The app's top bar — a strict 3-column grid (1fr auto 1fr), frameless-native:
 *   LEFT    logo · product name · version — and nothing else.
 *   CENTER  the command box (palette trigger) — TRUE window center via the grid.
 *   RIGHT   feature slots (layout trigger) · rail toggle · settings · the OS
 *           window-control overlay reserve (collapses to a normal gap in F11).
 * The whole strip is a drag region; interactive children opt out in CSS.
 */
export function createTitlebar(onToggleRail: () => void): {
  el: HTMLElement
  left: HTMLElement
  center: HTMLElement
  right: HTMLElement
} {
  const el = document.createElement('header')
  el.id = 'titlebar'

  const brand = document.createElement('div')
  brand.className = 'brand'
  const logo = document.createElement('img')
  logo.className = 'brand-logo'
  logo.src = './logo.png'
  logo.alt = ''
  const name = document.createElement('span')
  name.className = 'brand-name'
  name.textContent = 'MoggingLabs Workspace'
  const version = document.createElement('span')
  version.className = 'brand-version'
  brand.append(logo, name, version)

  // Version comes from main (app.getVersion, already exposed as the telemetry
  // config's `release`) — best-effort, blank until it resolves.
  try {
    void getBridge()
      .invoke(TelemetryChannels.getConfig)
      .then((cfg) => {
        const release = (cfg as TelemetryRendererConfig | null)?.release
        if (release) version.textContent = `v${release}`
      })
      .catch(() => undefined)
  } catch {
    /* no bridge (tests) */
  }

  // Center cell: the command box mounts here (true window-center via the grid).
  const center = document.createElement('div')
  center.className = 'titlebar-center'

  // Right cluster: [feature slots][rail toggle][settings] + OS overlay clearance.
  const cluster = document.createElement('div')
  cluster.className = 'titlebar-right'
  const left = document.createElement('div')
  left.className = 'titlebar-slot'
  const right = document.createElement('div')
  right.className = 'titlebar-slot'
  const home = IconButton({
    icon: 'home',
    label: 'Home',
    title: 'Home (Ctrl+Shift+H)',
    onClick: () => setActiveView(activeView() === 'home' ? 'grid' : 'home')
  })
  const board = IconButton({
    icon: 'kanban',
    label: 'Board',
    title: 'Board (Ctrl+Shift+G)',
    onClick: () => setActiveView(activeView() === 'board' ? 'grid' : 'board')
  })
  const toggle = IconButton({
    icon: 'panel-left',
    label: 'Toggle workspace rail',
    title: 'Toggle rail (Ctrl+Shift+B)',
    class: 'rail-toggle',
    onClick: onToggleRail
  })
  const settings = IconButton({
    icon: 'sliders',
    label: 'Settings',
    title: 'Settings',
    onClick: () => (activeView() === 'settings' ? goBack() : setActiveView('settings'))
  })
  cluster.append(left, right, home, board, toggle, settings)

  // The view-switcher trio: the active top-level view's button reads active.
  onViewChange((v) => {
    home.classList.toggle('is-active', v === 'home')
    board.classList.toggle('is-active', v === 'board')
    settings.classList.toggle('is-active', v === 'settings')
  })

  el.append(brand, center, cluster)
  return { el, left, center, right }
}
