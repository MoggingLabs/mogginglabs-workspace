import {
  ExplorerChannels,
  type ExplorerActionResult,
  type ExplorerChangedEvent,
  type ExplorerDockInit,
  type ExplorerResult,
  type ExplorerWatchStats
} from '@contracts'
import { getBridge } from '../../core/ipc/bridge'

// The explorer's typed client — the ONE place this feature names a channel string
// (ADR 0004). `file-tree.ts` never sees it: the dock injects `explorerList` into the
// component, so the component stays channel-free and testable with a stub.

export function explorerList(path: string, showHidden: boolean): Promise<ExplorerResult> {
  return getBridge().invoke(ExplorerChannels.list, { path, showHidden }) as Promise<ExplorerResult>
}

export function explorerInit(): Promise<ExplorerDockInit> {
  return getBridge().invoke(ExplorerChannels.init, undefined) as Promise<ExplorerDockInit>
}

export function persistOpen(open: boolean): void {
  getBridge().send(ExplorerChannels.setOpen, { open })
}

export function persistWidth(width: number): void {
  getBridge().send(ExplorerChannels.setWidth, { width })
}

export function persistShowHidden(showHidden: boolean): void {
  getBridge().send(ExplorerChannels.setShowHidden, { showHidden })
}

// ── The liveness law's renderer half (11/04) ────────────────────────────────
// We declare the WHOLE visible set every time (root + expanded dirs) — never a delta.
// Main diffs it against the live pool, so a watcher can't be leaked by a message we
// forgot to send.

export function watchDirs(dirs: string[]): void {
  getBridge().send(ExplorerChannels.watch, { dirs })
}

/** Nothing is visible any more (the dock closed): tear the whole pool down. */
export function unwatchAll(): void {
  getBridge().send(ExplorerChannels.unwatch, undefined)
}

export function onExplorerChanged(cb: (dirs: string[]) => void): () => void {
  return getBridge().on(ExplorerChannels.changed, (payload) => {
    const dirs = (payload as ExplorerChangedEvent | null)?.dirs
    if (Array.isArray(dirs) && dirs.length) cb(dirs)
  })
}

export function watchStats(): Promise<ExplorerWatchStats> {
  return getBridge().invoke(ExplorerChannels.stats, undefined) as Promise<ExplorerWatchStats>
}

// ── Delegation (11/06) ──────────────────────────────────────────────────────
// We hand the path over; the OS and the user's own tools do the rest. Main guards every
// one of these against the folder we told it we are showing.

/** Tell main which folder is on screen — the boundary its action guard checks against.
 *  `''` when the dock is closed: no root, no actions. */
export function setActionRoot(path: string): void {
  getBridge().send(ExplorerChannels.root, path)
}

export function explorerOpen(path: string): Promise<ExplorerActionResult> {
  return getBridge().invoke(ExplorerChannels.open, path) as Promise<ExplorerActionResult>
}

export function explorerReveal(path: string): Promise<ExplorerActionResult> {
  return getBridge().invoke(ExplorerChannels.reveal, path) as Promise<ExplorerActionResult>
}
