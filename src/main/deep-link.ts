import { app, type BrowserWindow } from 'electron'
import {
  CONTROL_EXPAND_MODES,
  CONTROL_VERBS,
  ControlChannels,
  WorkspaceChannels,
  channelFromEnv,
  deepLinkScheme,
  type ControlCommand
} from '@contracts'

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

/** This process's scheme: `mogging` (release) or `mogging-dev` (repo checkout). */
const scheme = (): string => deepLinkScheme(channelFromEnv())

export function cwdFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== scheme() + ':') return null
    const cwd = u.searchParams.get('cwd')
    return cwd ? cwd : null
  } catch {
    return null
  }
}

/**
 * Validate an untrusted control payload into a CLEAN ControlCommand (or null).
 * Closed verb/mode unions, bounded numbers, bounded path length — nothing else
 * survives; unknown fields are dropped by construction.
 */
export function sanitizeControl(raw: unknown): ControlCommand | null {
  const p = raw as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return null
  const verb = p.verb
  if (typeof verb !== 'string' || !(CONTROL_VERBS as readonly string[]).includes(verb)) return null
  const cmd: ControlCommand = { verb: verb as ControlCommand['verb'] }

  if (p.cwd !== undefined) {
    if (typeof p.cwd !== 'string' || !p.cwd || p.cwd.length > 1024) return null
    cmd.cwd = p.cwd
  }
  if (p.panes !== undefined) {
    const n = Number(p.panes)
    if (!Number.isInteger(n) || n < 1 || n > 16) return null
    cmd.panes = n
  }
  if (p.paneId !== undefined) {
    const n = Number(p.paneId)
    if (!Number.isInteger(n) || n < 1 || n > 99999) return null
    cmd.paneId = n
  }
  if (p.mode !== undefined) {
    if (
      typeof p.mode !== 'string' ||
      !(CONTROL_EXPAND_MODES as readonly string[]).includes(p.mode)
    ) {
      return null
    }
    cmd.mode = p.mode as ControlCommand['mode']
  }

  // Per-verb required fields — a verb without its target is dropped, not guessed.
  if (cmd.verb === 'open' && !cmd.cwd) return null
  if (cmd.verb === 'layout' && cmd.panes === undefined) return null
  if ((cmd.verb === 'focus' || cmd.verb === 'expand' || cmd.verb === 'close-pane') && cmd.paneId === undefined) {
    return null
  }
  return cmd
}

/** Parse + validate a <scheme>://control URL. Null for anything else/invalid. */
export function controlFromUrl(url: string): ControlCommand | null {
  try {
    const u = new URL(url)
    if (u.protocol !== scheme() + ':' || u.hostname !== 'control') return null
    const raw = u.searchParams.get('c')
    if (!raw) return null
    return sanitizeControl(JSON.parse(raw))
  } catch {
    return null
  }
}

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
  // beat index.ts gives a cold-start control verb — `open` must land after the restored
  // workspaces re-attach, not before them.
  else win.webContents.once('did-finish-load', () => (control ? setTimeout(send, 800) : send()))
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
