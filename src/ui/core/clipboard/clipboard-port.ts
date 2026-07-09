import {
  ClipboardChannels,
  quotePathsForShell,
  type ClipboardEntry,
  type ClipboardEnv,
  type ClipboardHistoryEvent,
  type ClipboardSource,
  type RichClipboard,
  type ShellFlavor
} from '@contracts'
import { getBridge } from '../ipc/bridge'

/**
 * The renderer's single door to the clipboard. Every surface — terminal panes, the
 * settings tab, review, the wizard — goes through here, so there is exactly one place
 * that knows the channel names, one place that caches the shell flavor, and one place
 * that decides what a "copy" means.
 *
 * WHY THIS OVERRIDES THE AGENT CLIs. Claude Code, Codex and Gemini all install their own
 * key handling inside the PTY, and each disagrees with the others about Ctrl+C/Ctrl+V.
 * We never negotiate with them: the pane intercepts the keystroke in xterm's
 * `attachCustomKeyEventHandler`, which runs BEFORE any byte is written to the PTY, and
 * returns false. The CLI never sees the key, so our binding wins on every provider and
 * on every platform — identically. That is the whole mechanism.
 */

// ── Preferences ────────────────────────────────────────────────────────────────
// localStorage, not main-side settings: these are renderer-only display choices with no
// security weight, and the settings page already uses `pref()`/`setPref()` this way.

const COPY_ON_SELECT_KEY = 'mogging.clipboard.copyOnSelect'
const HISTORY_ENABLED_KEY = 'mogging.clipboard.historyEnabled'

function pref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : v === '1'
  } catch {
    return fallback
  }
}
function setPref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

/** Copy-on-select is ON by default — it is an explicit product requirement ("select to
 *  copy should work in the terminals"), not an inherited default. The cost is real
 *  (dragging across output overwrites the clipboard), which is why the toggle exists and
 *  why every such copy still lands in history, one click from recovery. */
export const copyOnSelect = (): boolean => pref(COPY_ON_SELECT_KEY, true)
export const setCopyOnSelect = (on: boolean): void => setPref(COPY_ON_SELECT_KEY, on)

export const historyEnabled = (): boolean => pref(HISTORY_ENABLED_KEY, true)

/** Mirrors the pref locally AND tells main to stop RECORDING. Both, always: the local
 *  value survives restart, the main-side flag is what actually stops the ring filling. */
export function setHistoryEnabled(on: boolean): void {
  setPref(HISTORY_ENABLED_KEY, on)
  try {
    void getBridge().invoke(ClipboardChannels.historySet, { enabled: on })
  } catch {
    /* no bridge */
  }
}

/** Push the persisted preference to main at startup — main boots with recording ON, and
 *  a user who turned it off last session must not have this session recorded. */
export function syncHistoryPref(): void {
  setHistoryEnabled(historyEnabled())
}

// ── Shell flavor (cached; asked once) ──────────────────────────────────────────

let envCache: ClipboardEnv | undefined

export async function clipboardEnv(): Promise<ClipboardEnv> {
  if (envCache) return envCache
  try {
    envCache = (await getBridge().invoke(ClipboardChannels.env)) as ClipboardEnv
  } catch {
    // No bridge (unit/gallery hosts). Guess from the UA rather than throw; a wrong guess
    // only ever over-quotes, and the terminal is not reachable in those hosts anyway.
    const win = navigator.userAgent.includes('Windows')
    envCache = { flavor: win ? 'cmd' : 'posix', platform: win ? 'win32' : 'darwin' }
  }
  return envCache
}

/** Quote dropped paths for the pane's shell. Async only because the flavor is fetched
 *  once; every call after the first resolves on the microtask queue. */
export async function quoteDroppedPaths(paths: readonly string[]): Promise<string> {
  const { flavor } = await clipboardEnv()
  return quotePathsForShell(paths, flavor)
}

export function quoteWithFlavor(paths: readonly string[], flavor: ShellFlavor): string {
  return quotePathsForShell(paths, flavor)
}

// ── Reads and writes ───────────────────────────────────────────────────────────

