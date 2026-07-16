import { TelemetryChannels, type TelemetryRendererConfig } from '@contracts'
import { IconButton } from '../components'
import { getBridge } from '../core/ipc/bridge'
import { activeView, goBack, onViewChange, setActiveView } from '../core/shell/view-port'

/**
 * The app's top bar — a strict 3-column grid (1fr auto 1fr), frameless-native:
 *   LEFT    rail toggle · logo · product name · version — and nothing else. The toggle
 *           leads because it belongs OVER the column it collapses (the workspace rail),
 *           which is where every editor that ships one puts it.
 *   CENTER  the command box (palette trigger) — TRUE window center via the grid.
 *   RIGHT   two feature slots (layout trigger et al.) · Home · Board · settings ·
 *           the OS window-control overlay reserve (a normal gap in F11).
 *           That left→right order is DECLARED in one place: the cluster.append() below.
 * The whole strip is a drag region; interactive children opt out in CSS.
 */
export function createTitlebar(onToggleRail: () => void): {
  el: HTMLElement
  left: HTMLElement
  center: HTMLElement
  right: HTMLElement
  end: HTMLElement
  /** The rail-collapse button — the shell gates it on the workspace count. */
  railToggle: HTMLButtonElement
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

  // Right cluster — its left→right order is DECLARED by the cluster.append() below (the
  // ONLY place it lives; it was previously incidental feature-registration order). Two
  // feature slots lead (ShellContext.titlebarLeft/Right — features mount their triggers
  // into them), then the fixed view/settings controls, then the OS window-control
  // overlay reserve (CSS padding on .titlebar-right).
  const cluster = document.createElement('div')
  cluster.className = 'titlebar-right'
  const left = document.createElement('div')
  left.className = 'titlebar-slot'
  const right = document.createElement('div')
  right.className = 'titlebar-slot'
  // The FAR-RIGHT slot (11/03): after Settings, last before the OS window-control
  // reserve. A toggle belongs over the thing it opens — the rail toggle leads the bar
  // at the far left, so the explorer's toggle ends it at the far right.
  const end = document.createElement('div')
  end.className = 'titlebar-slot'
  // NO Home button, by design. Home is the boot launcher and the zero-workspace empty
  // state — never a destination. Once a workspace exists the grid owns the app, and
  // view-port.ts enforces that; a button here would be a road to a place you cannot go.
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
    title: 'Settings (Ctrl+,)',
    onClick: () => (activeView() === 'settings' ? goBack() : setActiveView('settings'))
  })
  // THE declaration: feature slots (titlebarLeft, titlebarRight) → Board → settings →
  // titlebarEnd. Read left-to-right, this is the right cluster. `end` is a SLOT, not a
  // direct button, so the fixed controls' gap contract (Board→Settings) is untouched.
  cluster.append(left, right, board, settings, end)

  // THE left cell: the rail toggle, then the brand. The toggle sits over the rail it
  // collapses; the brand follows it. macOS clears the traffic lights by insetting THIS
  // cluster (see #app.platform-darwin #titlebar .titlebar-lead).
  const lead = document.createElement('div')
  lead.className = 'titlebar-lead'
  lead.append(toggle, brand)

  // The view-switcher pair: the active top-level view's button reads active.
  onViewChange((v) => {
    board.classList.toggle('is-active', v === 'board')
    settings.classList.toggle('is-active', v === 'settings')
  })

  el.append(lead, center, cluster)
  // `railToggle` rides out so the shell can gate it on the workspace count — the
  // shell owns rail collapse state, and a toggle over a rail that does not render
  // (zero workspaces: Home) must read as unavailable, not as a silent no-op.
  return { el, left, center, right, end, railToggle: toggle }
}
