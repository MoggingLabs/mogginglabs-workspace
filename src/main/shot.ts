import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Env-gated visual smoke (MOGGING_SHOT): once the UI has loaded, capture the window to
 * out/shot.png and exit. Handy for eyeballing branding / layout changes (e.g. the logo).
 * MOGGING_SHOT=grid first opens a 4-pane workspace (launcher-first boot shows Home
 * otherwise), waits for prompts, then captures.
 */
export function runShot(win: BrowserWindow): void {
  const grid = process.env.MOGGING_SHOT === 'grid'
  const capture = async (): Promise<void> => {
    try {
      if (grid) {
        const cwd = JSON.stringify(process.cwd()) // a real repo -> the branch chip renders
        await win.webContents.executeJavaScript(
          '(function(){var m=window.__mogging;' +
            `if(m&&m.workspace&&m.workspace.count()===0){m.workspace.create({name:"Workspace 1",cwd:${cwd}});}` +
            'if(m&&m.layout)m.layout.apply(4);return 1;})()',
          true
        )
        await new Promise((r) => setTimeout(r, 5000)) // panes spawn + shells prompt + git resolves
      }
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
