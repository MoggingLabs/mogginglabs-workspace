import { app, type BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSettingsStore } from './app-settings'
import { getIntegrationsGrant, setIntegrationsGrant } from './integrations'
import {
  browserRaceAudit,
  setBrowserRaceAudit,
  type BrowserRaceAuditEvent,
  type BrowserRaceOperation
} from './browser-race-audit-faults'

// Audit regression for browser cross-workspace races. Every delayed response
// begins for workspace A, the user moves to B, and the late completion must
// remain scoped to A without repainting or mutating B.
export function runBrowserRaceSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  let server: Server | null = null

  const emit = (value: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'browserrace-result.json'), JSON.stringify(value, null, 2))
    } catch {
      // best effort
    }
  }

  const serve = (): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<!doctype html><title>BROWSER_RACE_A</title><h1>workspace A only</h1>')
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server?.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      const port = await serve()
      const origin = `http://127.0.0.1:${port}`
      await ES(`window.__mogging.workspace.create({ name: 'Race A' })`)
      await sleep(700)
      const wsA = (await ES<{ id: string }>(`window.__mogging.workspace.active()`)).id
      await ES(`window.__mogging.workspace.create({ name: 'Race B' })`)
      await sleep(700)
      const wsB = (await ES<{ id: string }>(`window.__mogging.workspace.active()`)).id
      await ES(`window.__mogging.browser.toggle(true)`)
      await sleep(500)

      const workspaces = await ES<{ id: string }[]>(`window.__mogging.workspace.list()`)
      const indexA = workspaces.findIndex((workspace) => workspace.id === wsA)
      const indexB = workspaces.findIndex((workspace) => workspace.id === wsB)
      const switchTo = (index: number): Promise<void> =>
        ES(`window.__mogging.workspace.switchByIndex(${index})`).then(() => undefined)
      const events = (): BrowserRaceAuditEvent[] => [...(browserRaceAudit()?.events ?? [])]
      const countEvents = (operation: BrowserRaceOperation, stage: 'start' | 'finish'): number =>
        events().filter((event) => event.operation === operation && event.stage === stage).length
      const waitEvent = async (
        operation: BrowserRaceOperation,
        stage: 'start' | 'finish',
        count: number
      ): Promise<boolean> => {
        for (let i = 0; i < 100; i++) {
          if (countEvents(operation, stage) >= count) return true
          await sleep(50)
        }
        return false
      }
      const waitWorkspaceEvent = async (
        operation: BrowserRaceOperation,
        stage: 'start' | 'finish',
        workspaceId: string,
        count: number
      ): Promise<boolean> => {
        for (let i = 0; i < 100; i++) {
          const seen = events().filter(
            (event) => event.operation === operation && event.stage === stage && event.workspaceId === workspaceId
          ).length
          if (seen >= count) return true
          await sleep(50)
        }
        return false
      }

      const delay = 850
      setBrowserRaceAudit({
        [`lastUrl:${wsA}`]: delay,
        [`profileGet:${wsA}`]: delay,
        [`profileSet:${wsA}`]: delay,
        [`consentGet:${wsA}`]: delay,
        [`navigate:${wsA}`]: delay,
        [`signedInSites:${wsA}`]: delay,
        [`grantGet:${wsA}`]: delay
      })
      const store = getSettingsStore()
      store?.setSetting(`browser.lastUrl.${wsA}`, `${origin}/remembered-a`)
      store?.setSetting(`browser.profile.${wsA}`, 'agent-web')
      store?.setSetting(`browser.agentControl.${wsA}`, '1')
      store?.setSetting(`browser.profile.${wsB}`, 'preview')
      store?.setSetting(`browser.agentControl.${wsB}`, '')
      setIntegrationsGrant({ workspaceId: wsA, writeTools: 'none', web: 'signed-in', actOrigins: [origin] })
      setIntegrationsGrant({ workspaceId: wsB, writeTools: 'none', web: 'off', actOrigins: [] })

      // Stored profile, consent, and preview-chip reads for A all finish after B
      // is active. None may paint or apply A state to B.
      await switchTo(indexA)
      const baseStarts = await Promise.all([
        waitWorkspaceEvent('lastUrl', 'start', wsA, 1),
        waitWorkspaceEvent('profileGet', 'start', wsA, 1),
        waitWorkspaceEvent('consentGet', 'start', wsA, 1)
      ])
      const switchedBAt = Date.now()
      await switchTo(indexB)
      const baseFinishes = await Promise.all([
        waitWorkspaceEvent('lastUrl', 'finish', wsA, 1),
        waitWorkspaceEvent('profileGet', 'finish', wsA, 1),
        waitWorkspaceEvent('consentGet', 'finish', wsA, 1)
      ])
      await sleep(250)
      const baseUi = await ES<{
        stateWorkspace: string
        profile: string
        chipHidden: boolean
        chipText: string
        sitesHidden: boolean
        sitesText: string
      }>(`(() => {
        const state = window.__mogging.browser.state()
        const chip = document.querySelector('.browser-ws-chip')
        const sites = document.querySelector('.browser-sites-menu')
        return {
          stateWorkspace: state.workspaceId,
          profile: state.profile,
          chipHidden: !!chip?.hidden,
          chipText: chip?.textContent ?? '',
          sitesHidden: !!sites?.hidden,
          sitesText: sites?.textContent ?? ''
        }
      })()`)
      const lateBaseEvents = events().filter(
        (event) => event.workspaceId === wsA && event.stage === 'finish' && event.at > switchedBAt
      )
      const everyBaseReadFinishedLate = (['lastUrl', 'profileGet', 'consentGet'] as const).every(
        (operation) => lateBaseEvents.some((event) => event.operation === operation)
      )
      const staleConsentApplied = events().some(
        (event) => event.operation === 'consentApply' && event.workspaceId === wsA && event.at > switchedBAt
      )
      const staleProfileSet = events().some(
        (event) => event.operation === 'profileSet' && event.workspaceId === wsA && event.at > switchedBAt
      )
      const baseRaceOk =
        baseStarts.every(Boolean) && baseFinishes.every(Boolean) &&
        everyBaseReadFinishedLate &&
        baseUi.stateWorkspace === wsB && baseUi.profile === 'preview' &&
        baseUi.chipHidden && !baseUi.chipText.includes('remembered-a') &&
        baseUi.sitesHidden && !baseUi.sitesText.includes(origin) &&
        !staleConsentApplied && !staleProfileSet

      // The URL-entry callback captures A before awaiting main. Its late success
      // may navigate A, but B must keep its blank header/empty state and storage.
      store?.setSetting(`browser.profile.${wsA}`, 'preview')
      await switchTo(indexA)
      await sleep(150)
      const navStartsBefore = countEvents('navigate', 'start')
      await ES(`(() => {
        const input = document.querySelector('.browser-url')
        if (!(input instanceof HTMLInputElement)) return false
        input.value = ${JSON.stringify(`${origin}/navigate-a`)}
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return true
      })()`)
      const navStarted = await waitEvent('navigate', 'start', navStartsBefore + 1)
      const switchedAfterNavigateAt = Date.now()
      await switchTo(indexB)
      const navFinished = await waitEvent('navigate', 'finish', navStartsBefore + 1)
      await sleep(300)
      const navUi = await ES<{ stateWorkspace: string; url: string; input: string; emptyHidden: boolean }>(`(() => {
        const state = window.__mogging.browser.state()
        const input = document.querySelector('.browser-url')
        const empty = document.querySelector('.browser-empty')
        return {
          stateWorkspace: state.workspaceId,
          url: state.url,
          input: input instanceof HTMLInputElement ? input.value : '',
          emptyHidden: !!empty?.hidden
        }
      })()`)
      const navFinish = events().filter((event) => event.operation === 'navigate' && event.stage === 'finish').at(-1)
      const navigationRaceOk =
        navStarted && navFinished && navFinish?.workspaceId === wsA && navFinish.at > switchedAfterNavigateAt &&
        navUi.stateWorkspace === wsB && navUi.url === '' &&
        !navUi.input.includes('navigate-a') && navUi.emptyHidden === false &&
        store?.getSetting(`browser.lastUrl.${wsA}`) === `${origin}/navigate-a` &&
        !store?.getSetting(`browser.lastUrl.${wsB}`)

      // A profile-button mutation also remains bound to A after the switch.
      store?.setSetting(`browser.profile.${wsA}`, 'preview')
      await switchTo(indexA)
      await sleep(150)
      const profileSetBefore = countEvents('profileSet', 'start')
      await ES(`document.querySelectorAll('.browser-profile-opt')[1]?.click()`)
      const profileSetStarted = await waitEvent('profileSet', 'start', profileSetBefore + 1)
      await switchTo(indexB)
      const profileSetFinished = await waitEvent('profileSet', 'finish', profileSetBefore + 1)
      await sleep(200)
      const profileRaceUi = await ES<{ workspaceId: string; profile: string }>(`window.__mogging.browser.state()`)
      const profileRaceOk =
        profileSetStarted && profileSetFinished &&
        store?.getSetting(`browser.profile.${wsA}`) === 'agent-web' &&
        store?.getSetting(`browser.profile.${wsB}`) === 'preview' &&
        profileRaceUi.workspaceId === wsB && profileRaceUi.profile === 'preview'

      // Sites lookup arm 1: switch while the cookie query is outstanding.
      await switchTo(indexA)
      await sleep(150)
      const sitesBefore = countEvents('signedInSites', 'start')
      await ES(`(window.__mogging.browser.openSites(), true)`)
      const sitesStarted = await waitEvent('signedInSites', 'start', sitesBefore + 1)
      await switchTo(indexB)
      const sitesFinished = await waitEvent('signedInSites', 'finish', sitesBefore + 1)
      await sleep(150)
      const sitesCleared = await ES<boolean>(`(() => {
        const menu = document.querySelector('.browser-sites-menu')
        return !!menu && menu.hidden && (menu.textContent ?? '') === ''
      })()`)

      // Sites lookup arm 2: let cookies finish, then switch while A's grant is
      // outstanding. The late grant may not rebuild B's menu.
      await switchTo(indexA)
      await sleep(150)
      const grantBefore = countEvents('grantGet', 'start')
      await ES(`(window.__mogging.browser.openSites(), true)`)
      const grantStarted = await waitEvent('grantGet', 'start', grantBefore + 1)
      await switchTo(indexB)
      const grantFinished = await waitEvent('grantGet', 'finish', grantBefore + 1)
      await sleep(150)
      const grantCleared = await ES<boolean>(`(() => {
        const menu = document.querySelector('.browser-sites-menu')
        return !!menu && menu.hidden && !(menu.textContent ?? '').includes(${JSON.stringify(origin)})
      })()`)

      // Render A once, retain its old Revoke callback, then switch. The switch
      // disconnects the control, and even a synthetic late click cannot mutate A
      // or B because the callback validates its captured generation.
      await switchTo(indexA)
      await sleep(150)
      await ES(`window.__mogging.browser.openSites()`)
      const staleSaved = await ES<boolean>(`(() => {
        const button = Array.from(document.querySelectorAll('.browser-sites-forget'))
          .find((el) => (el.textContent ?? '').trim() === 'Revoke')
        window.__browserRaceStaleRevoke = button
        return button instanceof HTMLButtonElement
      })()`)
      await switchTo(indexB)
      const staleDisconnected = await ES<boolean>(`window.__browserRaceStaleRevoke?.isConnected === false`)
      await ES(`window.__browserRaceStaleRevoke?.click()`)
      await sleep(250)
      const staleCallbackOk =
        staleSaved && staleDisconnected &&
        getIntegrationsGrant(wsA).actOrigins.includes(origin) &&
        getIntegrationsGrant(wsB).actOrigins.length === 0
      const sitesRaceOk =
        sitesStarted && sitesFinished && sitesCleared &&
        grantStarted && grantFinished && grantCleared && staleCallbackOk

      const auditEvents = events()
      const pass = baseRaceOk && navigationRaceOk && profileRaceOk && sitesRaceOk
      result = {
        pass,
        baseRaceOk,
        navigationRaceOk,
        profileRaceOk,
        sitesRaceOk,
        sitesCleared,
        grantCleared,
        staleCallbackOk,
        staleConsentApplied,
        staleProfileSet,
        baseUi,
        navUi,
        auditEvents
      }
    } catch (error) {
      result = { pass: false, error: String(error), auditEvents: browserRaceAudit()?.events ?? [] }
    }
    setBrowserRaceAudit(null)
    server?.close()
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
