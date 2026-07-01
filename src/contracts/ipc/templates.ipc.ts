// Provider-mix templates (Phase-1/06b). A template selects WHICH CLI runs in each pane; the
// CLI self-authenticates (ADR 0002). No credentials cross this boundary — only provider ids
// (an agent id or "shell") + counts.

/** An agent id (claude/codex/gemini/aider/opencode) or the literal "shell". */
export type Provider = string

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
