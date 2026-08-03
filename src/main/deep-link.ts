import { app, type BrowserWindow } from 'electron'
import { CONTROL_COLD_START_DELAY_MS, ControlChannels, WorkspaceChannels, type ControlCommand } from '@contracts'
import { controlFromUrl, cwdFromUrl, sanitizeControl, scheme } from './deep-link-parse'

// Parsing lives in ./deep-link-parse (Electron-free, so it can be unit-tested); this module
// keeps the OS wiring. Re-exported so existing importers are unchanged.
export { controlFromUrl, cwdFromUrl, sanitizeControl }

// App-wiring: `mogging://` deep-link + single-instance handling. `mogging .` opens or
// focuses a workspace for a directory (mogging://open?cwd=…); the Phase-3/02 layout
// verbs ride the SAME relay (mogging://control?c=<json>) — main VALIDATES the payload
// against the closed ControlCommand union and forwards only a clean object, so the
// renderer never parses raw CLI input. No auth is ever involved (ADR 0002).
//
// PER-CHANNEL SCHEME. The OS protocol association is a single global slot per scheme and both
// apps re-register on every launch — so if dev and an installed release shared `mogging://`,
// whichever launched LAST would receive the other's `mogging open` / layout verbs. A repo
// checkout therefore owns `mogging-dev://` and never touches the release's association.

function deliver(ensureWindow: () => BrowserWindow, url: string): void {
  const control = controlFromUrl(url)
  const cwd = control ? null : cwdFromUrl(url)
  if (!control && cwd == null) return // parse BEFORE the window exists: junk must not open one
  // On macOS the app outlives its window (window-all-closed does not quit, index.ts) and `win`
  // is nulled on 'closed' — `mogging .` then did NOTHING AT ALL. Recreate, exactly like the
  // 'activate' handler, and deliver once the renderer can receive it.
  const win = ensureWindow()
  if (win.isMinimized()) win.restore()
  win.focus()
  const send = (): void => {
    if (win.isDestroyed()) return
    if (control) win.webContents.send(ControlChannels.command, control)
    else win.webContents.send(WorkspaceChannels.openCwd, cwd)
  }
  if (!win.webContents.isLoading()) send()
  // A window we had to CREATE is a cold start: wait for the renderer, and give restore the same
  // beat boot.ts gives a cold-start control verb — `open` must land after the restored
  // workspaces re-attach, not before them.
  else win.webContents.once('did-finish-load', () => (control ? setTimeout(send, CONTROL_COLD_START_DELAY_MS) : send()))
}

// Deliveries that arrived before the window existed. The lock is taken at module scope but the
// window is up to ~25 s of boot away (daemon migrate + start + feature registration): a
// `mogging .` fired into that gap made the SECOND instance exit 0 ("opening workspace…") while
// the primary had no 'second-instance' listener yet — the command vanished. Bounded: a flood of
// deep links is a bug, not a workload.
let ensureWin: (() => BrowserWindow) | null = null
const pending: string[] = []
const QUEUE_MAX = 16

function accept(url: string): void {
  if (ensureWin) deliver(ensureWin, url)
  else if (pending.length < QUEUE_MAX) pending.push(url)
}

/** Attach the OS handlers the INSTANT the single-instance lock is taken — before any boot work.
 *  Deliveries queue until registerDeepLink hands us the window. */
export function installDeepLinkListeners(): void {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith(scheme() + '://'))
    if (url) accept(url)
  })
  app.on('open-url', (_e, url) => accept(url))
}

/** Register the protocol association and drain anything that arrived during boot. */
export function registerDeepLink(ensureWindow: () => BrowserWindow): void {
  if (process.defaultApp && process.argv.length >= 2) {
    // dev: round-trip mogging-dev:// back through this exact electron + entry script
    app.setAsDefaultProtocolClient(scheme(), process.execPath, [process.argv[1]])
  } else {
    app.setAsDefaultProtocolClient(scheme())
  }
  ensureWin = ensureWindow
  for (const url of pending.splice(0)) deliver(ensureWindow, url)
}

/** The cwd from a cold-start deep link (Windows/Linux pass it in argv). */
export function initialDeepLinkCwd(): string | null {
  const url = process.argv.find((a) => a.startsWith(scheme() + '://'))
  return url ? cwdFromUrl(url) : null
}

/** A validated control command from a cold-start deep link, if any. */
export function initialControlCommand(): ControlCommand | null {
  const url = process.argv.find((a) => a.startsWith(scheme() + '://'))
  return url ? controlFromUrl(url) : null
}
