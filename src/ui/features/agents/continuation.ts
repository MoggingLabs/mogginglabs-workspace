import { TerminalChannels, type PaneId } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

// The continuation prompt (product decision, 2026-08-02): a LIMIT-triggered profile
// switch exists to keep the agent's WORK going — so after the exact-session resume,
// the app submits this into the conversation and the agent simply carries on. The
// wording is deliberate: the limit usually cuts a turn MID-ACTION, so the agent must
// re-verify its last step before continuing (a half-applied edit, an unrun command);
// and it never mentions profiles or accounts — the transcript is identical either
// side of the switch, and the agent has nothing useful to do with that fact. Sent for
// limit triggers only (auto-failover, the accepted offer): the manual ⋯-menu switch
// leaves the first word to the human who chose it.
export const CONTINUATION_PROMPT =
  'Continue exactly where you left off. Your previous turn may have been interrupted ' +
  'mid-task: verify whether your last action completed, redo it if it did not, and then ' +
  'carry the remaining work through to completion. Do not summarize or re-explain ' +
  'earlier work — just continue it.'

/** Text and Enter as SEPARATE writes: claude's paste guard reads text+\r arriving in
 *  one write as pasted content and leaves it unsubmitted in the input box. */
const SUBMIT_GAP_MS = 1200

/** Type the continuation into a resumed pane and submit it. The caller holds the
 *  switch overlay through this, so the injection is never a visible intermediate step. */
export async function typeContinuation(paneId: number): Promise<void> {
  getBridge().send(TerminalChannels.write, { id: paneId as PaneId, data: CONTINUATION_PROMPT })
  await new Promise((r) => setTimeout(r, SUBMIT_GAP_MS))
  getBridge().send(TerminalChannels.write, { id: paneId as PaneId, data: '\r' })
}
