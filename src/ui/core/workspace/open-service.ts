import { IntegrationsChannels, planFromTemplateTools } from '@contracts'
import { getBridge } from '../ipc/bridge'

/**
 * Open-a-workspace-from-a-template service. The `workspace` feature registers the opener (it
 * owns the controller); the `templates` feature (06b) calls it. A spec = a grid of `paneCount`
 * slots at `cwd`, each slot assigned a provider — the workspace feature creates the workspace,
 * persists the assignments, and launches each slot's CLI (via the agent-launch port). Keeps
 * `templates` from reaching into `workspace` internals.
 */
export interface TemplateWorkspaceSpec {
  name: string
  cwd: string
  paneCount: number
  assignments: string[]
  /** Per-slot cwd overrides (worktree isolation, Phase-3/03). null = workspace cwd. */
  paneCwds?: (string | null)[]
  /** Per-slot swarm roles (Phase-4/01). null = no role. */
  roles?: (string | null)[]
  /** Per-slot remote hosts (Phase-4/05). null = local pane. */
  remotes?: ({ hostId: string; name: string; cwd?: string } | null)[]
  /** Per-slot profile ids (Phase-4/04 picker). null = the provider's default. */
  profileIds?: (string | null)[]
  /** The tool plan's server picks (Phase-8/09) — the workspace arrives scoped to
   *  these (plus the always-on house server). undefined = don't scope (leave the
   *  CLIs' own global config untouched); [] = scoped to house only. */
  tools?: string[]
}

/** Identity of the workspace an open created — enough for callers (e.g. the board,
 *  Phase-3/05) to derive pane ids (ordinal*100+slot) without importing the feature. */
export interface OpenedWorkspace {
  id: string
  ordinal: number
}

let opener: ((spec: TemplateWorkspaceSpec) => OpenedWorkspace | null) | null = null

export function setWorkspaceOpener(fn: (spec: TemplateWorkspaceSpec) => OpenedWorkspace | null): void {
  opener = fn
}

export function openWorkspaceFromTemplate(spec: TemplateWorkspaceSpec): OpenedWorkspace | null {
  const opened = opener ? opener(spec) : null
  // Seed the tool plan (8/09) so the workspace arrives pre-scoped. Only when
  // `tools` is provided — undefined leaves the workspace un-scoped (the CLIs'
  // own global config, unchanged). Fire-and-forget over IPC.
  if (opened && spec.tools) {
    try {
      getBridge().invoke(IntegrationsChannels.planSet, planFromTemplateTools(opened.id, spec.tools))
    } catch {
      /* no bridge (tests) — the workspace still opened */
    }
  }
  return opened
}
