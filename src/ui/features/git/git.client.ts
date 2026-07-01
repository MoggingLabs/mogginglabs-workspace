import { GitChannels, type GitStatus, type GitStatusEvent, type PaneId } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/**
 * Typed client for the read-only git feature. `query` is a one-shot probe; `watch`/`unwatch`
 * start/stop per-pane tracking and `onChange` streams status updates. The only place in the UI
 * that knows the git channel names.
 */
export const gitClient = {
  query: (cwd: string): Promise<GitStatus | null> =>
    getBridge().invoke(GitChannels.query, cwd) as Promise<GitStatus | null>,
  watch: (paneId: PaneId, cwd: string): void => getBridge().send(GitChannels.watch, { paneId, cwd }),
  unwatch: (paneId: PaneId): void => getBridge().send(GitChannels.unwatch, { paneId }),
  onChange: (cb: (e: GitStatusEvent) => void): void =>
    getBridge().on(GitChannels.change, (p) => cb(p as GitStatusEvent))
}
