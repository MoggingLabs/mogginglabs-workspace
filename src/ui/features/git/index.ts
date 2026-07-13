import type { UiFeature } from '../../core/registry/feature-registry'
import { getPaneCwdProjection, onPaneCwdProjection } from '../../core/layout/pane-cwd'
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
    const watched = new Map<number, string>()

    // Backend status updates -> git port -> pane chips.
    gitClient.onChange((e) => {
      // A status already in flight when a pane becomes remote must never repaint local Git.
      if (getPaneCwdProjection(e.paneId)?.locality !== 'local') return clearPaneGit(e.paneId)
      setPaneGit(e.paneId, e.status)
    })

    // Only LOCAL projections may cross into the local Git service. Source-only changes (for
    // example shell -> explicit agent at the same path) do not restart an identical watch.
    onPaneCwdProjection((paneId, projection) => {
      if (projection?.locality === 'local') {
        if (watched.get(paneId) === projection.cwd) return
        watched.set(paneId, projection.cwd)
        clearPaneGit(paneId) // never leave the previous worktree's branch visible mid-retarget
        gitClient.watch(paneId, projection.cwd) // an immediate probe + change event follows
      } else {
        watched.delete(paneId)
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
