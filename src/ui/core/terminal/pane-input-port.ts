import type { PaneId } from '@contracts'

/**
 * TYPING into a pane, from anywhere that is not the terminal feature. The terminal
 * registers the one real writer; the explorer (11/06) — and any future surface that hands
 * a user something to run — calls through here. A port, so neither feature imports the
 * other (ADR 0004).
 *
 * THE CUSTODY LINE, AND IT IS THE POINT OF THIS FILE. This door types. It does not submit.
 * There is deliberately no `run`, no `submit`, and no way to append a carriage return
 * through it: an agent pane's stdin belongs to the USER (ADR 0010 — we type, they execute).
 * Control characters are stripped here as well as in the quoter, because a filename that
 * carried a newline would otherwise BE an Enter keypress — the one thing this app must
 * never do on someone's behalf.
 */

type Writer = (paneId: PaneId, text: string) => void

let writer: Writer | null = null

/** The terminal feature registers the one real writer. */
export function setPaneWriter(fn: Writer): void {
  writer = fn
}

/** Anything that could forge a keypress. A real path never legitimately contains one. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g') // from a STRING: no raw control byte in this source (the clipboard-port rule)

/** Type `text` into a pane at the cursor. Returns false when no terminal is mounted
 *  (a gallery host, a test) — callers treat that as "nothing to type into", not an error. */
export function typeIntoPane(paneId: PaneId, text: string): boolean {
  if (!writer) return false
  writer(paneId, text.replace(CONTROL_CHARS, ''))
  return true
}
