import { WorkspaceChannels, type WorkspaceState } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/** Typed client for app-level workspace state persistence (metadata only, ADR 0002). */
export const workspaceClient = {
  loadState: (): Promise<WorkspaceState | null> =>
    getBridge().invoke(WorkspaceChannels.loadState) as Promise<WorkspaceState | null>,
  saveState: (state: WorkspaceState): void => {
    void getBridge().invoke(WorkspaceChannels.saveState, state)
  },
  onOpenCwd: (cb: (cwd: string) => void): void => {
    getBridge().on(WorkspaceChannels.openCwd, (p) => cb(p as string))
  },
  setAttention: (anyAttention: boolean): void => {
    getBridge().send(WorkspaceChannels.attention, anyAttention)
  },
  /** Native directory picker (main-owned dialog). Resolves to a path or null on cancel. */
  browseDir: (): Promise<string | null> =>
    getBridge().invoke(WorkspaceChannels.browseDir) as Promise<string | null>
}
