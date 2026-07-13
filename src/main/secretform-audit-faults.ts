/**
 * Main-side failure injection for the SECRETFORMS gate (audit finding 35).
 *
 * The forms that take a secret are only interesting when the round trip REFUSES —
 * that is the branch that used to eat a pasted key. Every real refusal path
 * (a locked keychain, a settings store that isn't up, a name the registry rejects)
 * is either unreachable on a healthy machine or destructive to stage for real, so
 * the gate injects them at the two seams that matter:
 *
 *   • vaultStore()  — the ONE write behind service keys, usage keys AND webhook
 *     URLs (vault.ts). Three of the four forms, one seam.
 *   • serversSave   — the register step of the add-server form (mcp-manager.ts).
 *     It never touches the vault, which is exactly why a failure there ORPHANS the
 *     env literals the form vaulted on its way in.
 *
 * INERT unless armed: `state` is null in production, so each seam costs one null
 * check on a path that is already doing IPC. Arming is refused outright unless the
 * gate's own env var is set — a stray call in a shipped build cannot fail a save.
 */
interface SecretFormFaultState {
  /** How many of the NEXT vaultStore() writes must fail. */
  vaultWriteFailures: number
  /** How many of the NEXT serversSave calls must fail. */
  serverRegisterFailures: number
  /** Every write/register that reached the seam — the double-submit assertion counts these. */
  vaultWrites: number
  serverRegisters: number
}

let state: SecretFormFaultState | null = null

/** Production can never arm this, whatever calls it. */
const armed = (): SecretFormFaultState | null => {
  if (!process.env.MOGGING_SECRETFORMS) return null
  state ??= { vaultWriteFailures: 0, serverRegisterFailures: 0, vaultWrites: 0, serverRegisters: 0 }
  return state
}

/** Turn the seams ON with nothing failing — the counters start, behavior does not change. */
export function armSecretFormAudit(): void {
  armed()
}

/** The next `count` vault writes refuse (service keys, usage keys, webhook URLs). */
export function failNextVaultWrites(count = 1): void {
  const s = armed()
  if (s) s.vaultWriteFailures = count
}

/** The next `count` `serversSave` calls refuse — AFTER the form has vaulted its literals. */
export function failNextServerRegister(count = 1): void {
  const s = armed()
  if (s) s.serverRegisterFailures = count
}

/** Consumed inside vault.ts's vaultStore(). True = this write must fail. */
export function consumeVaultWriteFailure(): boolean {
  if (!state) return false
  state.vaultWrites++
  if (state.vaultWriteFailures <= 0) return false
  state.vaultWriteFailures--
  return true
}

/** Consumed inside mcp-manager.ts's serversSave handler. True = this register must fail. */
export function consumeServerRegisterFailure(): boolean {
  if (!state) return false
  state.serverRegisters++
  if (state.serverRegisterFailures <= 0) return false
  state.serverRegisterFailures--
  return true
}

/** Real main-side call counts — the gate proves a double click fires ONE vault write. */
export function secretFormAuditCounts(): { vaultWrites: number; serverRegisters: number } {
  return { vaultWrites: state?.vaultWrites ?? 0, serverRegisters: state?.serverRegisters ?? 0 }
}

export function resetSecretFormAuditFaults(): void {
  state = null
}
