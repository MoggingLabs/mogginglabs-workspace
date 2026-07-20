import { BrainChannels, REPOMAP_DEFAULT_BUDGET, REPOMAP_MIN_BUDGET } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

// The ONE first-prompt compose seam (ADR 0018, step 06; revision D adds the
// second section). Whatever launches an agent WITH A TASK — the board's card
// launch, the queue's, any future wizard task handoff — composes that first
// prompt HERE, so orientation policy lives in exactly one place. When the
// anchoring workspace's `brain.orientAtLaunch` is ON (the default), the
// orientation block is PREPENDED as fenced sections — typed VISIBLY into the
// pane through the existing send path, like the task itself: never a hidden
// env var, never a silent context channel. OFF (or no brain, or any failure at
// all) is ZERO added bytes — orientation is a garnish, never a blocker, and a
// launch must not fail because a map could not be drawn. Manual/bare panes
// never pass through here at all: no task, no prompt, no unasked bytes.
//
// Revision D: a second fenced section — "what the team knows" — carries the
// task's top recall hits as `name — description` lines (titles + descriptions
// ONLY, never a body byte: the pane can get_memory what it wants), closed by
// an attribution stamp naming the mode (exact/hybrid) and generation. It rides
// `brain.recallAtLaunch` (default ON) and is ACTIVE ONLY under orientAtLaunch.
// ONE character budget — the map's own constant — binds both sections
// together: memories fill first (they are cheaper than signatures), the map
// takes what remains and yields entirely below its own minimum. Recall may
// never inflate spawn cost past 06's ceiling.

export interface ComposeFirstPromptOpts {
  /** The task text (the card's title + notes — user prose, sent verbatim). */
  task: string
  /** The pane's ACTUAL checkout root (the worktree when isolation created one). */
  root: string
  /** The workspace anchoring the launch — whose orientAtLaunch setting governs. */
  anchorWorkspaceId: string | null | undefined
}

interface RecallHitLite {
  name?: unknown
  description?: unknown
}

/**
 * The "what the team knows" section CONTENT (lines + attribution stamp, no
 * fence): whole `name — description` lines greedily filled into `budget`, the
 * stamp reserved first so it always closes the section. Empty string = no
 * section (no hits fit, or none existed). Pure — exported for the BRAINRECALL
 * smoke's budget arithmetic.
 */
export function renderRecallSection(
  hits: readonly RecallHitLite[],
  mode: string,
  generation: number,
  budget: number
): string {
  const stamp = `[team-memory: generation ${generation}, ${mode}]`
  const room = budget - stamp.length - 1 // the newline joining lines to stamp
  const lines: string[] = []
  let used = 0
  for (const h of hits) {
    const name = typeof h.name === 'string' ? h.name : ''
    if (!name) continue
    const description = typeof h.description === 'string' ? h.description : ''
    const line = description ? `${name} — ${description}` : name
    if (used + line.length + 1 > room) continue // whole lines only, like the map
    lines.push(line)
    used += line.length + 1
  }
  return lines.length ? `${lines.join('\n')}\n${stamp}` : ''
}

export async function composeFirstPrompt(opts: ComposeFirstPromptOpts): Promise<string> {
  try {
    if (!opts.anchorWorkspaceId || !opts.root) return opts.task
    const on = (await getBridge().invoke(BrainChannels.orientGet, opts.anchorWorkspaceId)) === true
    if (!on) return opts.task

    // Build-on-open (the launch door): if this checkout has never been indexed, kick
    // ONE build so the NEXT launch is oriented. Fire-and-forget — orientation is a
    // garnish and a launch must never block on a parse; this launch uses whatever is
    // already built (nothing, the very first time). A no-op once built.
    void getBridge().invoke(BrainChannels.ensureBuilt, { root: opts.root }).catch(() => undefined)

    // Revision D: recall first — memories are cheaper than signatures, so they
    // take their (small) share of the ONE budget and the map yields the rest.
    let memSection = ''
    try {
      const recallOn = (await getBridge().invoke(BrainChannels.recallGet, opts.anchorWorkspaceId)) === true
      if (recallOn) {
        const r = (await getBridge().invoke(BrainChannels.recall, {
          root: opts.root,
          task: opts.task,
          workspaceId: opts.anchorWorkspaceId
        })) as { ok?: boolean; mode?: string; generation?: number; memories?: RecallHitLite[] } | undefined
        if (r?.ok === true && Array.isArray(r.memories) && r.memories.length) {
          memSection = renderRecallSection(
            r.memories,
            typeof r.mode === 'string' ? r.mode : 'exact',
            typeof r.generation === 'number' ? r.generation : 0,
            REPOMAP_DEFAULT_BUDGET
          )
        }
      }
    } catch {
      memSection = '' // recall never holds the map (or the task) hostage
    }

    const mapBudget = REPOMAP_DEFAULT_BUDGET - memSection.length
    let mapBlock = ''
    if (mapBudget >= REPOMAP_MIN_BUDGET) {
      const reply = (await getBridge().invoke(BrainChannels.map, { root: opts.root, budget: mapBudget })) as
        | { ok?: boolean; map?: string }
        | undefined
      if (reply?.ok === true && typeof reply.map === 'string' && reply.map) {
        mapBlock = '```repomap\n' + reply.map + '\n```\n\n'
      }
    }
    const memBlock = memSection ? '```team-memory\n' + memSection + '\n```\n\n' : ''
    return mapBlock + memBlock + opts.task
  } catch {
    return opts.task // the task always ships; orientation never holds it hostage
  }
}
