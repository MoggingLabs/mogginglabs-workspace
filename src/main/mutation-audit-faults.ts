type MutationKind = 'grant' | 'plan' | 'profile'

interface MutationAuditState {
  delayMs: number
  calls: Record<MutationKind, number>
}

let state: MutationAuditState | null = null

/** Test-only latency injection used to hold real mutation buttons pending. */
export function setMutationAuditDelay(delayMs: number): void {
  if (!process.env.MOGGING_MUTATIONRACE) return
  state = {
    delayMs: Math.max(0, Math.min(5000, Math.floor(delayMs))),
    calls: { grant: 0, plan: 0, profile: 0 }
  }
}

export function mutationAuditCalls(): Readonly<Record<MutationKind, number>> {
  return state?.calls ?? { grant: 0, plan: 0, profile: 0 }
}

export async function waitForMutationAudit(kind: MutationKind): Promise<void> {
  if (!process.env.MOGGING_MUTATIONRACE || !state) return
  state.calls[kind]++
  if (state.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, state!.delayMs))
}
