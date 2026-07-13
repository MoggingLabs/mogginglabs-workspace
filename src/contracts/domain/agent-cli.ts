/** One canonical identity vocabulary for launch, detection, settings, and UI. */
export const AGENT_CLI_IDS = ['claude', 'codex', 'gemini', 'aider', 'opencode'] as const

export type AgentCliId = (typeof AGENT_CLI_IDS)[number]

/** Config files are local unless a future remote adapter explicitly implements writes. */
export type AgentExecutionTarget =
  | { kind: 'local' }
  | { kind: 'ssh'; hostId: string }

export function isAgentCliId(value: unknown): value is AgentCliId {
  return typeof value === 'string' && (AGENT_CLI_IDS as readonly string[]).includes(value)
}

export function isAgentExecutionTarget(value: unknown): value is AgentExecutionTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as Record<string, unknown>
  return target.kind === 'local' ||
    (target.kind === 'ssh' && typeof target.hostId === 'string' && /^[\w.-]{1,64}$/.test(target.hostId))
}
