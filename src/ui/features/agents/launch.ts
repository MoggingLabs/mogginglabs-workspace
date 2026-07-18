import { BrainChannels } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

// The ONE first-prompt compose seam (ADR 0018, step 06). Whatever launches an
// agent WITH A TASK — the board's card launch, the queue's, any future wizard
// task handoff — composes that first prompt HERE, so orientation policy lives
// in exactly one place. When the anchoring workspace's `brain.orientAtLaunch`
// is ON (the default), the project's repomap is PREPENDED as a fenced block —
// typed VISIBLY into the pane through the existing send path, like the task
// itself: never a hidden env var, never a silent context channel. OFF (or no
// brain, or any failure at all) is ZERO added bytes — orientation is a
// garnish, never a blocker, and a launch must not fail because a map could
// not be drawn. Manual/bare panes never pass through here at all: no task,
// no prompt, no unasked bytes.

export interface ComposeFirstPromptOpts {
  /** The task text (the card's title + notes — user prose, sent verbatim). */
  task: string
  /** The pane's ACTUAL checkout root (the worktree when isolation created one). */
  root: string
  /** The workspace anchoring the launch — whose orientAtLaunch setting governs. */
  anchorWorkspaceId: string | null | undefined
}

export async function composeFirstPrompt(opts: ComposeFirstPromptOpts): Promise<string> {
  try {
    if (!opts.anchorWorkspaceId || !opts.root) return opts.task
    const on = (await getBridge().invoke(BrainChannels.orientGet, opts.anchorWorkspaceId)) === true
    if (!on) return opts.task
    const reply = (await getBridge().invoke(BrainChannels.map, { root: opts.root })) as
      | { ok?: boolean; map?: string }
      | undefined
    if (reply?.ok !== true || typeof reply.map !== 'string' || !reply.map) return opts.task
    return '```repomap\n' + reply.map + '\n```\n\n' + opts.task
  } catch {
    return opts.task // the task always ships; the map never holds it hostage
  }
}
