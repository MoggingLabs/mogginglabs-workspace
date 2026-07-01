import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Env-gated visual smoke (MOGGING_SHOT): once the UI has loaded, capture the window to
 * out/shot.png and exit. Handy for eyeballing branding / layout changes (e.g. the logo).
 */
export function runShot(win: BrowserWindow): void {
  const capture = async (): Promise<void> => {
    try {
      const img = await win.webContents.capturePage()
      writeFileSync(join(process.cwd(), 'out', 'shot.png'), img.toPNG())
    } catch {
      /* best effort */
    }
    app.exit(0)
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => setTimeout(capture, 1500))
  } else {
    setTimeout(capture, 1500)
  }
}
