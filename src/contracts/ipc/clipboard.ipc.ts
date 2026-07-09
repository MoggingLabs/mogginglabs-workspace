import type { ShellFlavor } from '../domain/shell-quote'

// Clipboard is a system/app-level capability (Electron's clipboard lives in the main
// process), so its handlers are registered in the app layer (src/main), not in the
// Electron-free @backend. The channels still live here so the preload allowlist and the
// UI share one source of truth.
//
// HISTORY IS IN-MEMORY, MAIN-SIDE ONLY. It is never written to disk. Agent scrollback
// routinely carries API keys, and ADR 0002 keeps terminal content in the process that
// already has it — persisting a copy would create a plaintext secret store outliving
// the app. History dies with the process, by design.

export type ClipboardKind = 'text' | 'image' | 'files'

/** What a copy came from — shown in the history list so a stray secret is traceable. */
export type ClipboardSource = 'terminal' | 'app' | 'system' | 'drop'

/** One entry in the history ring. `text` is the payload for `text`/`files`; an
 *  `image` carries `imageDataUrl` and an empty `text`. `preview` is always safe
 *  to render directly (clamped, control characters stripped). */
export interface ClipboardEntry {
  id: string
  kind: ClipboardKind
  /** The full payload — MAIN-SIDE ONLY. Over IPC (`history`, `historyChanged`) this is
   *  always '' : the list renders `preview`, and copy/delete act by `id`, so the full
   *  text (a password copied from a manager, a screenful of scrollback) has no reason
   *  to ever visit the renderer. */
  text: string
  preview: string
  /** Present only when kind === 'image'. A PNG data URL, downscaled for the list. */
  imageDataUrl?: string
  /** Present only when kind === 'files'. Absolute paths, unquoted. */
  files?: string[]
  /** Byte size of the payload — drives the "too big to keep" rule. */
  bytes: number
  /** Epoch milliseconds. Rendered as a relative + absolute timestamp. */
  at: number
  source: ClipboardSource
}

/** Existing, unchanged in shape: the plain-text write every call site already uses. */
export interface WriteClipboard {
  text: string
  /** Attribution for the history row. Defaults to 'app'. */
  source?: ClipboardSource
}

/** A rich write — exactly one of `text` / `imageDataUrl` is meaningful. */
export interface WriteClipboardEntry {
  kind: 'text' | 'image'
  text?: string
  imageDataUrl?: string
  source?: ClipboardSource
}

/** Dropping a file onto a pane types its path into that pane. It must NOT overwrite the
 *  system clipboard — the user never asked to lose what they had copied, and a drag is
 *  not a copy. The paths are only remembered, so the Clipboard tab can offer them back. */
export interface RecordDroppedPaths {
  files: string[]
  /** The paths as they were typed into the terminal: quoted for that pane's shell. */
  text: string
}

/** What the system clipboard holds right now, in full. */
export interface RichClipboard {
  kind: ClipboardKind
  text: string
  imageDataUrl?: string
  files?: string[]
}

/** main -> renderer: the ring changed (a copy landed, or an entry was removed). */
export interface ClipboardHistoryEvent {
  entries: ClipboardEntry[]
}

export interface ClipboardEntryRef {
  id: string
}

/** Recording is switched off in MAIN, not merely hidden in the renderer: a "stop
 *  remembering what I copy" toggle that still filled a ring in another process would be
 *  a lie the user cannot see through. */
export interface SetClipboardHistory {
  enabled: boolean
}

/** main -> renderer, on request: how this machine's default shell quotes a dropped
 *  path. Derived from `defaultShell()` + `process.platform`, so the renderer never
 *  guesses (and never imports node). */
export interface ClipboardEnv {
  flavor: ShellFlavor
  platform: string
}

/** The ring's cap. Old entries fall off the end. Pinning is deliberately absent:
 *  a pinned secret would outlive the copy that made it. */
export const CLIPBOARD_HISTORY_LIMIT = 100

/** Anything larger is copied to the system clipboard but NOT recorded — a huge
 *  scrollback paste should not be held in memory a second time. */
export const CLIPBOARD_MAX_ENTRY_BYTES = 256 * 1024
