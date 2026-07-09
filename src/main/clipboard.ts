import { createHash } from 'node:crypto'
import { BrowserWindow, clipboard, ipcMain, nativeImage } from 'electron'
import {
  ClipboardChannels,
  CLIPBOARD_HISTORY_LIMIT,
  CLIPBOARD_MAX_ENTRY_BYTES,
  shellFlavor
} from '@contracts'
import type {
  ClipboardEntry,
  ClipboardEntryRef,
  ClipboardEnv,
  ClipboardSource,
  RecordDroppedPaths,
  RichClipboard,
  SetClipboardHistory,
  WriteClipboard,
  WriteClipboardEntry
} from '@contracts'
import { defaultShell } from '@backend/platform/shell'

// System clipboard IPC. App-layer wiring: Electron's clipboard is a main-process API,
// and @backend must stay Electron-free — so this registers directly on ipcMain rather
// than through a backend FeatureModule.
//
// The history ring lives HERE, in memory, and is never written to disk (see the ADR
// 0002 note in clipboard.ipc.ts). ONE ring serves every window: the clipboard is a
// machine-wide resource, so a per-window ring would immediately disagree with itself.

const HISTORY: ClipboardEntry[] = []
let seq = 0

/** Recording, not merely display. When the user turns history off, `record` becomes a
 *  no-op here — the ring is never filled in the first place. The renderer's toggle is a
 *  mirror of this flag, not the flag itself. */
let recording = true

/** Watcher cadence. Fast enough that a copy made in another app is already in the tab
 *  by the time you switch to it; slow enough that the 32x32 hash below costs nothing. */
const POLL_MS = 800

/** Control characters, minus tab (09) and newline (0a) — those are what make a
 *  multi-line snippet recognisable in the list. Built via `new RegExp` so the source
 *  file never carries a raw control byte. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f]', 'g')

/** Electron exposes no cross-platform clipboard-change event, so we poll. Text is cheap
 *  to read. Images are NOT — a full-resolution `toBitmap()` on a 4K screenshot copies
 *  ~33 MB, and at 800 ms that is a standing memory-bandwidth leak. Instead we fingerprint
 *  a 32x32 downscale (4 KB), which is still content-sensitive: two different screenshots
 *  with identical dimensions produce different hashes. */
function imageSignature(): string {
  const img = clipboard.readImage()
  if (img.isEmpty()) return ''
  const { width, height } = img.getSize()
  const thumb = img.resize({ width: 32, height: 32, quality: 'good' })
  return `${width}x${height}:${createHash('sha1').update(thumb.toBitmap()).digest('hex')}`
}

let lastText = ''
let lastImageSig = ''
let timer: NodeJS.Timeout | undefined

function broadcast(): void {
  const payload = { entries: HISTORY.slice() }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(ClipboardChannels.historyChanged, payload)
  }
}

/** Renderable, bounded, and free of the control characters that would otherwise let a
 *  copied payload move the cursor or forge lines inside the settings list. */
function makePreview(text: string): string {
  const stripped = text.replace(CONTROL_CHARS, '')
  return stripped.length > 400 ? stripped.slice(0, 400) + '…' : stripped
}

function record(entry: Omit<ClipboardEntry, 'id' | 'at' | 'preview'> & { preview?: string }): void {
  if (!recording) return
  if (entry.bytes > CLIPBOARD_MAX_ENTRY_BYTES) return // copied, but too big to hold twice
  if (entry.kind === 'text' && !entry.text.trim()) return // whitespace-only: noise

  // Re-copying an identical payload moves the existing row to the top rather than
  // growing a run of duplicates — the ring holds 100 DISTINCT things, not 100 events.
  const key = entry.kind === 'image' ? entry.imageDataUrl : entry.text
  const dupe = HISTORY.findIndex((e) => (e.kind === 'image' ? e.imageDataUrl : e.text) === key)
  if (dupe !== -1) HISTORY.splice(dupe, 1)

  HISTORY.unshift({
    ...entry,
    preview: entry.preview ?? makePreview(entry.text),
    id: `clip-${++seq}`,
    at: Date.now()
  })
  if (HISTORY.length > CLIPBOARD_HISTORY_LIMIT) HISTORY.length = CLIPBOARD_HISTORY_LIMIT
  broadcast()
}

/** Record a text payload we ourselves just wrote, priming the watcher so the very next
 *  poll does not record it a second time under source 'system'. */
function recordOurText(text: string, source: ClipboardSource): void {
  lastText = text
  record({ kind: 'text', text, bytes: Buffer.byteLength(text), source })
}

function recordImage(img: Electron.NativeImage, source: ClipboardSource): void {
  const png = img.toPNG()
  const { width, height } = img.getSize()
  // Past the cap we keep a thumbnail — recognisable in the list, never the whole frame.
  const oversize = png.byteLength > CLIPBOARD_MAX_ENTRY_BYTES
  const shown = oversize ? img.resize({ width: 240, quality: 'good' }) : img
  record({
    kind: 'image',
    text: '',
    // The ORIGINAL dimensions, because that is what the user copied...
    preview: `Image ${width}x${height}`,
    imageDataUrl: shown.toDataURL(),
    // ...but the size of what we actually HOLD, because that is what `bytes` means
    // everywhere else in this list, and it is what keeps `record`'s cap from dropping
    // the very entry we just shrank to fit under it.
    bytes: oversize ? shown.toPNG().byteLength : png.byteLength,
    source
  })
}

