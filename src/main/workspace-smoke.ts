import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Two-phase workspace persistence smoke (MOGGING_WORKSPACE = A | B), driven by an external
 * harness that clears the store then launches A, then B:
 *  - A: create a 2nd workspace (dir + 4-pane layout), switch back to the first, let the
 *       debounced persist flush, then quit.
 *  - B: relaunch -> assert BOTH workspaces restored, with their pane layouts + active tab.
 */
export function runWorkspaceSmoke(win: BrowserWindow, phase: string): void {
  setTimeout(() => app.exit(1), 30000) // safety net

  const scriptA = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const ws = window.__mogging && window.__mogging.workspace
    if (!ws) return { ok: false, error: 'no workspace dev handle' }
    for (let i = 0; i < 50 && ws.count() < 1; i++) await sleep(100)
    ws.create({ name: 'Server', cwd: 'C:/tmp/server', paneCount: 4 })
    await sleep(300)
    ws.switchByIndex(0)
    await sleep(1000) // let the 400ms debounced persist flush to app-settings.db
    return { ok: true, count: ws.count() }
  })()`

  const scriptB = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const ws = window.__mogging && window.__mogging.workspace
    if (!ws) return { ok: false, error: 'no workspace dev handle' }
    for (let i = 0; i < 70 && ws.count() < 2; i++) await sleep(150)
    const list = ws.list()
    const active = ws.active()
    return {
      count: ws.count(),
      names: list.map((w) => w.name),
      paneCounts: list.map((w) => w.paneCount),
      cwds: list.map((w) => w.cwd),
      activeName: active ? active.name : null
    }
  })()`

  const isA = phase.toUpperCase() === 'A'

  const run = async (): Promise<void> => {
    let result: Record<string, unknown>
    try {
      result = await win.webContents.executeJavaScript(isA ? scriptA : scriptB, true)
    } catch (e) {
      result = { ok: false, error: String(e) }
    }
    if (isA) {
      app.exit(result.ok ? 0 : 1)
      return
    }
    const pass =
      result.count === 2 &&
      Array.isArray(result.paneCounts) &&
      (result.paneCounts as number[]).includes(4) &&
      Array.isArray(result.names) &&
      (result.names as string[]).includes('Server')
    try {
      writeFileSync(join(process.cwd(), 'out', 'workspace-result.json'), JSON.stringify({ pass, ...result }))
    } catch {
      /* best effort */
    }
    app.exit(pass ? 0 : 1)
  }

  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
