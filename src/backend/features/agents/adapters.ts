// Per-CLI adapters for the agent launcher (Phase-1/06). Pure + Electron-free, and shared with
// the settings-driven auth feature (prompts/features/auth-settings.md). CRITICAL (ADR 0002):
// an adapter builds a launch COMMAND only — it never handles credentials. The CLI
// self-authenticates (proven in Phase-0/03).

import type { AgentCliId, AgentSignInTarget } from '@contracts'
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

/**
 * The provider's OWN sign-in verb, for a pane that already exists.
 *
 * Install and sign-in are two moments, not one: a CLI cannot be logged in before it has a
 * terminal to show its own browser hand-off in. So setup installs, the workspace opens, and
 * only then does a pane offer this — a command the app TYPES and never interprets. ADR 0002
 * unchanged: no credential crosses this boundary, and a provider that authenticates by API
 * key (aider) returns null rather than being handed an invented command.
 */
export function signInTarget(id: string): AgentSignInTarget | null {
  // Through the declared interface, not the `as const` literal union: aider carries no
  // `signIn` key at all, so the union has members without the property and a direct read
  // does not typecheck. The interface is the shape this function is written against.
  const definition: AgentCliDefinition | undefined = AGENT_CLI_REGISTRY.find((candidate) => candidate.id === id)
  if (!definition?.signIn) return null
  const { inSession, shell } = definition.signIn
  if (!inSession && !shell) return null
  return { agentId: definition.id, name: definition.name, inSession, shell }
}
