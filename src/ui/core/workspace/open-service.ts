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
}

let opener: ((spec: TemplateWorkspaceSpec) => void) | null = null

export function setWorkspaceOpener(fn: (spec: TemplateWorkspaceSpec) => void): void {
  opener = fn
}

export function openWorkspaceFromTemplate(spec: TemplateWorkspaceSpec): void {
  opener?.(spec)
}
