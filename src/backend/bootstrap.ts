import type { BackendContext, FeatureModule } from './core/ipc/registry'
import { createTerminalModule } from './features/terminal'

// Compose every backend feature module. Adding a feature = import its module and
// add it to this list — the ONE central touch point on the backend side. Later
// this can become filesystem auto-discovery so even this edit disappears.
export function createFeatureModules(): FeatureModule[] {
  return [
    createTerminalModule()
    // createWorkspaceModule(),
    // createAgentsModule(),
  ]
}

/** Registers all features against a context; returns a disposer. */
export function startBackend(ctx: BackendContext): () => void {
  const modules = createFeatureModules()
  for (const m of modules) m.register(ctx)
  return () => {
    for (const m of modules) m.dispose?.()
  }
}