/** Callers fire this and forget (`void copyText(...)`), so it must never reject: without
 *  a bridge `getBridge()` throws SYNCHRONOUSLY inside an async function, which surfaces
 *  as an unhandled rejection rather than anything a caller could catch. */
export async function copyText(text: string, source: ClipboardSource = 'app'): Promise<void> {
  try {
    await getBridge().invoke(ClipboardChannels.write, { text, source })
  } catch {
    /* no bridge (gallery / unit hosts) */
  }
}

/** Remember dropped paths WITHOUT touching the system clipboard. Dropping a file is not
 *  a copy: silently replacing whatever the user had on their clipboard because they
 *  dragged something into a terminal would be a theft they never asked for. The paths
 *  land in the history tab, one click away, and nowhere else. */
export async function recordDrop(paths: string[], quoted: string): Promise<void> {
  try {
    await getBridge().invoke(ClipboardChannels.recordDrop, { files: paths, text: quoted })
  } catch {
    /* history is a convenience; a drop must still insert its path */
  }
}

export async function readText(): Promise<string> {
  try {
    const text = await getBridge().invoke(ClipboardChannels.read)
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

export async function readRich(): Promise<RichClipboard> {
  try {
    return (await getBridge().invoke(ClipboardChannels.readRich)) as RichClipboard
  } catch {
    return { kind: 'text', text: '' }
  }
}

// ── History ────────────────────────────────────────────────────────────────────

export async function history(): Promise<ClipboardEntry[]> {
  try {
    return (await getBridge().invoke(ClipboardChannels.history)) as ClipboardEntry[]
  } catch {
    return []
  }
}

export const restoreEntry = (id: string): Promise<unknown> =>
  getBridge().invoke(ClipboardChannels.restore, { id })
export const removeEntry = (id: string): Promise<unknown> =>
  getBridge().invoke(ClipboardChannels.remove, { id })
export const clearHistory = (): Promise<unknown> => getBridge().invoke(ClipboardChannels.clear)

/** Subscribe to ring changes. The bridge has no `off`, so — as elsewhere in this app —
 *  the returned unsubscribe flips a local flag rather than detaching the listener. */
export function onHistoryChange(cb: (entries: ClipboardEntry[]) => void): () => void {
  let live = true
  try {
    getBridge().on(ClipboardChannels.historyChanged, (payload) => {
      if (live) cb((payload as ClipboardHistoryEvent).entries)
    })
  } catch {
    /* no bridge */
  }
  return () => {
    live = false
  }
}

// ── Paste hygiene ──────────────────────────────────────────────────────────────

/** ESC and CR, built from char codes so this source file never carries a raw control byte. */
const ESC = String.fromCharCode(27)
const CR = String.fromCharCode(13)
const PASTE_START = ESC + '[200~'
const PASTE_END = ESC + '[201~'
const END_SENTINEL_RE = new RegExp(ESC + '\\[201~', 'g')

/**
 * Prepare clipboard text for a PTY.
 *
 * Two problems, both real:
 *
 * 1. NEWLINES EXECUTE. A shell reads `\n` as "run it". Copying three lines out of a
 *    README and pasting them at a prompt runs the first two immediately, before the
 *    user can look at them. Bracketed paste is the fix the terminal ecosystem settled
 *    on: wrapped in ESC[200~ / ESC[201~, a modern shell (and every agent CLI's prompt)
 *    treats the payload as literal text to be edited, not a command to be run.
 *
 * 2. THE SENTINEL IS FORGEABLE. If the pasted text itself contains ESC[201~, it ends the
 *    bracket early and everything after it lands as live keystrokes — a paste-jacking
 *    primitive. Stripping the end sentinel from the payload closes that.
 *
 * `\r\n` and lone `\n` both normalise to CR: a PTY wants carriage returns, and sending
 * CRLF would submit twice.
 */
export function sanitizePaste(text: string, bracketed: boolean): string {
  const body = text.replace(END_SENTINEL_RE, '').replace(/\r?\n/g, CR)
  return bracketed ? PASTE_START + body + PASTE_END : body
}
