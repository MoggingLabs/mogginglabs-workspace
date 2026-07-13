// Named provider profiles (Phase-4/04, simplified). A profile IS a subscription:
// the user supplies a name and the subscription email — nothing else. The env
// POINTER SET (e.g. CLAUDE_CONFIG_DIR=~/.claude-work) that selects WHICH
// self-authenticated account a CLI uses is DERIVED main-side at save time, as is
// the failover order. ADR 0002 is the hard line: the app never reads, stores,
// copies, or echoes a credential — and the persistence boundary REFUSES values
// that look like secrets (deny-list), so the mistake is impossible, not just
// discouraged. The email is a LABEL for the human (which account is this?) —
// never an auth input.

export interface AgentProfile {
  id: string
  name: string
  /** Provider id (e.g. 'claude') this profile applies to. */
  provider: string
  /** Subscription email of the provider account — a label, never a credential. */
  email?: string
  /** Env POINTERS only, DERIVED at save. Names: ^[A-Z][A-Z0-9_]{2,40}$. Values: secret-shaped -> refused. */
  env: Record<string, string>
  /** Failover order: 0 = the default profile. Derived at save (append); swapped by the active switch. */
  order: number
}

/** What the settings form submits: name + subscription email (+ provider pick).
 *  `env`/`order` are optional — when absent, `profiles:save` derives them. */
export interface AgentProfileDraft {
  id: string
  name: string
  provider: string
  email: string
  env?: Record<string, string>
  order?: number
}

export interface ProfileRemoveResult {
  ok: boolean
  reason?: 'referenced' | 'missing' | 'error'
  workspaces?: string[]
}

export interface ProfileActivateResult {
  ok: boolean
  name?: string
  reason?: string
}
