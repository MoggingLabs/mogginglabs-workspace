import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Audit regression: a BROKEN feed — reached but unreadable, the nine-404s shape — stays
 *  LOUD even for a background check (never classified as offline-quiet), and its retry
 *  re-checks. The offline half of the classification is UPDATEOFFLINE's gate. */
export function runUpdateFailSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 60000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      for (let i = 0; i < 30; i++) {
        const phase = await ES<string>(`window.bridge.invoke('update:stateGet').then((s) => s.phase)`)
        if (phase === 'error') break
        await sleep(150)
      }

      // Settings mounts lazily. The About tab's update card is not in the document until the
      // page is opened, so reading it first would assert against a null card and "fail" for
      // the wrong reason. Same entry a user takes: titlebar gear, then the About tab.
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(400)
      await ES(`(document.querySelector('.settings-nav-item[data-target="about"]')?.click(), 1)`)
      await sleep(400)

      const initial = await ES<{
        state: { phase: string; error?: string; lastCheckedAt?: number; offline?: boolean }
        railVisible: boolean
        railLabel: string
        railTitle: string
        railErrorClass: boolean
        settingsStatus: string
        settingsRetryEnabled: boolean
      }>(`(async () => {
        const state = await window.bridge.invoke('update:stateGet')
        const rail = document.querySelector('.rail-update-btn')
        const footer = rail?.closest('.rail-footer')
        const settingsStatus = document.querySelector('[data-section="about"] .update-status')
        const settingsRetry = [...document.querySelectorAll('[data-section="about"] button')]
          .find((el) => el.textContent?.trim() === 'Check for updates')
        return {
          state,
          railVisible: footer instanceof HTMLElement && !footer.hidden,
          railLabel: rail?.textContent?.trim() || '',
          railTitle: rail instanceof HTMLElement ? rail.title : '',
          railErrorClass: rail?.classList.contains('is-error') || false,
          settingsStatus: settingsStatus?.textContent || '',
          settingsRetryEnabled: settingsRetry instanceof HTMLButtonElement && !settingsRetry.disabled
        }
      })()`)

      // The BOOT check is a background check — a broken feed must be loud even then, and it
      // must NOT wear the offline flag (that would have kept it quiet, the nine-404s bug).
      const initialVisible =
        initial.state.phase === 'error' &&
        initial.state.offline !== true &&
        !!initial.state.lastCheckedAt &&
        initial.state.error?.includes('update feed could not be read') === true &&
        initial.railVisible &&
        initial.railLabel === 'Update failed — retry' &&
        initial.railErrorClass &&
        initial.railTitle.includes('update feed could not be read') &&
        initial.settingsStatus.includes('failed') &&
        initial.settingsStatus.includes('update feed could not be read') &&
        initial.settingsRetryEnabled

      const retryStarted = await ES<boolean>(`(() => {
        window.__updateFailStates = []
        window.bridge.on('update:state', (s) => window.__updateFailStates.push(s))
        const button = document.querySelector('.rail-update-btn')
        if (!(button instanceof HTMLButtonElement)) return false
        button.click()
        return true
      })()`)
      await sleep(700)
      const retried = await ES<{
        phases: string[]
        state: { phase: string; error?: string; lastCheckedAt?: number }
        label: string
      }>(`(async () => ({
        phases: (window.__updateFailStates || []).map((s) => s.phase),
        state: await window.bridge.invoke('update:stateGet'),
        label: document.querySelector('.rail-update-btn')?.textContent?.trim() || ''
      }))()`)
      const retryWorked =
        retryStarted &&
        retried.phases.includes('checking') &&
        retried.phases.includes('error') &&
        retried.state.phase === 'error' &&
        (retried.state.lastCheckedAt ?? 0) > (initial.state.lastCheckedAt ?? 0) &&
        retried.label === 'Update failed — retry'

      result = { pass: initialVisible && retryWorked, initialVisible, retryWorked, initial, retried }
    } catch (error) {
      result = { pass: false, error: String(error) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'updatefail-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass === true ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
