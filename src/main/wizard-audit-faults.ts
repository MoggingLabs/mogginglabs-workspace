import type { AgentProfile } from '@contracts'

/** Main-side failure/delay injection used only by the wizard transaction gate. */
export interface WizardAuditFaultConfig {
  resolveDelayMs?: number
  resolveReject?: boolean
  worktreeFailAt?: number
  /** Stretch every worktree create — the window the mid-launch retarget gate types into. */
  worktreeDelayMs?: number
  planSetReject?: boolean
  fsRejectPaths?: string[]
  fsDelayMsByPath?: Record<string, number>
  profileListSequence?: Array<{ delayMs?: number; profiles: AgentProfile[] }>
}

export interface WizardAuditFaultState extends WizardAuditFaultConfig {
  resolveCalls: number
  worktreeCreateCalls: number
  worktreeRemoveCalls: number
  planSetCalls: number
}

let state: WizardAuditFaultState | null = null

export function setWizardAuditFaults(config: WizardAuditFaultConfig | null): void {
  state = config
    ? {
        ...config,
        fsRejectPaths: [...(config.fsRejectPaths ?? [])],
        fsDelayMsByPath: { ...(config.fsDelayMsByPath ?? {}) },
        profileListSequence: config.profileListSequence?.map((item) => ({
          delayMs: item.delayMs,
          profiles: item.profiles.map((profile) => ({ ...profile, env: { ...profile.env } }))
        })),
        resolveCalls: 0,
        worktreeCreateCalls: 0,
        worktreeRemoveCalls: 0,
        planSetCalls: 0
      }
    : null
}

export function wizardAuditFaults(): WizardAuditFaultState | null {
  return state
}

export const auditDelay = (ms: number | undefined): Promise<void> =>
  ms && ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
