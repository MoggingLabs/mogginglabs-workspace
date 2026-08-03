import { TerminalChannels, type PaneId } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { readPaneBufferTail } from '../../core/terminal/pane-buffer-port'
import { batchTrapAnswer } from './interrupt-core'

// ANSWERING A PROMPT THE APP READ IN A PANE — the only place that is allowed to.
//
// A pane's output is NOT trustworthy input. Everything an agent prints passes through it:
// the contents of files it reads, pages it fetches, the output of tools it runs, another
// agent's words. So text in that stream is reachable by whoever wrote the repo, the
// dependency, or the web page — and using it to decide what to TYPE inverts the trust:
// the thing being inspected gets to drive the inspector's keyboard.
//
// The app does need to answer two prompts on the user's behalf. Both are answered here,
// under four rules, so the trust inversion is contained instead of scattered:
//
//   1. A WINDOW, opened by the code that CAUSED the prompt to be possible, and closed when
//      that cause is over. Outside its window a prompt is never answered, however
//      convincing the text. Nothing ambient can trigger a keystroke.
//   2. A FIXED answer. The keys are a constant of the prompt, never derived from what was
//      read — no echoing the stream back into the stream.
//   3. A NARROW read. Each prompt declares how much tail may be searched, so a spent
//      prompt scrolled up the buffer cannot be answered a second time.
//   4. ONE file. This is the only module in the app that both reads a pane's output and
//      writes to a pane; `tests/unit/prompt-answer.test.ts` fails if a second appears.
//
// This was not theoretical. The same inversion, one layer up, let a shell's OSC-133 prompt
// mark convince the app that a running agent had died — which authorised typing a whole
// launch command into it (fixed in interrupt-core's endProvesAgentGone). These two are far
// narrower, and now they are bounded by construction rather than by luck.

/** Claude asks BOTH halves — the question and its "Enter to confirm" hint. Requiring both
 *  is what stops a spent dialog scrolled up the buffer (whose hint line goes first) from
 *  being answered twice, and it lives here because recognising a prompt and answering it
 *  are the same responsibility. */
const TRUST_PROMPT = /trust this folder/i
const CONFIRM_HINT = /Enter to confirm/i

/** Is claude folder-trust dialog LIVE in this tail? Exported for the launch cover, which
 *  needs the same reading to decide whether a pane is usable — a READ-only use. */
export function trustDialogLive(tail: string | null): boolean {
  return !!tail && TRUST_PROMPT.test(tail) && CONFIRM_HINT.test(tail)
}

export type PromptId = 'folder-trust' | 'batch-trap'

interface Prompt {
  /** Lines of tail this prompt may be recognised in — deliberately small (rule 3). */
  readonly tailLines: number
  /** The FIXED keystrokes that answer it (rule 2). */
  readonly keys: string
  /** Is it on screen right now? */
  live(tail: string | null): boolean
}

const PROMPTS: Record<PromptId, Prompt> = {
  // Claude's folder-trust dialog. Preselected on "Yes, I trust this folder", and opening a
  // workspace at a folder IS that declaration — but only for a launch the APP performed,
  // which is what the window enforces.
  'folder-trust': { tailLines: 14, keys: '\r', live: (tail) => trustDialogLive(tail) },
  // cmd.exe's "Terminate batch job (Y/N)?" — its own question, raised by the ^C the app
  // itself just sent, which is why its window is the interrupt.
  'batch-trap': { tailLines: 6, keys: 'Y\r', live: (tail) => batchTrapAnswer(tail) !== null }
}

/** paneId -> the prompts currently answerable there. */
const windows = new Map<number, Set<PromptId>>()

/**
 * Open the window in which `id` may be answered in this pane, and return its closer.
 *
 * The caller is asserting that IT caused the prompt to become possible — it launched the
 * agent, or it sent the interrupt. Close it as soon as that is no longer true; the closer
 * is idempotent.
 */
export function openPromptWindow(paneId: number, id: PromptId): () => void {
  const open = windows.get(paneId) ?? new Set<PromptId>()
  open.add(id)
  windows.set(paneId, open)
  return () => {
    const set = windows.get(paneId)
    if (!set) return
    set.delete(id)
    if (set.size === 0) windows.delete(paneId)
  }
}

/** Is this pane inside a window for `id`? (Test/diagnostic seam.) */
export function promptWindowOpen(paneId: number, id: PromptId): boolean {
  return windows.get(paneId)?.has(id) === true
}

/**
 * Answer `id` in this pane IF its window is open and the prompt is really on screen.
 * Returns whether keys were sent. Refuses silently outside the window — that refusal is
 * the whole point, so it is not an error and must not be reported as one.
 */
export function answerPromptIfLive(paneId: number, id: PromptId): boolean {
  if (!promptWindowOpen(paneId, id)) return false
  const prompt = PROMPTS[id]
  if (!prompt.live(readPaneBufferTail(paneId, prompt.tailLines))) return false
  getBridge().send(TerminalChannels.write, { id: paneId as PaneId, data: prompt.keys })
  return true
}

/** The pane is gone: drop its windows so a recycled id inherits no permission. */
export function closePromptWindows(paneId: number): void {
  windows.delete(paneId)
}
