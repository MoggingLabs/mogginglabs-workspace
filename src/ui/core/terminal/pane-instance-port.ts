import type { PaneId } from '@contracts'

// Pane ids are deliberately reusable. Async work that intends to write to a
// pane must also hold this renderer-session generation or a closed pane can be
// replaced at the same id before the callback fires.
const instances = new Map<PaneId, number>()
let nextInstance = 1

export function registerPaneInstance(id: PaneId): number {
  const instance = nextInstance++
  instances.set(id, instance)
  return instance
}

export function paneInstance(id: PaneId): number | undefined {
  return instances.get(id)
}

export function retirePaneInstance(id: PaneId, instance: number): void {
  if (instances.get(id) === instance) instances.delete(id)
}
