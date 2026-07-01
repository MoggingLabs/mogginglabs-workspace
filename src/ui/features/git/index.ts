import type { UiFeature } from '../../core/registry/feature-registry'
import { onPaneCwd } from '../../core/layout/pane-cwd'
import { setPaneGit, clearPaneGit, getPaneGit } from '../../core/git/git-port'
import { gitClient } from './git.client'

/**
 * Per-pane read-only git (Phase-2/03). Wholly decoupled + DOM-free: it reads each pane's cwd from
 * the pane-cwd port, asks the backend to watch that cwd, and republishes the resulting branch +
 * dirty status on the git port — where each `TerminalPane` picks it up for its chip. It imports
 * no other feature; it meets `terminal`/`workspace` only through the two ports + `@contracts`.
 */
export const gitFeature: UiFeature = {
  name: 'git',
  mount() {
    // Backend status updates -> git port -> pane chips.
    gitClient.onChange((e) => setPaneGit(e.paneId, e.status))

    // Each pane's cwd (workspace seed or OSC-7 refinement) -> start/stop backend tracking.
    onPaneCwd((paneId, cwd) => {
      if (cwd) {
        gitClient.watch(paneId, cwd) // an immediate probe + change event follows
      } else {
        gitClient.unwatch(paneId) // pane disposed
        clearPaneGit(paneId)
      }
    })

    exposeForDev()
  }
}

/** Dev-only handles for the git smoke. Tree-shaken in production. */
function exposeForDev(): void {
  if (!import.meta.env.DEV) return
  const w = window as unknown as { __mogging?: Record<string, unknown> }
  w.__mogging = w.__mogging ?? {}
  w.__mogging.git = {
    status: (paneId: number) => getPaneGit(paneId),
    query: (cwd: string) => gitClient.query(cwd)
  }
}
