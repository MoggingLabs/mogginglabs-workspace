// Provider-mix templates (Phase-1/06b). A template selects WHICH CLI runs in each pane; the
// CLI self-authenticates (ADR 0002). No credentials cross this boundary — only provider ids
// (an agent id or "shell") + counts.

import type { AgentCliId } from '../domain/agent-cli'

/** A pane slot's provider: an agent id (claude/codex/gemini/aider/opencode), the
 *  literal "shell", or a wizard custom command (`custom:<command>`). This used to be a
 *  bare `string` whose comment described only the first two forms — typing it surfaced
 *  the third (the wizard's custom rows), which is exactly what the alias was hiding. */
export type Provider = AgentCliId | 'shell' | `custom:${string}`

export interface ProviderCount {
  provider: Provider
  count: number
}

export interface ProviderMixTemplate {
  id: string
  name: string
  mix: ProviderCount[]
}

/** A mix resolved to a concrete grid: the total pane count + the provider for each slot. */
export interface ResolvedLayout {
  paneCount: number
  assignments: Provider[]
}
