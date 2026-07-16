import {
  FsChannels,
  GitChannels,
  TemplateChannels,
  WorkspaceChannels,
  WorktreeChannels,
  type CreateWorktreeResult,
  type DirResult,
  type ListDirRequest,
  type GitStatus,
  type ProviderCount,
  type ProviderMixTemplate,
  type RemoveWorktreeResult,
  type ResolvedLayout,
  type WorkspaceState
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/** Thin typed IPC client for the new-workspace wizard (read-mostly; ADR 0002 — the
 *  wizard trades in provider ids and paths, never credentials). */
export const wizardClient = {
  listPresets: (): Promise<ProviderMixTemplate[]> =>
    getBridge().invoke(TemplateChannels.list) as Promise<ProviderMixTemplate[]>,

  savePreset: (t: ProviderMixTemplate): Promise<unknown> =>
    getBridge().invoke(TemplateChannels.save, t),

  removePreset: (id: string): Promise<unknown> => getBridge().invoke(TemplateChannels.remove, id),

  /** `exact` skips template padding — the painter's pane count IS the layout. */
  resolve: (mix: ProviderCount[], exact = false): Promise<ResolvedLayout> =>
    getBridge().invoke(TemplateChannels.resolve, exact ? { mix, exact: true } : mix) as Promise<ResolvedLayout>,

  browseDir: (): Promise<string | null> =>
    getBridge().invoke(WorkspaceChannels.browseDir) as Promise<string | null>,

  /** One level of directory names, read-only (8.5/03). Refusals come back typed. */
  listDir: (req: ListDirRequest): Promise<DirResult> =>
    getBridge().invoke(FsChannels.listDir, req) as Promise<DirResult>,

  /** Where the folder browser opens before a cwd exists. */
  homeDir: (): Promise<string> => getBridge().invoke(FsChannels.home) as Promise<string>,

  /** Read-only git probe for the folder chip (null = not a repo — perfectly fine). */
  gitQuery: (cwd: string): Promise<GitStatus | null> =>
    getBridge().invoke(GitChannels.query, cwd) as Promise<GitStatus | null>,

  /** Read persisted state for the recent-folder typeahead (read-only). */
  loadState: (): Promise<WorkspaceState | null> =>
    getBridge().invoke(WorkspaceChannels.loadState) as Promise<WorkspaceState | null>,

  /** One isolated git worktree in the repo (Phase-3/03) — random slug/branch. */
  createWorktree: (repo: string): Promise<CreateWorktreeResult> =>
    getBridge().invoke(WorktreeChannels.create, { repo }) as Promise<CreateWorktreeResult>,

  /** Roll back a worktree created by a launch transaction that never opened. */
  removeWorktree: (repo: string, path: string): Promise<RemoveWorktreeResult> =>
    getBridge().invoke(WorktreeChannels.remove, { repo, path, force: true }) as Promise<RemoveWorktreeResult>
}
