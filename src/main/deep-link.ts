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

function deliver(getWindow: () => BrowserWindow | null, url: string): void {
  const win = getWindow()
  if (!win) return
  const control = controlFromUrl(url)
  const cwd = control ? null : cwdFromUrl(url)
  if (!control && cwd == null) return
  if (win.isMinimized()) win.restore()
  win.focus()
  if (control) win.webContents.send(ControlChannels.command, control)
  else win.webContents.send(WorkspaceChannels.openCwd, cwd)
}

/** Register protocol + second-instance/open-url handlers. Returns the launch cwd, if any. */
export function registerDeepLink(getWindow: () => BrowserWindow | null): void {
  if (process.defaultApp && process.argv.length >= 2) {
    // dev: round-trip mogging-dev:// back through this exact electron + entry script
    app.setAsDefaultProtocolClient(scheme(), process.execPath, [process.argv[1]])
  } else {
    app.setAsDefaultProtocolClient(scheme())
  }
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith(scheme() + '://'))
    if (url) deliver(getWindow, url)
  })
  app.on('open-url', (_e, url) => deliver(getWindow, url))
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
