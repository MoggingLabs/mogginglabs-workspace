/**
 * Deterministic IPC faults for the ASYNCSTATE gate (audit finding 39).
 *
 * Finding 39 is not a bug, it is eight bugs wearing a trenchcoat: every feature invented its own
 * answer to "what happens when this call fails", and eight different answers means no answer.
 * Proving the fix therefore means making a NAMED channel fail on demand — not stubbing a service,
 * not mocking a module, but rejecting the same handler the real UI really calls.
 *
 * Three faults, because the audit named three distinct failures:
 *   reject   — the call throws. Does a visible, actionable error appear, and do the controls
 *              come back, or does the button stay disabled forever?
 *   hang     — the call never settles. Does the spinner ever give up? ("Cost…" did not.)
 *   delay    — a per-channel FIFO of delays, so call #1 can be made slower than call #2 and we
 *              can prove the stale answer loses. That is the only way to test a generation guard:
 *              you have to make the past arrive after the future.
 *
 * Unarmed, every function here is a no-op on a cold branch. Nothing is imported into production
 * behaviour; the env var is the only door.
 */

interface AsyncFaultState {
  reject: Set<string>
  hang: Set<string>
  /** channel → FIFO of delays. Call N to that channel waits delays[N]. */
  delaySequenceMs: Map<string, number[]>
}

let state: AsyncFaultState | null = null
let parsed = false

export interface AsyncFaultConfig {
  reject?: string[]
  hang?: string[]
  delaySequenceMs?: Record<string, number[]>
}

/** Arm (or, with null, disarm) the faults from the gate. */
export function setAsyncAuditFaults(config: AsyncFaultConfig | null): void {
  parsed = true
  if (!config) {
    state = null
    return
  }
  state = {
    reject: new Set(config.reject ?? []),
    hang: new Set(config.hang ?? []),
    delaySequenceMs: new Map(Object.entries(config.delaySequenceMs ?? {}).map(([k, v]) => [k, [...v]]))
  }
}

/** MOGGING_ASYNCFAIL="review:diff,usage:cost@hang" — a comma list; `@hang` means never settle. */
function fromEnv(): AsyncFaultState | null {
  const raw = process.env.MOGGING_ASYNCFAIL
  if (!raw) return null
  const reject = new Set<string>()
  const hang = new Set<string>()
  for (const token of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (token.endsWith('@hang')) hang.add(token.slice(0, -'@hang'.length))
    else reject.add(token)
  }
  return { reject, hang, delaySequenceMs: new Map() }
}

/**
 * One line at the top of a covered handler: `await maybeAsyncFault(SomeChannels.thing)`.
 * Costs a null check when unarmed.
 */
export async function maybeAsyncFault(channel: string): Promise<void> {
  if (!parsed) {
    state = fromEnv()
    parsed = true
  }
  if (!state) return

  const seq = state.delaySequenceMs.get(channel)
  const delay = seq && seq.length ? seq.shift() : undefined
  if (delay) await new Promise((r) => setTimeout(r, delay))

  // Deliberate: a promise that never settles. This is what a hung backend feels like, and the
  // UI's only correct answer is a timeout of its own.
  if (state.hang.has(channel)) return new Promise<void>(() => {})

  if (state.reject.has(channel)) {
    throw new Error(`Injected failure for ${channel} (async-audit-faults)`)
  }
}
