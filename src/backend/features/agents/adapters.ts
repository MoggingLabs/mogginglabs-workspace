// Per-CLI adapters for the agent launcher (Phase-1/06). Pure + Electron-free, and shared with
// the settings-driven auth feature (prompts/features/auth-settings.md). CRITICAL (ADR 0002):
// an adapter builds a launch COMMAND only — it never handles credentials. The CLI
// self-authenticates (proven in Phase-0/03).

export interface AgentAdapter {
  id: string
  name: string
  bin: string // executable to detect on PATH + run
  resumeFlag?: string // appended to resume a prior session (e.g. "--resume", "resume")
  // The provider's OWN documented install one-liner (copy-to-clipboard hint; we
  // NEVER run it — the user installs, ADR 0002 / 6/06 checklist guardrail).
  installHint?: string
}

export const AGENT_ADAPTERS: AgentAdapter[] = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', resumeFlag: '--resume', installHint: 'npm install -g @anthropic-ai/claude-code' },
  { id: 'codex', name: 'Codex', bin: 'codex', resumeFlag: 'resume', installHint: 'npm install -g @openai/codex' },
  { id: 'gemini', name: 'Gemini', bin: 'gemini', installHint: 'npm install -g @google/gemini-cli' },
  { id: 'aider', name: 'Aider', bin: 'aider', installHint: 'python -m pip install aider-install && aider-install' },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode', installHint: 'npm install -g opencode-ai' }
]

export function findAdapter(id: string): AgentAdapter | undefined {
  return AGENT_ADAPTERS.find((a) => a.id === id)
}
