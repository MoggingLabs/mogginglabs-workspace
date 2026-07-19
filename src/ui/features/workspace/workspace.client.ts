import {
  WorkspaceChannels,
  type WorkspaceExportResult,
  type WorkspaceSaveResult,
  type WorkspaceState
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/** Typed client for app-level workspace state persistence (metadata only, ADR 0002). */
export const workspaceClient = {
  loadState: (): Promise<WorkspaceState | null> =>
    getBridge().invoke(WorkspaceChannels.loadState) as Promise<WorkspaceState | null>,
  saveState: (state: WorkspaceState): Promise<WorkspaceSaveResult> =>
    getBridge().invoke(WorkspaceChannels.saveState, state) as Promise<WorkspaceSaveResult>,
  exportState: (state: WorkspaceState): Promise<WorkspaceExportResult> =>
    getBridge().invoke(WorkspaceChannels.exportState, state) as Promise<WorkspaceExportResult>,
  onOpenCwd: (cb: (cwd: string) => void): void => {
    getBridge().on(WorkspaceChannels.openCwd, (p) => cb(p as string))
  },
  /** The OS-signal flags: background = an alert in a workspace you are not in; active = one in
   *  the workspace you ARE in (main rings it only while the window itself is unfocused). */
  setAttention: (alert: { background: boolean; active: boolean }): void => {
    getBridge().send(WorkspaceChannels.attention, alert)
  },
  /** Native directory picker (main-owned dialog). Resolves to a path or null on cancel. */
  browseDir: (): Promise<string | null> =>
    getBridge().invoke(WorkspaceChannels.browseDir) as Promise<string | null>
}
