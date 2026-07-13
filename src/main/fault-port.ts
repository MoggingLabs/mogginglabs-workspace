// THE PRODUCTION SIDE OF THE HARNESS'S FAULT SEAMS (audit finding 41).
//
// Some production handlers have to be made to FAIL on demand — it is the only way a gate can
// prove the RECOVERY: does the button come back (finding 39), does a dropped consent write get
// reported instead of faked (33b), does a slow mutation stay visibly pending, does a broken
// store surface a real error. A gate that cannot produce the failure cannot prove the fix.
//
// The injectors that produce those failures used to be imported straight into the handlers, so
// they SHIPPED. out/main/index.js carried MOGGING_ASYNCFAIL, MOGGING_BROWSERZERO,
// MOGGING_MUTATIONRACE and MOGGING_PERSIST_FAIL as live strings: a real, signed install — handed
// one environment variable — would reject its own IPC, hang a spinner forever, drop a consent
// write, or refuse every workspace save. A dormant fault is still a fault, and the env var was
// the door.
//
// So the SEAMS stay and the INJECTORS leave. Every hook below is null in the shipped app; each
// call site costs one null check. src/main/index.dev.ts — the `serve` entry, which is what every
// gate runs (see boot.ts) — installs the real implementations at boot from the *-audit-faults
// modules, which therefore exist only in the DEV module graph. scripts/check-prod-artifact.mjs
// builds the production entry and fails if any of those strings comes back.
//
// This is deliberately NOT a plugin framework: the hooks are a closed, typed list of exactly the
// seams the gates need, and adding one means adding it here, on purpose, in the open.

/** The three mutations whose in-flight pending state the MUTATIONRACE gate holds open. */
export type MutationKind = 'grant' | 'plan' | 'profile'

/** The three persistence moments the PERSISTHEALTH gate must be able to break. */
export type PersistOp = 'open' | 'load' | 'save'

export interface FaultHooks {
  /** Reject / hang / delay a named IPC channel (ASYNCSTATE, finding 39). */
  channel?: (channel: string) => Promise<void>
  /** Hold a real mutation pending so the UI's pending state is observable (MUTATIONRACE). */
  mutation?: (kind: MutationKind) => Promise<void>
  /** TRUE = this `browser:consentSet` must drop the write and admit it (BROWSERZERO). */
  consentSet?: () => boolean
  /** The injected failure message for a persistence op, or null (PERSISTHEALTH). */
  persist?: (op: PersistOp) => string | null
}

let hooks: FaultHooks = {}

/** Dev/test entry ONLY (src/main/harness-install.ts). Production never calls it. */
export function installFaultHooks(next: FaultHooks): void {
  hooks = next
}

/** One line at the top of a covered handler: `await maybeFault(SomeChannels.thing)`. */
export async function maybeFault(channel: string): Promise<void> {
  if (hooks.channel) await hooks.channel(channel)
}

/** One line at the top of a covered mutation handler. */
export async function maybeMutationFault(kind: MutationKind): Promise<void> {
  if (hooks.mutation) await hooks.mutation(kind)
}

/** Consumed inside the `browser:consentSet` handler. Always false in production. */
export function consumeConsentSetFailure(): boolean {
  return hooks.consentSet ? hooks.consentSet() : false
}

/** The message an injected persistence failure should carry, or null. Always null in production. */
export function persistFault(op: PersistOp): string | null {
  return hooks.persist ? hooks.persist(op) : null
}
