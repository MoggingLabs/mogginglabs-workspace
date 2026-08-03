import { TerminalChannels, type PaneId } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { getPaneAgentSession } from '../../core/agents/agent-session-port'
import { readPaneBufferTail } from '../../core/terminal/pane-buffer-port'

// Auto-answer claude's folder-trust dialog for APP-LAUNCHED agents (product decision,
// 2026-08-02): the user created a workspace AT that folder and asked the app to run the
// agent in it — that IS the trust declaration, and re-asking per config home turned the
// one-click profile switch into a dialog hunt (trust is stored per home, so the resumed
// pane under the next profile asked again about a folder the user was already working
// in). The answer is typed ONLY into panes whose launch the app performed (every call
// site is a launch path) — a claude the user hand-types at a shell keeps its own dialog:
// the app answers for its own actions, never over the user's shoulder.

/** How long a fresh launch is watched for the dialog (boot + the dialog's paint). */
const WATCH_MS = 45_000
const POLL_MS = 400
/** The LIVE-dialog check stays narrow: a spent dialog higher in scrollback still
 *  carries its "Enter to confirm" line, and a wide read would re-answer it. */
const TAIL_LINES = 14

const TRUST_PROMPT = /trust this folder/i
const CONFIRM_HINT = /Enter to confirm/i

/**
 * Is claude's folder-trust dialog LIVE in this tail? Both halves must show — the
 * question and its "Enter to confirm" hint — so scrollback fragments of an already
 * answered dialog (the hint line scrolls away first) cannot re-trigger an Enter.
 */
export function trustDialogLive(tail: string | null): boolean {
  if (!tail) return false
  return TRUST_PROMPT.test(tail) && CONFIRM_HINT.test(tail)
}

/** No dialog within this long of the watch starting = the folder is already trusted
 *  in this home (an untrusted one paints the dialog right as the TUI comes up). */
const NO_DIALOG_SETTLE_MS = 9_000
/** After answering: the dialog's dismissal + the welcome/history redraw. */
const ANSWER_SETTLE_MS = 1_500

const watchers = new Map<number, number>() // paneId -> generation (a new launch supersedes)
const settledPanes = new Set<number>()

/** Has this pane's launch passed the trust gate (answered, already trusted, or the
 *  launch died)? The switch flow gates its continuation prompt on this — the ONE
 *  signal about the dialog that is not a guess, because the answerer publishes it. */
export function isTrustSettled(paneId: number): boolean {
  return settledPanes.has(paneId)
}

/**
 * Is a trust dialog on screen in this pane RIGHT NOW?
 *
 * The launch cover's second condition, and deliberately NOT `isTrustSettled`. The two
 * answer different questions and only this one is about the human:
 *
 *   this        — "is something standing in front of the TUI?" An observation, true or
 *                 false the instant it is asked.
 *   isTrustSettled — "has the trust GATE been passed?" Which, on a folder whose trust was
 *                 not pre-carried, becomes true only after NO_DIALOG_SETTLE_MS — a nine
 *                 second clock. Holding a cover on that would blur a pane for nine
 *                 seconds after claude was measurably usable at two and a half, and a
 *                 hardcoded wait dressed as readiness is the exact thing the cover exists
 *                 to replace.
 *
 * Claude's trust dialog paints INSIDE the TUI, so the alternate screen can be up while the
 * pane still belongs to a modal the app is about to answer — which is why the check is
 * here at all. `isTrustSettled` remains the right gate for AUTO-SUBMITTING a prompt (the
 * switch's continuation), where being early means typing into that dialog.
 */
export function isPaneTrustDialogLive(paneId: number): boolean {
  return trustDialogLive(readPaneBufferTail(paneId, TAIL_LINES))
}

/** Main PREPARED the trust — it wrote claude's OWN
 *  `projects["<cwd>"].hasTrustDialogAccepted` (agents.ts `trustPrepared`). No dialog can
 *  paint, so the gate is settled the moment the launch is typed and the watcher below
 *  never starts. The two are mutually exclusive at the call site, so this no longer has
 *  to be ordered after it. */
export function markTrustPrepared(paneId: number): void {
  settledPanes.add(paneId)
}

/**
 * Watch a just-launched claude pane and press Enter ONCE if the folder-trust dialog
 * appears ("Yes, I trust this folder" is its preselected option). Marks the pane
 * trust-SETTLED on the answer, or after a dialog-free settle window (already-trusted
 * folder) — and keeps watching either way, so a slow boot's late dialog is still
 * answered. Deliberately NO "already past the gate" text early-exit: on a relaunch
 * the buffer tail still shows the PREVIOUS session's welcome/prompt, and matching it
 * killed the watcher before the new dialog painted — which then sat unanswered under
 * the switch overlay for its whole hold (found live, the fourth buffer-text lesson).
 * Never throws.
 */
export async function autoTrustClaudeLaunch(paneId: number): Promise<void> {
  const gen = (watchers.get(paneId) ?? 0) + 1
  watchers.set(paneId, gen)
  settledPanes.delete(paneId) // a NEW launch's gate is unanswered until proven otherwise
  const started = Date.now()
  const until = started + WATCH_MS
  try {
    while (Date.now() < until && watchers.get(paneId) === gen) {
      if (trustDialogLive(readPaneBufferTail(paneId, TAIL_LINES))) {
        getBridge().send(TerminalChannels.write, { id: paneId as PaneId, data: '\r' })
        await new Promise((r) => setTimeout(r, ANSWER_SETTLE_MS))
        return
      }
      // The launch died — nothing to trust. Graced: the caller's session write and this
      // watcher start in the same tick, and a relaunch's OLD session is already cleared,
      // so an ungraced first look killed the watcher before the launch existed.
      if (Date.now() - started > 2_000 && !getPaneAgentSession(paneId as PaneId)) return
      if (Date.now() - started > NO_DIALOG_SETTLE_MS) settledPanes.add(paneId) // milestone, keep watching
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  } finally {
    if (watchers.get(paneId) === gen) {
      settledPanes.add(paneId)
      watchers.delete(paneId)
    }
  }
}
