import type { AgentProfile } from '@contracts'
import type { AgentSessionEnd } from '../../core/agents/agent-session-port'
import type { PaneProfile } from '../../core/agents/pane-profile'

// The two decisions the failover path used to make inline, in a DOM-bound
// module where no test could reach them. Pure, so they can be asserted.

/**
 * Does this session end retire the pane's LAUNCH CONTEXT (the remembered
 * provider/cwd/profile a failover would relaunch with)?
 *
 * Only the ends that kill the SHELL. A profile's env pointers are `export`ed
 * INTO that shell and the failover relaunch types into it, so an AGENT dying
 * inside a living shell must leave the context standing — that is exactly the
 * case the relaunch depends on.
 *
 * Deliberately NOT the same predicate as `endProvesAgentGone`, which also
 * answers true for `'verdict'`. Naming them separately is what stops the two
 * from being conflated later; a test pins that they differ on `'verdict'`.
 */
export function endRetiresLaunchContext(end: AgentSessionEnd): boolean {
  return end === 'pane-gone' || end === 'exited'
}

export type FailoverPick =
  /** Fewer than two profiles — there is nowhere to fail over TO. */
  | { readonly kind: 'too-few' }
  /** We could not name the account this pane is on, so we may not move it. */
  | { readonly kind: 'unidentified' }
  | { readonly kind: 'switch'; readonly current: AgentProfile; readonly next: AgentProfile }

/**
 * Which profile does this pane leave, and which does it go to?
 *
 * The `-1` case is the whole point. This was `Math.max(0, findIndex(...))`, so
 * a pane whose profile could not be resolved silently became index 0 — and the
 * card then read "<order-0 name> hit its usage limit / Continue on <order-1
 * name>". Those two names were never checked against anything; they were the
 * arithmetic of a clamp. An unresolvable pane now refuses instead.
 */
export function pickFailoverTarget(profile: PaneProfile, mine: readonly AgentProfile[]): FailoverPick {
  // Checked FIRST, preserving the existing branch order: with fewer than two
  // profiles the answer is "add another account", whatever we know about this one.
  if (mine.length < 2) return { kind: 'too-few' }
  if (profile.kind !== 'named') return { kind: 'unidentified' }
  const curIdx = mine.findIndex((p) => p.id === profile.id)
  if (curIdx < 0) return { kind: 'unidentified' } // a deleted or renamed id names nothing
  const current = mine[curIdx]
  const next = mine[(curIdx + 1) % mine.length]
  return { kind: 'switch', current, next }
}
