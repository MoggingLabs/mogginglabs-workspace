import type { PaneId } from '@contracts'
import { getPaneFailoverOffer, setPaneFailoverOffer } from '../../core/agents/failover-offer-port'
import { whenPaneAgentReady } from '../../core/terminal/liveness-port'
import { isPaneTrustDialogLive, isTrustSettled } from './auto-trust'

// WHEN IS A JUST-LAUNCHED AGENT ACTUALLY USABLE?
//
// The launch cover holds a pane from the moment the app COMMITS to launching until this
// module says the agent will accept input — so the shell prompt, the build, and the
// injected command line are never something the user has to watch. Everything here is a
// REAL signal from the CLI: no step counter, no progress bar, no elapsed-time guess. If a
// provider has no such signal it gets NO cover, because a loading screen that ends on a
// timer is a more confident lie than showing nothing at all.
//
// ── Per-CLI evidence (researched 2026-08-03; revisit when a CLI ships a real signal) ──
//
// claude — YES, via alternate-screen entry plus its first painted frame.
//   Its `SessionStart` hook LOOKS like the answer and is not: it is dispatched before the
//   Ink app mounts and before auth validation, fire-and-forget (read out of the shipped
//   bundle), so it fires while startup is still eating keystrokes. What does hold up is
//   the alternate screen. Claude has been fullscreen-by-default with no opt-out since
//   v2.1.89 (anthropics/claude-code#42670, #38283), and the measurement in
//   scripts/measure-agent-readiness.mjs — probe tokens typed into a booting CLI every
//   250ms, then checked for SURVIVAL in its input box — puts `?1049h` at 2.0-2.6s across
//   five runs, always after the last keystroke claude dropped (1.79-2.36s). The earlier
//   markers this repo also recognises were measured and REJECTED: bracketed paste and
//   mouse tracking (1.3-1.8s) and the cursor-shape query (1.4-1.9s) all fire while input
//   is still being swallowed. Community confirms there is nothing better on offer —
//   claude-code#23513 ("tmux send-keys race", keystrokes lost) was closed not-planned
//   with no readiness signal proposed.
//
// codex — NO. Its `sessionStart` hook is drained inside turn execution (hook_runtime.rs
//   -> session/turn.rs), i.e. AFTER the user's first prompt, which is fatal for a signal
//   that has to precede input. Its alternate screen is configuration-dependent
//   (`--no-alt-screen`, and it auto-skips under Zellij), so the byte we rely on for
//   claude is not reliably emitted at all. Third-party tooling screen-scrapes its status
//   line and documents that as "best-effort ... a signal, not a guarantee" (codex-cli-farm).
//
// gemini — NO (unverified rather than disproven). `SessionStart` is advisory-only, and
//   its alternate buffer defaults to FALSE, so the marker is not observable by default.
//   The dispatch site could not be read directly. Unverified is not a licence to guess.
//
// opencode — NO. There is no `app.ready`/`tui.ready` in its documented event bus, and
//   opencode#24847 shows rendered != input-ready: a failed plugin leaves the TUI in a
//   "zombie state" with the input handler never wired.
//
// aider — NO, definitively. No hook system, no alternate screen, no RPC; its one
//   notification fires after a response, never at startup.

/**
 * Longest a launch cover may hold a pane. A SAFETY NET, never a schedule.
 *
 * It spans the whole commit-to-usable window — the cover goes up when the app decides to
 * launch, so it also covers the pane's liveness wait and the command build — and 15s is
 * generous for that: the build is sub-second in practice and boot is the measured 2-3s.
 *
 * Sized DOWN from 30s deliberately. The ceiling is only ever reached when a launch fails
 * outright (the CLI exits, or never draws), and that is exactly the case where a long
 * ceiling is worst: it leaves a blurred, uninteractable pane sitting on a failure the user
 * can already see is a failure. Fifteen seconds is the same bound as the pane-live and
 * spawn-settled waits this path already rides, so a launch cannot outlast the waits that
 * feed it. Found by running the profile switch against a real CLI that could not start:
 * the pane stayed covered long after there was anything to wait for.
 */
export const LAUNCH_COVER_CEILING_MS = 15_000

/** How often the trust check is re-read once the TUI is up. Only ever runs in the rare
 *  case where the dialog is still on screen — the prepared path is true on the first look. */
const TRUST_POLL_MS = 120

/** Does a launch of this provider get covered? See the evidence block above. */
export function coversLaunch(provider: string, remote: boolean): boolean {
  // Remote launches ride SSH into a shell this app does not own; the readiness scan reads
  // the local pane's stream, and the far side's own boot is not something we measured.
  return provider === 'claude' && !remote
}

/** Poll an observation until it holds, or the deadline passes. The deadline is the only
 *  clock in here; the predicate is always a real fact about the pane. */
