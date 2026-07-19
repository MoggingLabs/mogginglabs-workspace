// Cross-feature "show me this file" (ADR 0018/10): the Brain view's graph lens
// DELEGATES to the explorer instead of embedding an editor (ADR 0010's window-
// not-manager stance, extended). Pure pub/sub — the explorer feature registers
// the one real handler (open the dock, scroll the row into view); anything may
// request. The request log exists for the smokes: the seam is the assertable
// thing, not the pixels it moves.

type Handler = (path: string) => void

let handler: Handler | null = null
const log: string[] = []

/** The explorer feature registers the one real reveal. */
export function setExplorerRevealHandler(fn: Handler): void {
  handler = fn
}

/** Ask the explorer to show `path` (absolute). No-op until the explorer mounts. */
export function requestExplorerReveal(path: string): void {
  log.push(path)
  handler?.(path)
}

/** Every path requested this session — the BRAINUX smoke's seam spy (dev only). */
export function explorerRevealLog(): string[] {
  return [...log]
}
