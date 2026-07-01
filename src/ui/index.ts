import './styles/global.css'
import { createAppShell } from './shell/app-shell'
import { mountFeatures, registerFeature } from './core/registry/feature-registry'
import { layoutFeature } from './features/layout'
import { terminalFeature } from './features/terminal'
import { agentStateFeature } from './features/agent-state'

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
  registerFeature(layoutFeature) // provides slots; must register before terminal fills them
  registerFeature(terminalFeature)
  registerFeature(agentStateFeature)
  mountFeatures(shell)
}
