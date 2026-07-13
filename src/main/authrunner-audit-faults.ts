import type { CliCapability } from '@backend/features/integrations'
import type { HostedCliId, McpAuthKind } from '@contracts'

export interface AuthRunnerAuditConnect {
  presetId: string
  clis: HostedCliId[]
  authKind?: McpAuthKind
  baseUrl?: string
}

interface AuthRunnerAuditState {
  authorizeCommands: Record<HostedCliId, string>
  connects: AuthRunnerAuditConnect[]
}

let state: AuthRunnerAuditState | null = null

export function setAuthRunnerAuditCommands(commands: Record<HostedCliId, string> | null): void {
  if (!process.env.MOGGING_AUTHRUNNER) return
  state = commands ? { authorizeCommands: { ...commands }, connects: [] } : null
}

export function authRunnerAuditState(): AuthRunnerAuditState | null {
  return process.env.MOGGING_AUTHRUNNER ? state : null
}

export function authRunnerAuditCapabilities(base: readonly CliCapability[]): readonly CliCapability[] {
  if (!state) return base
  return base.map((capability) => ({
    ...capability,
    authorizeCommand: state!.authorizeCommands[capability.cli]
  }))
}

/** Return null outside the gate; otherwise record and safely bypass config writes. */
export function interceptAuthRunnerConnect(payload: AuthRunnerAuditConnect): {
  ok: true
  results: { cli: HostedCliId; ok: true }[]
} | null {
  if (!state) return null
  const clean: AuthRunnerAuditConnect = {
    presetId: String(payload.presetId),
    clis: [...payload.clis],
    authKind: payload.authKind,
    baseUrl: payload.baseUrl
  }
  state.connects.push(clean)
  return { ok: true, results: clean.clis.map((cli) => ({ cli, ok: true })) }
}
