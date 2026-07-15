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
 * TWO ACTORS CAN COPY, AND WE MUST SERVE BOTH. This file used to claim that intercepting
 * the keystroke ahead of the PTY was "the whole mechanism" — that because the CLI never
 * sees Ctrl+C, our binding always wins. That was false, and the falsehood is precisely
 * what hid the bug it caused:
 *
 *   1. THE APP COPIES. xterm owns the mouse, so it owns the selection; the pane reads
 *      `getSelection()` and writes it here. This is the path that already worked.
 *
 *   2. THE CLI COPIES. A CLI that turns on mouse reporting (DECSET ?1000h/?1006h — Claude
 *      Code does, and so does any full-screen TUI) TAKES THE MOUSE AWAY from xterm. xterm
 *      then never builds a selection at all: `getSelection()` is '', our Ctrl+C handler
 *      correctly declines, and the chord falls through to the CLI — which is drawing its
 *      OWN selection and copies it the only way a terminal program can: by emitting
 *      OSC 52. We had no OSC 52 handler, so xterm parsed the sequence and dropped it on
 *      the floor. Claude Code printed "Copied 1234 characters to clipboard" and the
 *      system clipboard never changed. The user pressed Ctrl+V and got nothing.
 *
 * So interception is necessary but NOT sufficient: it only decides who copies, never
 * whether the copy lands. Both paths now converge on `copyText` below — one door, one
 * history attribution, one audit — and `copyText` reports whether the bytes actually
 * reached the system clipboard (main reads them back) instead of assuming they did.
 *
 * This is also why OSC 52 is the answer for EVERY agent rather than a Claude Code patch:
 * it is the universal protocol by which any terminal program copies — Codex, Gemini, vim,
 * tmux, fzf, lazygit — and it is the ONLY way copy can work at all in a remote (ssh) pane,
 * where the program doing the copying is on another machine.
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

// Machine-wide clipboard polling is opt-in. A missing/corrupt preference must fail closed.
export const historyEnabled = (): boolean => pref(HISTORY_ENABLED_KEY, false)

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

/**
 * Callers may still fire this and forget (`void copyText(...)`), so it must never reject:
 * without a bridge `getBridge()` throws SYNCHRONOUSLY inside an async function, which
 * surfaces as an unhandled rejection rather than anything a caller could catch.
 *
 * But it now ANSWERS. `true` means the text is on the system clipboard — main wrote it and
 * read it back to be sure (a Windows clipboard held open by another process makes
 * `writeText` a silent no-op, and Electron reports nothing). `false` means the copy did not
 * happen, and the caller owes the user that truth. Silence here is what let "Copied 1234
 * characters" sit on screen while the clipboard was untouched; a copy must never pass for
 * one that worked.
 */
export async function copyText(text: string, source: ClipboardSource = 'app'): Promise<boolean> {
  try {
    await getBridge().invoke(ClipboardChannels.write, { text, source })
    return true
  } catch {
    return false // no bridge (gallery / unit hosts), or the clipboard refused the write
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

/**
 * The Ctrl+V byte (0x16). Sent to the PTY only when the clipboard holds an IMAGE and no
 * text — see TerminalPane.handleNativePaste. There is no protocol for putting image bytes
 * on a terminal, so the app cannot serve that paste; the agent CLI can, because it reads
 * the system clipboard itself (Claude Code shells out to the Win32 clipboard for exactly
 * this, and Codex/Gemini do the same). It only ever gets the chance if we hand it the
 * keystroke instead of eating it.
 */
export const PASTE_KEY = String.fromCharCode(22)

// ── OSC 52: the CLI's own clipboard ────────────────────────────────────────────

/**
 * OSC 52 is how a terminal PROGRAM copies: it emits `ESC ] 52 ; Pc ; <base64> BEL` and the
 * terminal emulator is expected to put the decoded payload on the system clipboard. It is
 * the universal mechanism — the one vim, tmux, fzf and every agent CLI reach for — and the
 * only one that can work across ssh, where the program doing the copying is on a different
 * machine than the clipboard.
 *
 * WE IMPLEMENT THE WRITE HALF ONLY, AND THAT IS A SECURITY DECISION, NOT AN OMISSION.
 * The protocol also defines a READ: `ESC ] 52 ; c ; ? BEL` asks the terminal to send the
 * clipboard's CONTENTS BACK to the program. Honouring that would hand every process in a
 * pane — and every host you ssh into — a read of everything you have ever copied, which in
 * this app means the passwords and API keys that agents are routinely pasted. No payload
 * inspection makes that safe, so it is refused unconditionally: `{ kind: 'read' }` exists
 * to be recognised and DROPPED, never answered.
 *
 * `Pc` (clipboard / primary / select / cut-buffer) is deliberately ignored. Windows and
 * macOS have exactly one clipboard, and every emulator on them routes all targets to it.
 */
export type Osc52Request = { kind: 'copy'; text: string } | { kind: 'read' } | null

/** Ceiling on ONE OSC 52 payload, in base64 characters (~768 KB of text). Generous for any
 *  real copy — a whole file yanked in vim clears it — and a bound on a runaway or hostile
 *  program shoving megabytes onto the clipboard through a pane. */
export const OSC52_MAX_BASE64 = 1024 * 1024

export function parseOsc52(data: string): Osc52Request {
  const semi = data.indexOf(';') // data is everything after "52;" — i.e. `Pc;Pd`
  if (semi === -1) return null
  const payload = data.slice(semi + 1)
  if (payload === '?') return { kind: 'read' }

  const b64 = payload.replace(/\s+/g, '')
  // An EMPTY payload is spec'd as "clear the selection". We decline: a CLI silently wiping
  // what the user had on their clipboard is a theft, not a copy, and no agent needs it.
  if (!b64 || b64.length > OSC52_MAX_BASE64) return null
  try {
    // atob yields a BINARY string — one char per byte. The payload is UTF-8, so it has to
    // be decoded as such: reading it straight out of atob would mangle every accent, CJK
    // character and emoji that has ever been copied out of an agent's output.
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const text = new TextDecoder().decode(bytes)
    return text ? { kind: 'copy', text } : null
  } catch {
    return null // not valid base64 — a malformed sequence copies nothing
  }
}
