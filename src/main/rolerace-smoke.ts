import { app, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DaemonEndpoint, PaneInfo } from '@contracts'
import { DaemonClient, runtimeDir } from './daemon-client'

// Audit regression gate for P1/14. The daemon is launched with an injected 2.5 s
// spawn delay (past the retired 1.2 s role timeout), then is killed and replaced.
// The app must bind the manifest role after acknowledged spawn in both cases.
export function runRoleRaceSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const endpointFile = join(runtimeDir(), 'endpoint.json')
  const endpoint = (): DaemonEndpoint => JSON.parse(readFileSync(endpointFile, 'utf8')) as DaemonEndpoint
  const panes = async (): Promise<PaneInfo[]> => {
    const client = new DaemonClient(endpoint())
    try {
      return await client.connect()
    } finally {
      client.dispose()
    }
  }
  const waitForRole = async (paneId: number, role: string, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const list = await panes()
        if (list.find((pane) => pane.id === String(paneId))?.role === role) return true
      } catch {
        /* daemon is between generations */
      }
      await sleep(250)
    }
    return false
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1200)
      await ES(`window.__mogging.workspace.create({ name: 'Role race', paneCount: 1, roles: ['reviewer'] })`)
      const active = (await ES(`window.__mogging.workspace.active()`)) as { ordinal: number }
      const paneId = active.ordinal * 100 + 1

      const slowSpawnBound = await waitForRole(paneId, 'reviewer', 18000)
      const before = endpoint()
      // Let the daemon's coalesced session persistence land before simulating a crash.
      await sleep(2500)
      process.kill(before.pid)

      let replacementPid = 0
      const replacementDeadline = Date.now() + 20000
      while (Date.now() < replacementDeadline) {
        try {
          const next = endpoint()
          if (next.pid !== before.pid) {
            replacementPid = next.pid
            break
          }
        } catch {
          /* endpoint is legitimately absent during replacement */
        }
        await sleep(250)
      }
      const reconnectBound = replacementPid > 0 && (await waitForRole(paneId, 'reviewer', 20000))
      const chipStillReviewer = await ES<boolean>(
        `document.querySelector('.layout-slot[data-pane-id="${paneId}"] .pane-role')?.textContent === 'reviewer'`
      )
      const pass = slowSpawnBound && reconnectBound && chipStillReviewer
      result = {
        pass,
        slowSpawnBound,
        reconnectBound,
        chipStillReviewer,
        oldPid: before.pid,
        replacementPid,
        injectedDelayMs: process.env.MOGGING_DAEMON_SPAWN_DELAY_MS
      }
    } catch (error) {
      result = { pass: false, error: String(error) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'rolerace-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 1200))
  else setTimeout(run, 1200)
}
