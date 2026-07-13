import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IntegrationsChannels } from '@contracts'

// Regression gate for audit P0/05. The transport must be one-way:
// enter Integrations -> one refresh request -> status push -> repaint only.
// A push must never request another poll, including when multiple pushes arrive.
export function runMcpLoopSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 60000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1800)
      await ES(`window.__mogging.view('settings')`)
      await sleep(300)
      const appearance = await ES<{ pollRequests: number; pushPaints: number }>(`window.__mogging.integrationsStatusDebug()`)

      await ES(`window.__mogging.settingsTab('integrations')`)
      await sleep(500)
      const entered = await ES<{ pollRequests: number; pushPaints: number }>(`window.__mogging.integrationsStatusDebug()`)

      // Synthetic pushes isolate the renderer contract from whichever CLIs happen to be
      // installed on this machine. Three pushes used to recursively schedule unbounded polls.
      for (let i = 0; i < 3; i++) {
        wc.send(IntegrationsChannels.statusChanged, { statuses: [], at: Date.now() + i })
        await sleep(150)
      }
      const afterPushes = await ES<{ pollRequests: number; pushPaints: number }>(`window.__mogging.integrationsStatusDebug()`)

      for (let i = 0; i < 30; i++) {
        if (await ES<boolean>(`document.querySelector('[data-mcp-status-refresh="true"]')?.disabled === false`)) break
        await sleep(200)
      }
      await ES(`document.querySelector('[data-mcp-status-refresh="true"]')?.click()`)
      await sleep(100)
      const manual = await ES<{ pollRequests: number; pushPaints: number }>(`window.__mogging.integrationsStatusDebug()`)
      const manualOneShot = manual.pollRequests === 2

      await ES(`window.__mogging.settingsTab('appearance')`)
      for (let i = 0; i < 30; i++) {
        if (await ES<boolean>(`document.querySelector('[data-mcp-status-refresh="true"]')?.disabled === false`)) break
        await sleep(200)
      }
      await ES(`window.__mogging.settingsTab('integrations')`)
      await sleep(400)
      const reentered = await ES<{ pollRequests: number; pushPaints: number }>(`window.__mogging.integrationsStatusDebug()`)

      const idleOk = appearance.pollRequests === 0
      const oneOnEntry = entered.pollRequests === 1
      const noEcho = afterPushes.pollRequests === 1 && afterPushes.pushPaints >= entered.pushPaints + 3
      const onePerEntry = reentered.pollRequests === 3
      const pass = idleOk && oneOnEntry && noEcho && manualOneShot && onePerEntry
      result = {
        pass,
        idleOk,
        oneOnEntry,
        noEcho,
        manualOneShot,
        onePerEntry,
        appearance,
        entered,
        afterPushes,
        manual,
        reentered
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'mcploop-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 1200))
  else setTimeout(run, 1200)
}
