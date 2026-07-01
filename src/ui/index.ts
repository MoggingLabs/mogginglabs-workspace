import './styles/global.css'
import { createAppShell } from './shell/app-shell'
import { mountFeatures, registerFeature } from './core/registry/feature-registry'
import { workspaceFeature } from './features/workspace'
import { terminalFeature } from './features/terminal'
import { agentsFeature } from './features/agents'
import { templatesFeature } from './features/templates'
import { agentStateFeature } from './features/agent-state'
import { gitFeature } from './features/git'

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
  registerFeature(workspaceFeature) // owns tabs + per-workspace grids; provides slots
  registerFeature(terminalFeature)
  registerFeature(agentsFeature) // agent launcher (picker -> focused pane)
  registerFeature(templatesFeature) // provider-mix workspace templates (06b)
  registerFeature(agentStateFeature)
  registerFeature(gitFeature) // per-pane read-only git branch + dirty (Phase-2/03)
  mountFeatures(shell)
}
