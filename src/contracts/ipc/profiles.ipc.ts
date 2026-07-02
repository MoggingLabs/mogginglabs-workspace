// Named provider profiles (Phase-4/04). A profile is a POINTER SET — env vars whose
// values are directories/files/flags (e.g. CLAUDE_CONFIG_DIR=~/.claude-work) that
// select WHICH self-authenticated account a CLI uses. ADR 0002 is the hard line:
// the app never reads, stores, copies, or echoes a credential — and the persistence
// boundary REFUSES values that look like secrets (deny-list), so the mistake is
// impossible, not just discouraged.

export interface AgentProfile {
  id: string
  name: string
  /** Provider id (e.g. 'claude') this profile applies to. */
  provider: string
  /** Env POINTERS only. Names: ^[A-Z][A-Z0-9_]{2,40}$. Values: secret-shaped -> refused. */
  env: Record<string, string>
  /** Failover order: 0 = the default profile. */
  order: number
}
