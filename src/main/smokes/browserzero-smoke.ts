import { app, BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserChannels } from '@contracts'
import { dockDebug } from '../browser-dock'
import { getSettingsStore } from '../app-settings'
import { failNextConsentSet } from '../browserzero-audit-faults'

/**
 * Env-gated zero-workspace browser gate (MOGGING_BROWSERZERO — audit findings 28, 29, 33,
 * 33b; recut 2026-07-17 to the zero-workspace LOCKDOWN). Everything here is driven through
 * the REAL chrome: the titlebar globe, the URL bar, the rail's ×, the Settings switch. A
 * control the smoke reaches around is a control the user is still alone with.
 *
 *   1. Boot with ZERO workspaces: the dock cannot OPEN at all. The globe reads DISABLED
 *      and says why; the click and ⌘+Shift+U both funnel into the same toggle() refusal.
 *      (The previous contract opened an is-no-workspace husk with its chrome disabled —
 *      the lockdown replaced open-but-inert with refused-with-a-reason, matching the
 *      file-explorer and rail toggles.)
 *   2. Create a workspace: the globe wakes, the dock opens, its chrome is live, and a
 *      real navigate lands.
 *   3. Close the sole workspace through the rail's own ×: the dock FORCE-CLOSES (not a
 *      husk — gone), the globe reads disabled-with-reason again. (The transition, not
 *      just the boot state.) The open PREFERENCE survives: when the next workspace is
 *      created (arm 5), the dock returns by itself.
 *   4. Consent with no workspace: the switch cannot be clicked at all, and says why.
 *   5. Consent when the write FAILS (fault-injected): the switch REVERTS, an error is
 *      shown, and a real consentGet readback — not the DOM — is still false.
 *   6. Positive control: with no fault armed, it stays on AND reads back true.
 *   7. ⌘+Shift+U toggles the dock (finding 28: it checked ctrlKey only, so the dock's one
 *      shortcut was dead on every Mac), and does NOT while a modal is open (finding 29),
 *      with a positive control once the modal is gone.
 *
 * The page is served by THIS smoke on 127.0.0.1 — no external network, ever.
 */
const PAGE_TITLE = 'MOG_BROWSERZERO_4242'

interface DockProbe {
  visible: boolean
  noWorkspaceClass: boolean
  urlDisabled: boolean
  reloadDisabled: boolean
  profileDisabled: boolean
  emptyShown: boolean
  emptyText: string
}
interface ConsentProbe {
  found: boolean
  disabled: boolean
  checked: boolean
  noteShown: boolean
  noteText: string
}

