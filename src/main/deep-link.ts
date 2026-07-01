import { app, type BrowserWindow } from 'electron'
import { WorkspaceChannels } from '@contracts'

// App-wiring: `mogging://` deep-link + single-instance handling so `mogging .` (the bin) opens
// or focuses a workspace for a directory. The bin launches `mogging://open?cwd=<abs dir>`; a
// running app receives it (second-instance on Win/Linux, open-url on macOS) and tells the
// renderer to open that workspace. No auth is ever involved (ADR 0002).

export function cwdFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'mogging:') return null
    const cwd = u.searchParams.get('cwd')
    return cwd ? cwd : null
  } catch {
    return null
  }
}

function deliver(getWindow: () => BrowserWindow | null, url: string): void {
  const cwd = cwdFromUrl(url)
  if (cwd == null) return
  const win = getWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
  win.webContents.send(WorkspaceChannels.openCwd, cwd)
}

/** Register protocol + second-instance/open-url handlers. Returns the launch cwd, if any. */
export function registerDeepLink(getWindow: () => BrowserWindow | null): void {
  if (process.defaultApp && process.argv.length >= 2) {
    // dev: round-trip mogging:// back through this exact electron + entry script
    app.setAsDefaultProtocolClient('mogging', process.execPath, [process.argv[1]])
  } else {
    app.setAsDefaultProtocolClient('mogging')
  }
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith('mogging://'))
    if (url) deliver(getWindow, url)
  })
  app.on('open-url', (_e, url) => deliver(getWindow, url))
}

/** The cwd from a cold-start deep link (Windows/Linux pass it in argv). */
export function initialDeepLinkCwd(): string | null {
  const url = process.argv.find((a) => a.startsWith('mogging://'))
  return url ? cwdFromUrl(url) : null
}
