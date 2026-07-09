import '@fontsource-variable/jetbrains-mono' // the app typeface — UI and terminals alike
import './styles/global.css'
import { createAppShell } from './shell/app-shell'
import { mountFeatures, registerFeature } from './core/registry/feature-registry'
import { workspaceFeature } from './features/workspace'
import { homeFeature } from './features/home'
import { terminalFeature } from './features/terminal'
import { agentsFeature } from './features/agents'
import { wizardFeature } from './features/wizard'
import { gitFeature } from './features/git'
import { contextFeature } from './features/context'
import { reviewFeature } from './features/review'
import { boardFeature } from './features/board'
import { paletteFeature } from './features/palette'
import { settingsFeature } from './features/settings'
import { notifyFeature } from './features/notify'
import { browserFeature } from './features/browser'
import { updatesFeature } from './features/updates'
import { usageFeature } from './features/usage'
import { shortcutsFeature } from './features/shortcuts'

export { getTelemetry, setTelemetry } from './core/telemetry'

/**
 * Mount the UI. Call AFTER renderer telemetry is initialized (see src/renderer/main.ts)
 * so early UI errors are captured. Adding a feature = register it here (the ONE central
 * touch on the UI side) — later replaceable with auto-registration.
 */
export function start(): void {
  const root = document.getElementById('root')
  if (!root) throw new Error('#root not found')

  const shell = createAppShell(root)
  registerFeature(workspaceFeature) // owns the rail + per-workspace grids; provides slots
  registerFeature(homeFeature) // launcher view: hero + recents + presets (net-new)
  registerFeature(terminalFeature)
  registerFeature(agentsFeature) // agent detection + launch commands (wizard/palette/pane menu)
  registerFeature(wizardFeature) // new-workspace wizard: Start · Layout · Agents (06b contracts)
  registerFeature(gitFeature) // per-pane read-only git branch + dirty (Phase-2/03)
  registerFeature(contextFeature) // per-pane agent context bar: CLI session-log tail -> header bar
  registerFeature(reviewFeature) // pre-ship diff review: redacted, text-only, guarded merge (Phase-3/04)
  registerFeature(boardFeature) // local Kanban board: cards that launch agents (Phase-3/05)
  registerFeature(paletteFeature) // Ctrl/Cmd+K command palette over the command port
  registerFeature(settingsFeature) // theme / defaults / telemetry consent (ADR 0005)
  registerFeature(notifyFeature) // toasts for background-pane attention (mogging notify)
  registerFeature(browserFeature) // toggleable right browser dock: preview what agents build (6/05)
  registerFeature(updatesFeature) // auto-update UX: downloading dot + one-click restart toast (6/06)
  registerFeature(usageFeature) // usage glance: titlebar two-bar gauge + popover (Phase-7/03)
  registerFeature(shortcutsFeature) // ? opens the keyboard-shortcuts sheet (UX audit KB-01)
  mountFeatures(shell)
}
