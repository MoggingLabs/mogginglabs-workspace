import type { AgentProfile } from '@contracts'

/**
 * WHICH ACCOUNT is a pane's agent running under?
 *
 * This used to be `profileId?: string`, and `undefined` meant two opposite
 * things at two different call sites: "the provider has no profiles at all"
 * (a launch, which had already resolved order-0 if any existed) and "nobody
 * recorded one" (an adopt or a detection, reading a process this app run never
 * started). Four separate sites then papered over the ambiguity by defaulting
 * to the provider's order-0 profile.
 *
 * That is how one capped-lane event covered EIGHT panes with a card naming an
 * account none of them was necessarily running: after a restart every pane's
 * profile had been re-derived as order-0, so every pane matched, and the copy
 * was composed from index 0 as well.
 *
 * A third state fixes it at the root. `unknown` is not a value to fall back
 * from — it is an answer, and the answer forbids acting on this pane's account.
 */
export type PaneProfile =
  /** A fact: this pane's agent runs under this profile id. */
  | { readonly kind: 'named'; readonly id: string }
  /** A tautology, not a guess: the provider has NO profiles, so there is no id
   *  to name. Only this state may claim the seam's `'default'` usage lane. */
  | { readonly kind: 'none' }
  /** Nobody recorded one. The app must not name, match, or switch this pane's
   *  account — it must say so and leave the pane alone. */
  | { readonly kind: 'unknown' }

export const NO_PROFILE: PaneProfile = { kind: 'none' }
export const UNKNOWN_PROFILE: PaneProfile = { kind: 'unknown' }
export const namedProfile = (id: string): PaneProfile => ({ kind: 'named', id })

/** The id when one is KNOWN, else undefined. The ONE bridge to the boundaries
 *  that still speak `profileId?: string` (the IPC launch request, the agent
 *  session port, the dev shim). Never inverted: `undefined` coming back out of
 *  here means "do not name it", never "use the default". */
export const profileIdOf = (p: PaneProfile): string | undefined => (p.kind === 'named' ? p.id : undefined)

/** A provider's profiles, order-0 first. THE one place this filter+sort lives —
 *  it was written out four times, and every copy was a chance to disagree. */
export const profilesFor = (all: readonly AgentProfile[], providerId: string): AgentProfile[] =>
  all.filter((p) => p.provider === providerId).sort((a, b) => a.order - b.order)

export const orderZeroProfileId = (all: readonly AgentProfile[], providerId: string): string | undefined =>
  profilesFor(all, providerId)[0]?.id

/**
 * We are ABOUT to start the CLI. An omitted request really does resolve to
 * order-0 — that is what main will build the command with — so a launch always
 * knows: `named` or `none`. It can never be `unknown`, and a test pins that.
 */
export function resolveLaunchProfile(requested: string | undefined, mine: readonly AgentProfile[]): PaneProfile {
  // A requested id that is no longer in the list is still what main was handed
  // and still what the process will run under. Recording anything else would
  // make the manifest disagree with the running program.
  if (requested) return namedProfile(requested)
  const zero = mine[0]?.id
  return zero ? namedProfile(zero) : NO_PROFILE
}

/**
 * A process we did NOT start is already running (a daemon-survived session
 * being adopted after a restart, or an agent detected in a pane someone typed
 * into). An omitted record is an absence of RECORD, not a choice — so this can
 * and must answer `unknown`.
 *
 * `none` only when the provider currently has zero profiles: with zero named
 * profiles, "not any named profile" is certain rather than a guess.
 */
export function resolveAdoptedProfile(recorded: string | undefined, mine: readonly AgentProfile[]): PaneProfile {
  if (recorded) return namedProfile(recorded)
  return mine.length === 0 ? NO_PROFILE : UNKNOWN_PROFILE
}

/** Manifest slot encoding. `string` = a recorded fact; `null` = not recorded.
 *  `none` and `unknown` both persist as `null` because the slot has no third
 *  physical value — and on the way back in, a blank slot is `unknown`, which is
 *  the honest reading: the manifest cannot tell us an account nobody wrote. */
export const toPersistedSlot = (p: PaneProfile): string | null => (p.kind === 'named' ? p.id : null)

export const fromPersistedSlot = (v: string | null | undefined): PaneProfile => (v ? namedProfile(v) : UNKNOWN_PROFILE)
