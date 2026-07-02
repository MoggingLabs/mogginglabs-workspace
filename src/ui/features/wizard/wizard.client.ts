import {
  AgentChannels,
  GitChannels,
  TemplateChannels,
  WorkspaceChannels,
  WorktreeChannels,
  type AgentInfo,
  type CreateWorktreeResult,
  type GitStatus,
  type ProviderCount,
  type ProviderMixTemplate,
  type ResolvedLayout,
  type WorkspaceState
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

/** Thin typed IPC client for the new-workspace wizard (read-mostly; ADR 0002 — the
 *  wizard trades in provider ids and paths, never credentials). */
export const wizardClient = {
  detectAgents: (): Promise<AgentInfo[]> =>
    getBridge().invoke(AgentChannels.detect) as Promise<AgentInfo[]>,

  listPresets: (): Promise<ProviderMixTemplate[]> =>
    getBridge().invoke(TemplateChannels.list) as Promise<ProviderMixTemplate[]>,

  savePreset: (t: ProviderMixTemplate): Promise<unknown> =>
    getBridge().invoke(TemplateChannels.save, t),

  removePreset: (id: string): Promise<unknown> => getBridge().invoke(TemplateChannels.remove, id),

  resolve: (mix: ProviderCount[]): Promise<ResolvedLayout> =>
    getBridge().invoke(TemplateChannels.resolve, mix) as Promise<ResolvedLayout>,

  browseDir: (): Promise<string | null> =>
    getBridge().invoke(WorkspaceChannels.browseDir) as Promise<string | null>,

  /** Read-only git probe for the folder chip (null = not a repo — perfectly fine). */
  gitQuery: (cwd: string): Promise<GitStatus | null> =>
    getBridge().invoke(GitChannels.query, cwd) as Promise<GitStatus | null>,

  /** Read persisted state for the recent-folder typeahead (read-only). */
  loadState: (): Promise<WorkspaceState | null> =>
    getBridge().invoke(WorkspaceChannels.loadState) as Promise<WorkspaceState | null>,

  /** One isolated git worktree in the repo (Phase-3/03) — random slug/branch. */
  createWorktree: (repo: string): Promise<CreateWorktreeResult> =>
    getBridge().invoke(WorktreeChannels.create, { repo }) as Promise<CreateWorktreeResult>
}