export function runBrowserZeroSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  let server: Server | null = null

  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'browserzero-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  const serve = (): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<!doctype html><title>${PAGE_TITLE}</title><h1>zero-workspace smoke</h1>`)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server?.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

  // ── Renderer probes. Every one ends on a PLAIN OBJECT of primitives: an ES expression
  //    that lands on a DOM node or a bridge handle dies in structured clone. ──────────
  const dockProbe = (): Promise<DockProbe> =>
    ES<DockProbe>(`(() => {
      const dock = document.querySelector('.browser-dock')
      const url = document.querySelector('.browser-url')
      const reload = document.querySelector('.browser-dock-header .icon-btn[aria-label="Reload"]')
      const prof = document.querySelector('.browser-profile-opt')
      const empty = document.querySelector('.browser-empty')
      return {
        visible: !!dock && !dock.hidden && dock.getBoundingClientRect().width > 0,
        noWorkspaceClass: !!dock && dock.classList.contains('is-no-workspace'),
        urlDisabled: url instanceof HTMLInputElement && url.disabled,
        reloadDisabled: reload instanceof HTMLButtonElement && reload.disabled,
        profileDisabled: prof instanceof HTMLButtonElement && prof.disabled,
        emptyShown: !!empty && !empty.hidden,
        emptyText: empty ? (empty.textContent || '') : ''
      }
    })()`)

  /** The titlebar globe — the control a human actually has. */
  const clickBrowserToggle = (): Promise<boolean> =>
    ES<boolean>(`(() => {
      const b = document.querySelector('.titlebar-right button[aria-label="Browser"]')
      if (!(b instanceof HTMLButtonElement)) return false
      b.click()
      return true
    })()`)

  const isOpen = (): Promise<boolean> => ES<boolean>('window.__mogging.browser.isOpen() === true')

  /** Type a url into the REAL URL bar and press Enter — the control finding 33 found dead. */
  const typeUrlAndEnter = (url: string): Promise<boolean> =>
    ES<boolean>(`(() => {
      const input = document.querySelector('.browser-url')
      if (!(input instanceof HTMLInputElement) || input.disabled) return false
      input.focus()
      input.value = ${JSON.stringify(url)}
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return true
    })()`)

  const consentRowJs = `Array.from(document.querySelectorAll('section[data-section="browser"] .toggle-row'))
        .find((r) => (r.textContent || '').includes('Agents may drive the browser'))`

  const consentProbe = (): Promise<ConsentProbe> =>
    ES<ConsentProbe>(`(() => {
      const row = ${consentRowJs}
      const input = row ? row.querySelector('input.switch-input') : null
      const note = row ? row.querySelector('.browser-consent-note') : null
      return {
        found: input instanceof HTMLInputElement,
        disabled: input instanceof HTMLInputElement && input.disabled,
        checked: input instanceof HTMLInputElement && input.checked,
        noteShown: note instanceof HTMLElement && !note.hidden,
        noteText: note instanceof HTMLElement ? (note.textContent || '') : ''
      }
    })()`)

  /** Click the switch exactly as a human would. A DISABLED form control ignores .click()
   *  per spec (no click event, no .checked flip, no change) — which is arm 4's whole point. */
  const clickConsent = (): Promise<boolean> =>
    ES<boolean>(`(() => {
      const row = ${consentRowJs}
      const input = row ? row.querySelector('input.switch-input') : null
      if (!(input instanceof HTMLInputElement)) return false
      input.click()
      return true
    })()`)

  const dangerToastText = (): Promise<string> =>
    ES<string>(`(() => {
      const t = document.querySelector('.toast.toast--danger')
      return t ? (t.textContent || '') : ''
    })()`)

  const clearToasts = (): Promise<boolean> =>
    ES<boolean>(`(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); return true })()`)

  /** The REAL grant, straight off the same IPC channel Settings uses — never the DOM.
   *  executeJavaScript resolves the promise for us, and it lands on a boolean (not a
   *  bridge handle), which is the only kind of value that survives structured clone. */
  const consentReadback = (wsId: string): Promise<boolean> =>
    ES<boolean>(`window.bridge.invoke(${JSON.stringify(BrowserChannels.consentGet)}, ${JSON.stringify(wsId)})`)

  /** ⌘+Shift+U, metaKey ONLY (finding 28). Dispatched on <body> with nothing focused: a
   *  real keypress inside a text field is refused by design (finding 29), and opening the
   *  dock parks the caret in its URL bar. */
  const pressMetaShiftU = (): Promise<boolean> =>
    ES<boolean>(`(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'u', code: 'KeyU', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })
      )
      return true
    })()`)

  const modalOpen = (): Promise<boolean> => ES<boolean>(`!!document.querySelector('.modal-overlay')`)
  const clickWsClose = (wsId: string): Promise<boolean> =>
    ES<boolean>(`(() => {
      const x = document.querySelector('.workspace-tab[data-ws-id="${wsId}"] .ws-close')
      if (!(x instanceof HTMLButtonElement)) return false
      x.click()
      return true
    })()`)
  const clickModal = (which: 'danger' | 'ghost'): Promise<boolean> =>
    ES<boolean>(`(() => {
      const b = document.querySelector('.modal .btn--${which}')
      if (!(b instanceof HTMLButtonElement)) return false
      b.click()
      return true
    })()`)
  const wsCount = (): Promise<number> => ES<number>('window.__mogging.workspace.count()')
  const activeWs = (): Promise<{ id: string; ordinal: number }> =>
    ES<{ id: string; ordinal: number }>('window.__mogging.workspace.active()')
  // The stored grant key, spelled the way browser-dock.ts spells it (kvConsent).
  const storedConsent = (wsId: string): string | null => getSettingsStore()?.getSetting(`browser.agentControl.${wsId}`) ?? null

  const openSettingsBrowserTab = async (): Promise<void> => {
    // Via home, always: setActiveView() early-returns when the view is unchanged, so
    // entering Settings from Settings fires no onViewChange — and pullConsent(), which
    // re-derives whether the switch may be touched at all, would never run.
    await ES(`(window.__mogging.view('home'), 1)`)
    await sleep(200)
    await ES(`(window.__mogging.view('settings'), 1)`)
    await ES(`(window.__mogging.settingsTab('browser'), 1)`)
    await sleep(700) // pullConsent() is an IPC round-trip on view entry
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      const port = await serve()

      // ── 1. Zero workspaces: the dock cannot OPEN, and the globe says why ─────
      const bootWorkspaces = await wsCount()
      const zeroToggle = await ES<{ disabled: boolean; title: string }>(`(() => {
        const b = document.querySelector('.titlebar-right button[aria-label="Browser"]')
        return { disabled: b instanceof HTMLButtonElement && b.disabled, title: b ? b.title : '' }
      })()`)
      const toggleClicked = await clickBrowserToggle() // a disabled control ignores this, by spec
      await pressMetaShiftU() // ...and the shortcut funnels into the same toggle() refusal
      await sleep(700)
      const zeroBoot = await dockProbe()
      const zeroOpen = await isOpen()
      const zeroBootOk =
        bootWorkspaces === 0 &&
        zeroToggle.disabled &&
        /create a workspace first/i.test(zeroToggle.title) && // the tooltip carries the reason
        toggleClicked &&
        !zeroOpen &&
        !zeroBoot.visible // refused at the capability — never an inert husk on screen

      // ── 2. A workspace exists: the globe wakes, the dock opens, and one works ─
      await ES(`window.__mogging.workspace.create({ name: 'Zero' })`)
      await sleep(2000)
      const wsA = (await activeWs()).id
      const wokenToggle = await ES<{ disabled: boolean; title: string }>(`(() => {
        const b = document.querySelector('.titlebar-right button[aria-label="Browser"]')
        return { disabled: b instanceof HTMLButtonElement && b.disabled, title: b ? b.title : '' }
      })()`)
      await clickBrowserToggle() // the human's open — arm 1's click was refused
      await sleep(700)
      const liveProbe = await dockProbe()
      const reEnabledOk =
        !wokenToggle.disabled &&
        liveProbe.visible &&
        !liveProbe.noWorkspaceClass &&
        !liveProbe.urlDisabled &&
        !liveProbe.reloadDisabled &&
        !liveProbe.profileDisabled
      const typed = await typeUrlAndEnter(`127.0.0.1:${port}`)
      let titleOk = false
      for (let i = 0; i < 30 && !titleOk; i++) {
        await sleep(400)
        titleOk = (await ES<{ title: string }>('window.__mogging.browser.state()')).title === PAGE_TITLE
      }
      const navOk = typed && titleOk && dockDebug().url.includes(`127.0.0.1:${port}`)

      // ── 3. Close the sole workspace through the RAIL's own × ─────────────────
      await ES(`(window.__mogging.view('grid'), 1)`) // the rail lives in the grid
      await sleep(300)
      await clickWsClose(wsA)
      await sleep(500)
      if (await modalOpen()) await clickModal('danger') // idle panes close without asking; live ones ask
      await sleep(800)
      const closedToZero = (await wsCount()) === 0
      const afterClose = await dockProbe()
      const afterCloseOpen = await isOpen()
      const afterCloseToggle = await ES<{ disabled: boolean; title: string }>(`(() => {
        const b = document.querySelector('.titlebar-right button[aria-label="Browser"]')
        return { disabled: b instanceof HTMLButtonElement && b.disabled, title: b ? b.title : '' }
      })()`)
      const returnsToZeroOk =
        closedToZero &&
        !afterCloseOpen && // FORCE-closed with its workspace — never an inert husk
        !afterClose.visible &&
        afterCloseToggle.disabled &&
        /create a workspace first/i.test(afterCloseToggle.title)

      // ── 4. Consent at zero workspaces: unclickable, explained, unwritten ──────
      await openSettingsBrowserTab()
      const consentZero = await consentProbe()
      const clickedZero = await clickConsent() // a disabled control ignores this, by spec
      await sleep(400)
      const consentZeroAfter = await consentProbe()
      const zeroConsentOk =
        consentZero.found &&
        consentZero.disabled &&
        !consentZero.checked &&
        consentZero.noteShown &&
        /workspace/i.test(consentZero.noteText) &&
        clickedZero &&
        !consentZeroAfter.checked && // it did NOT slide over and stay there
        storedConsent(wsA) !== '1' // and nothing reached the store, for any workspace

      // ── 5. The write FAILS: the switch reverts, says so, and the grant is false ─
      await ES(`window.__mogging.workspace.create({ name: 'Zero B' })`)
      await sleep(2000)
      // The arm-3 force-close never touched the saved preference (the dock was OPEN
      // when its workspace died) — so the next workspace brings it back by itself.
      const reopened = await isOpen()
      const wsB = (await activeWs()).id
      await openSettingsBrowserTab()
      const consentEnabled = await consentProbe()
      await clearToasts()
      failNextConsentSet(1) // main will drop exactly one consentSet on the floor
      await clickConsent()
      await sleep(700)
      const afterFault = await consentProbe()
      const faultToast = await dangerToastText()
      const faultReadback = await consentReadback(wsB)
      const faultRevertOk =
        consentEnabled.found &&
        !consentEnabled.disabled && // a workspace is open: the switch is live again
        !consentEnabled.checked &&
        !afterFault.checked && // REVERTED — the native checkbox had already flipped itself on
        !afterFault.disabled && // and it is usable again, not stuck mid-flight
        /not saved/i.test(faultToast) &&
        faultReadback === false && // the REAL grant, off the real channel
        storedConsent(wsB) !== '1'

      // ── 6. Positive control: no fault armed, so it sticks ─────────────────────
      await clearToasts()
      await clickConsent()
      await sleep(700)
      const afterOk = await consentProbe()
      const okReadback = await consentReadback(wsB)
      const okToast = await dangerToastText()
      const positiveConsentOk = afterOk.checked && !afterOk.disabled && okReadback === true && okToast === ''

      // ── 7. ⌘+Shift+U (28) and the modal guard (29) ────────────────────────────
      const openBefore = await isOpen()
      await pressMetaShiftU()
      await sleep(300)
      const openAfterMeta = await isOpen()
      const metaTogglesOk = openBefore && !openAfterMeta // metaKey alone drives it now

      await ES(`(window.__mogging.view('grid'), 1)`)
      await sleep(300)
      const paneId = (await activeWs()).ordinal * 100 + 1
      await ES(`window.__mogging.attention.setPaneTracked(${paneId}, true)`) // ALERTAGREE: an agent pane's state only counts once tracked
      await ES(`window.__mogging.attention.setPaneState(${paneId}, 'busy')`) // live work -> a REAL confirm
      await clickWsClose(wsB)
      await sleep(500)
      const realModalUp = await modalOpen()
      await pressMetaShiftU()
      await sleep(300)
      const openDuringModal = await isOpen()
      const modalBlocksOk = realModalUp && openDuringModal === openAfterMeta // nothing moved

      await clickModal('ghost') // Cancel — the workspace stays
      await sleep(400)
      const modalGone = !(await modalOpen())
      await pressMetaShiftU()
      await sleep(300)
      const openAfterModalGone = await isOpen()
      const shortcutOk = metaTogglesOk && modalBlocksOk && modalGone && openAfterModalGone === !openAfterMeta

      const pass =
        zeroBootOk &&
        reEnabledOk &&
        navOk &&
        returnsToZeroOk &&
        reopened &&
        zeroConsentOk &&
        faultRevertOk &&
        positiveConsentOk &&
        shortcutOk
      result = {
        pass,
        zeroBootOk,
        zeroToggle,
        zeroOpen,
        reEnabledOk,
        wokenToggle,
        navOk,
        returnsToZeroOk,
        afterCloseOpen,
        afterCloseToggle,
        reopened,
        zeroConsentOk,
        faultRevertOk,
        positiveConsentOk,
        shortcutOk,
        bootWorkspaces,
        zeroBoot,
        liveProbe,
        typed,
        titleOk,
        dockUrl: dockDebug().url,
        closedToZero,
        afterClose,
        consentZero,
        consentZeroAfter,
        storedAfterZeroClick: storedConsent(wsA),
        consentEnabled,
        afterFault,
        faultToast,
        faultReadback,
        afterOk,
        okReadback,
        okToast,
        openBefore,
        openAfterMeta,
        realModalUp,
        openDuringModal,
        modalGone,
        openAfterModalGone
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    server?.close()
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}

// Reference kept so tree-shaking never drops BrowserWindow's typing import.
void BrowserWindow
