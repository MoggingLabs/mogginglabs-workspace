// Per-CLI adapters for the agent launcher (Phase-1/06). Pure + Electron-free, and shared with
// the settings-driven auth feature (prompts/features/auth-settings.md). CRITICAL (ADR 0002):
// an adapter builds a launch COMMAND only — it never handles credentials. The CLI
// self-authenticates (proven in Phase-0/03).

export interface AgentAdapter {
  id: string
  name: string
  bin: string // executable to detect on PATH + run
  resumeFlag?: string // appended to resume a prior session (e.g. "--resume", "resume")
}

export const AGENT_ADAPTERS: AgentAdapter[] = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', resumeFlag: '--resume' },
  { id: 'codex', name: 'Codex', bin: 'codex', resumeFlag: 'resume' },
  { id: 'gemini', name: 'Gemini', bin: 'gemini' },
  { id: 'aider', name: 'Aider', bin: 'aider' },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode' }
]

export function findAdapter(id: string): AgentAdapter | undefined {
  return AGENT_ADAPTERS.find((a) => a.id === id)
}
