import { app, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceState } from '@contracts'
import { appSettingsDebug } from './app-settings'
import { setDaemonHealth, setDaemonHealthRetry } from './runtime-health'

// Audit regression gate for persistence/daemon degradation (P1/18). It injects
// both failure classes through the real IPC/UI path and proves the safety laws:
// a failed load never saves in that renderer session (even after a good re-read),
// a rejected save pauses writes until an acknowledged retry, metadata remains
// exportable, and daemon fallback/reconnect states are visible and actionable.
export function runPersistHealthSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const reload = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      wc.once('did-finish-load', () => resolve())
      wc.reload()
    })
    await sleep(1500)
  }
  const banner = (): Promise<{ visible: boolean; title: string; body: string; buttons: string[] }> =>
    ES(`(() => {
      const row = document.querySelector('.runtime-health-row.is-persistence')
      return {
        visible: !!row && !row.hidden,
        title: row?.querySelector('strong')?.textContent || '',
        body: row?.querySelector('.runtime-health-copy span')?.textContent || '',
        buttons: [...(row?.querySelectorAll('button') || [])].map((b) => b.textContent || '')
      }
    })()`)
  const clickPersistence = (label: string): Promise<void> =>
    ES(`(() => {
      const button = [...document.querySelectorAll('.runtime-health-row.is-persistence button')]
        .find((b) => b.textContent?.trim() === ${JSON.stringify(label)})
      if (!(button instanceof HTMLButtonElement)) throw new Error('missing persistence action: ' + ${JSON.stringify(label)})
      button.click()
    })()`)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    const exportPath = join(tmpdir(), `mogging-persist-export-${process.pid}.json`)
    try {
      await sleep(1800)

      // Failed restore: no automatic write may follow it, including after a later
      // read succeeds. Only a clean renderer restart can establish a complete base.
      process.env.MOGGING_PERSIST_FAIL = 'load'
      await reload()
      const loadBanner = await banner()
      const savesBeforeLoadSession = appSettingsDebug().saves
      await ES(`window.__mogging.workspace.create({ name: 'Unsaved after failed load' })`)
      await sleep(900)
      const loadFailureBlockedSave = appSettingsDebug().saves === savesBeforeLoadSession

      delete process.env.MOGGING_PERSIST_FAIL
      await clickPersistence('Re-check storage')
      await sleep(500)
      const recheckBanner = await banner()
      await ES(`window.__mogging.workspace.create({ name: 'Still read only' })`)
      await sleep(900)
      const recheckDidNotFalseRecover = appSettingsDebug().saves === savesBeforeLoadSession

      process.env.MOGGING_PERSIST_EXPORT_PATH = exportPath
      const exportsBefore = appSettingsDebug().exports
      await clickPersistence('Export current metadata')
      await sleep(500)
      const exported = existsSync(exportPath)
        ? (JSON.parse(readFileSync(exportPath, 'utf8')) as WorkspaceState)
        : null
      const exportOk =
        appSettingsDebug().exports === exportsBefore + 1 &&
        !!exported &&
        exported.workspaces.some((w) => w.name === 'Unsaved after failed load') &&
        exported.workspaces.some((w) => w.name === 'Still read only')
      delete process.env.MOGGING_PERSIST_EXPORT_PATH

      // A clean restore resets the session safety latch. A transient save failure
      // then pauses subsequent saves, and only a successful retry resumes them.
      await reload()
      const savesBeforeFailure = appSettingsDebug().saves
      process.env.MOGGING_PERSIST_FAIL = 'save'
      await ES(`window.__mogging.workspace.create({ name: 'Rejected save' })`)
      await sleep(1000)
      const saveBanner = await banner()
      const savesAfterFailure = appSettingsDebug().saves
      await ES(`window.__mogging.workspace.create({ name: 'Queued while paused' })`)
      await sleep(900)
      const rejectedSavePausedWrites =
        savesAfterFailure > savesBeforeFailure && appSettingsDebug().saves === savesAfterFailure

      delete process.env.MOGGING_PERSIST_FAIL
      await clickPersistence('Retry save now')
      await sleep(600)
      const retryBanner = await banner()
      const savesAfterRetry = appSettingsDebug().saves
      await ES(`window.__mogging.workspace.create({ name: 'Saved after retry' })`)
      await sleep(1000)
      const acknowledgedRetryResumed =
        !retryBanner.visible && savesAfterRetry === savesAfterFailure + 1 && appSettingsDebug().saves > savesAfterRetry

      // Runtime health is pushed, not console-only. Fallback is explicit and does
      // not offer an unsafe live mode switch; reconnect does offer an immediate retry.
      setDaemonHealthRetry(null)
      setDaemonHealth({
        mode: 'in-process',
        state: 'degraded',
        message: 'Injected fallback: terminals work, but cannot survive restart.',
        sessionSurvival: false
      })
      await sleep(250)
      const fallback = await ES<{ visible: boolean; text: string; retry: boolean }>(`(() => {
        const row = document.querySelector('.runtime-health-row.is-daemon')
        return { visible: !!row && !row.hidden, text: row?.textContent || '', retry: !![...(row?.querySelectorAll('button') || [])].find((b) => b.textContent?.includes('Retry')) }
      })()`)

      let retryCalls = 0
      setDaemonHealthRetry(async () => {
        retryCalls++
        setDaemonHealth({
          mode: 'daemon',
          state: 'connected',
          message: 'Detached terminal service connected.',
          sessionSurvival: true
        })
        return { ok: true }
      })
      setDaemonHealth({
        mode: 'daemon',
        state: 'reconnecting',
        message: 'Injected reconnect failure; automatic retries continue.',
        sessionSurvival: true
      })
      await sleep(250)
      const reconnectVisible = await ES<boolean>(
        `document.querySelector('.runtime-health-row.is-daemon')?.textContent?.includes('Retry now') === true`
      )
      await ES(`document.querySelector('.runtime-health-row.is-daemon button')?.click()`)
      await sleep(350)
      const reconnectCleared = await ES<boolean>(`document.querySelector('.runtime-health-row.is-daemon')?.hidden === true`)

      const loadFailureVisible =
        loadBanner.visible &&
        loadBanner.title === 'Workspace history could not be loaded' &&
        loadBanner.buttons.includes('Re-check storage') &&
        loadBanner.buttons.includes('Export current metadata')
      const honestRecheck =
        recheckBanner.visible &&
        recheckBanner.title === 'Workspace storage needs a clean restart' &&
        recheckBanner.body.includes('saving remains paused until restart')
      const rejectedSaveVisible =
        saveBanner.visible &&
        saveBanner.title === 'Workspace saving is paused' &&
        saveBanner.buttons.includes('Retry save now')
      const fallbackVisible =
        fallback.visible && fallback.text.includes('cannot survive restart') && !fallback.retry
      const daemonRetryOk = reconnectVisible && retryCalls === 1 && reconnectCleared
      const pass =
        loadFailureVisible &&
        loadFailureBlockedSave &&
        honestRecheck &&
        recheckDidNotFalseRecover &&
        exportOk &&
        rejectedSaveVisible &&
        rejectedSavePausedWrites &&
        acknowledgedRetryResumed &&
        fallbackVisible &&
        daemonRetryOk
      result = {
        pass,
        loadFailureVisible,
        loadFailureBlockedSave,
        honestRecheck,
        recheckDidNotFalseRecover,
        exportOk,
        rejectedSaveVisible,
        rejectedSavePausedWrites,
        acknowledgedRetryResumed,
        fallbackVisible,
        daemonRetryOk,
        loadBanner,
        recheckBanner,
        saveBanner,
        retryBanner,
        counters: appSettingsDebug()
      }
    } catch (error) {
      result = { pass: false, error: String(error), counters: appSettingsDebug() }
    } finally {
      delete process.env.MOGGING_PERSIST_FAIL
      delete process.env.MOGGING_PERSIST_EXPORT_PATH
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'persisthealth-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 1200))
  else setTimeout(run, 1200)
}