async function until(holds: () => boolean, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (holds()) return true
    await new Promise((r) => setTimeout(r, TRUST_POLL_MS))
  }
  return false
}

/**
 * The two readiness answers a launch needs, from ONE waiter on the TUI signal.
 *
 * They are different questions and conflating them costs real seconds:
 *
 *   usable — may the HUMAN have the pane back? The TUI has taken over and painted, and
 *     nothing (a folder-trust dialog) stands in front of it. This is what lifts the cover.
 *   promptable — may the APP auto-submit a prompt into it? Everything above, plus the
 *     trust gate having SETTLED. Being early here means typing a continuation into a
 *     dialog, which is a real bug the switch flow hit; being early on `usable` costs
 *     nothing, because a dialog that appears later is answered for the user anyway.
 *
 * One `whenPaneAgentReady` call, because registering a second waiter for the same pane
 * supersedes the first — the two promises must be derived, never independently awaited.
 * Both are bounded by the same deadline; reaching it hands the pane over rather than
 * holding it.
 */
export function paneReadiness(
  paneId: number,
  ceilingMs: number
): { usable: Promise<boolean>; promptable: Promise<boolean> } {
  const deadline = Date.now() + ceilingMs
  const tui = whenPaneAgentReady(paneId, ceilingMs)
  const usable = tui.then((ok) => (ok ? until(() => !isPaneTrustDialogLive(paneId), deadline) : false))
  const promptable = usable.then((ok) => (ok ? until(() => isTrustSettled(paneId), deadline) : false))
  return { usable, promptable }
}

/** A raised launch cover, or an inert stand-in for a launch that gets none. */
export interface LaunchCover {
  /** Resolves true when the agent will accept an AUTO-SUBMITTED prompt, false at the
   *  ceiling. Strictly later than the lift (see paneReadiness). Null when uncovered — the
   *  provider has no readiness signal, so there is nothing truthful to await. */
  readonly ready: Promise<boolean> | null
  /** The launch happened: hold the cover until the agent is usable, then lift it. */
  settle(): void
  /** Nothing was typed after all — lift immediately. */
  cancel(): void
}

/** The do-nothing cover. What an uncovered provider gets, and what a caller holds before
 *  it has decided to raise one — so `cancel()`/`settle()` are always safe to call. */
export const NO_LAUNCH_COVER: LaunchCover = { ready: null, settle: () => {}, cancel: () => {} }

/**
 * Cover a pane because the app has COMMITTED to launching an agent into it.
 *
 * Raised at the commitment, not at the write — everything between them (the pane's first
 * shell prompt, the liveness wait, the command build, and the injected command line
 * itself) is app machinery the user did not ask to watch. It comes down on the measured
 * readiness signal alone.
 *
 * ONE owner for a sequence that used to be inlined: register the waiter, raise the cover,
 * decide who owns it, clear it exactly once. Three call sites need it — the two delivery
 * paths and the profile switch — and three hand-written copies is how one of them ends up
 * subtly wrong. (It already did: the spawn-run path shipped with no cover at all.)
 *
 * Ordering is load-bearing. The readiness waiter is registered BEFORE this returns, so no
 * caller can type a command in the window before one exists — a marker that arrives with
 * nobody listening is simply lost, and the cover would then sit until its ceiling on a
 * pane that was ready all along.
 *
 * The pane need not exist yet. The offer port replays on subscribe and `mountPaneOffer`
 * subscribes in the pane's constructor, so a pane BORN into a cover paints it on mount —
 * which is exactly what the spawn-run path needs, since its command is typed by the
 * daemon as the shell's very first act.
 */
export function beginLaunchCover(paneId: number, provider: string, remote: boolean, label: string): LaunchCover {
  // The one place the claude-only rule is enforced. A provider with no readiness signal
  // gets an inert handle, so its call sites read identically and cannot accidentally
  // raise a cover that could only ever end on a timeout.
  if (!coversLaunch(provider, remote)) return NO_LAUNCH_COVER

  const { usable, promptable } = paneReadiness(paneId, LAUNCH_COVER_CEILING_MS)
  // A caller already running its own overlay (the profile switch narrates its interrupt)
  // keeps ownership: this neither replaces its copy nor clears it out from under it.
  const owned = !getPaneFailoverOffer(paneId as PaneId)
  if (owned) setPaneFailoverOffer(paneId as PaneId, { state: 'launching', title: '', nextName: label })

  let done = false
  const drop = (): void => {
    if (done) return
    done = true
    if (owned) setPaneFailoverOffer(paneId as PaneId, null)
  }
  return {
    // The cover comes down on `usable` — the moment the human could type. `ready` is the
    // later, stricter answer, and only a caller auto-submitting a prompt should wait for it.
    ready: promptable,
    settle: () => void usable.then(drop),
    cancel: drop
  }
}
