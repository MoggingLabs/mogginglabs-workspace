// Per-CLI adapters for the agent launcher (Phase-1/06). Pure + Electron-free, and shared with
// the settings-driven auth feature (prompts/features/auth-settings.md). CRITICAL (ADR 0002):
// an adapter builds a launch COMMAND only — it never handles credentials. The CLI
// self-authenticates (proven in Phase-0/03).

import type { AgentCliId } from '@contracts'
import { AGENT_CLI_REGISTRY, type AgentCliDefinition } from '../../core/agent-clis'

export interface AgentAdapter {
  id: AgentCliId
  name: string
  bin: string // executable to detect on PATH + run
  resumeFlag?: string // appended to resume a prior session (e.g. "--resume", "resume")
  resumeTakesSessionId?: boolean // the flag accepts a session id — exact-session resume
  // The provider's OWN documented install one-liner. Copyable everywhere; Settings
  // § Providers can also RUN it (install.ts) in an ephemeral background pty on an
  // explicit user click — verbatim, under the user's login, never parsed or
  // elevated. Credentials still never cross this boundary (ADR 0002).
  installHint?: string
}

export const AGENT_ADAPTERS: AgentAdapter[] = AGENT_CLI_REGISTRY.map((definition: AgentCliDefinition) => ({
  id: definition.id,
  name: definition.name,
  bin: definition.bin,
  resumeFlag: definition.resumeArgs?.[0],
  resumeTakesSessionId: definition.resumeTakesSessionId,
  installHint: definition.installHint
}))

export function findAdapter(id: string): AgentAdapter | undefined {
  return AGENT_ADAPTERS.find((a) => a.id === id)
}