function poll(): void {
  // Reading text is cheap; do it first and bail early on the common no-change path.
  const text = clipboard.readText()
  if (text && text !== lastText) {
    lastText = text
    // Sourced 'system': this copy happened outside the app (or in a surface that did not
    // route through writeEntry). Terminal and app copies are recorded at write time.
    record({ kind: 'text', text, bytes: Buffer.byteLength(text), source: 'system' })
    return
  }

  const formats = clipboard.availableFormats()
  if (!formats.some((f) => f.startsWith('image/'))) {
    lastImageSig = ''
    return
  }
  const sig = imageSignature()
  if (!sig || sig === lastImageSig) return
  lastImageSig = sig
  recordImage(clipboard.readImage(), 'system')
}

/** Reading a FILE LIST off the system clipboard has no portable Electron API — the raw
 *  formats differ (`FileNameW`/`CF_HDROP` on Windows, `NSFilenamesPboardType` as a binary
 *  plist on macOS, `text/uri-list` on Linux) and none round-trip cleanly. Rather than ship
 *  three fragile parsers behind a cross-platform promise we could not keep, the app takes
 *  file paths from DRAG-AND-DROP, which hands us real paths on every OS. A 'files' entry
 *  therefore only ever originates from a drop. */
function readRich(): RichClipboard {
  const formats = clipboard.availableFormats()
  if (formats.some((f) => f.startsWith('image/'))) {
    const img = clipboard.readImage()
    if (!img.isEmpty()) {
      return { kind: 'image', text: clipboard.readText(), imageDataUrl: img.toDataURL() }
    }
  }
  return { kind: 'text', text: clipboard.readText() }
}

export function registerClipboard(): void {
  ipcMain.handle(ClipboardChannels.write, (_e, payload: WriteClipboard) => {
    const text = payload?.text ?? ''
    clipboard.writeText(text)
    recordOurText(text, payload?.source ?? 'app')
  })

  ipcMain.handle(ClipboardChannels.read, () => clipboard.readText())

  ipcMain.handle(ClipboardChannels.readRich, (): RichClipboard => readRich())

  ipcMain.handle(ClipboardChannels.writeEntry, (_e, payload: WriteClipboardEntry) => {
    const source = payload?.source ?? 'app'
    if (payload?.kind === 'image' && payload.imageDataUrl) {
      const img = nativeImage.createFromDataURL(payload.imageDataUrl)
      clipboard.writeImage(img)
      lastImageSig = imageSignature()
      recordImage(img, source)
      return
    }
    const text = payload?.text ?? ''
    clipboard.writeText(text)
    recordOurText(text, source)
  })

  // A drop is remembered, never copied. The system clipboard is left exactly as the user
  // left it; the Clipboard tab can hand these paths back on request.
  ipcMain.handle(ClipboardChannels.recordDrop, (_e, payload: RecordDroppedPaths) => {
    const files = payload?.files ?? []
    if (!files.length) return
    const text = payload.text || files.join(' ')
    record({ kind: 'files', text, files, bytes: Buffer.byteLength(text), source: 'drop' })
  })

  ipcMain.handle(ClipboardChannels.history, (): ClipboardEntry[] => HISTORY.slice())

  ipcMain.handle(ClipboardChannels.restore, (_e, ref: ClipboardEntryRef) => {
    const entry = HISTORY.find((e) => e.id === ref?.id)
    if (!entry) return
    if (entry.kind === 'image' && entry.imageDataUrl) {
      clipboard.writeImage(nativeImage.createFromDataURL(entry.imageDataUrl))
      lastImageSig = imageSignature()
    } else {
      clipboard.writeText(entry.text)
      lastText = entry.text
    }
    // Restoring re-dates the entry and floats it to the top: it IS the clipboard now.
    HISTORY.splice(HISTORY.indexOf(entry), 1)
    HISTORY.unshift({ ...entry, at: Date.now() })
    broadcast()
  })

  ipcMain.handle(ClipboardChannels.remove, (_e, ref: ClipboardEntryRef) => {
    const i = HISTORY.findIndex((e) => e.id === ref?.id)
    if (i === -1) return
    const [gone] = HISTORY.splice(i, 1)
    // Deleting the row that IS the current system clipboard must also clear the system
    // clipboard — otherwise "delete" leaves the secret exactly one Ctrl+V away.
    if (gone.kind !== 'image' && gone.text && clipboard.readText() === gone.text) {
      clipboard.clear()
      lastText = ''
    }
    broadcast()
  })

  ipcMain.handle(ClipboardChannels.clear, () => {
    HISTORY.length = 0
    clipboard.clear()
    lastText = ''
    lastImageSig = ''
    broadcast()
  })

  ipcMain.handle(ClipboardChannels.historySet, (_e, payload: SetClipboardHistory) => {
    recording = payload?.enabled !== false
    if (!recording) {
      // Turning it off drops what was already collected. Leaving the ring populated
      // would mean "stop remembering" quietly kept the last hundred things.
      HISTORY.length = 0
      broadcast()
    }
  })

  ipcMain.handle(
    ClipboardChannels.env,
    (): ClipboardEnv => ({
      flavor: shellFlavor(defaultShell(), process.platform),
      platform: process.platform
    })
  )

  // Prime from whatever is already on the clipboard WITHOUT recording it: the ring
  // should start empty rather than open with a copy made before the app launched.
  lastText = clipboard.readText()
  timer = setInterval(poll, POLL_MS)
  timer.unref?.()
}

/** Test/teardown seam — the interval would otherwise hold the process open. */
export function stopClipboardWatcher(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
