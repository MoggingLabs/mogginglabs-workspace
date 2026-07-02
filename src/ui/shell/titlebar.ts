import { TelemetryChannels, type TelemetryRendererConfig } from '@contracts'
import { IconButton } from '../components'
import { getBridge } from '../core/ipc/bridge'
import { runCommand } from '../core/commands/command-port'
import { activeView, setActiveView } from '../core/shell/view-port'

/**
 * The app's top bar, full width, frameless-native:
 *   LEFT   logo · product name · version — and nothing else.
 *   RIGHT  feature slots (palette / layout triggers mount here) · rail toggle ·
 *          settings · the OS window controls overlaid by the system (min/max/close).
 * The whole strip is a drag region; interactive children opt out in CSS.
 */
export function createTitlebar(onToggleRail: () => void): {
  el: HTMLElement
  left: HTMLElement
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
    icon: 'settings',
    label: 'Settings',
    title: 'Settings',
    onClick: () => runCommand('settings:open')
  })
  cluster.append(left, right, home, board, toggle, settings)

  el.append(brand, cluster)
  return { el, left, right }
}
