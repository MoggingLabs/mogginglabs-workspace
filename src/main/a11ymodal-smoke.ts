import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Audit regression (finding 30) — the three overlay/tab primitives, proved against the real DOM.
 *
 *  A. The shared modal said `aria-modal` and did nothing to back it up: no focus trap, no inert
 *     background. A screen reader was told the dialog was modal while Tab walked a sighted
 *     keyboard user straight out of it into a rail they could not see. Its accessible name was
 *     also COPIED from the title once, at construction — so setTitle() renamed the heading and
 *     left the announced name behind.
 *  B. The palette moved a highlight nobody was told about: no combobox role, no aria-expanded,
 *     no aria-controls, no aria-activedescendant, and it never gave focus back on close.
 *  C. The workspace tab was a div[role=button] CONTAINING the close <button>. Invalid content,
 *     and the wrapper's Enter/Space handler preventDefault()ed the keystroke and switched
 *     workspaces — so the close button could not be activated from the keyboard AT ALL.
 *
 * Every check below fails against the pre-fix code. The inert assertions are deliberately
 * FUNCTIONAL (try to focus the background and watch it refuse), because the tempting half-fix —
 * aria-hidden on the shell — satisfies an attribute check while leaving Tab exactly as broken.
 */
export function runA11yModalSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'a11ymodal-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  const key = (target: string, init: string): Promise<unknown> =>
    ES(`(${target}.dispatchEvent(new KeyboardEvent('keydown', ${init})), 1)`)

  /**
   * A TRUSTED key press — the only kind that can prove section C.
   *
   * Everywhere else this gate dispatches KeyboardEvents on purpose: the focus trap's Tab wrap,
   * the palette's arrows and every Escape are handled in JS, so a synthetic event drives exactly
   * the code under test. C is the one claim that is NOT about a JS handler. The finding-30 fix
   * DELETED the workspace tab's Enter/Space handler — the one that ate the keystroke and switched
   * workspaces — and made the × a real <button>, so its activation belongs to the platform now.
   * A dispatched KeyboardEvent carries NO default action and therefore activates nothing, which
   * makes it the one tool that cannot test this: an assertion built on it passes only while the
   * bug is still there. (The last run said so out loud — enterClosed and spaceClosed were false
   * against a product that is correct.)
   *
   * And a press is THREE events, not two. Blink activates a button from Enter on the `keypress`
   * (HTMLButtonElement's default handler switches on charCode '\r'), never on the keydown, and
   * sendInputEvent forwards exactly what it is handed rather than synthesizing the char the way a
   * native keystroke does. The char's keyCode must be '\r', not 'Enter': its TEXT is what becomes
   * keypress.charCode and Electron copies that text verbatim, so 'Enter' would deliver charCode
   * 'E' to a button waiting for 13. Space is the mirror image and needs no char — keydown arms
   * the button, keyup fires it.
   */
  const press = async (keyCode: string): Promise<void> => {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(60)
  }
  /**
   * Focus a tab's × the way a human reaches it. The × is `display: none` until the tab has focus
   * WITHIN it (the reveal grammar CHROMEUX (i) guards), and a display:none element cannot take
   * focus — so the activate button is the doorway, exactly as it is for a user tabbing along the
   * rail. Reaching straight for the × with .focus() is a no-op that fails for a reason which has
   * nothing to do with what this gate is about.
   */
  const focusClose = (wsId: string): Promise<boolean> =>
    ES<boolean>(`(() => {
      const tab = document.querySelector('.workspace-tab[data-ws-id="${wsId}"]')
      if (!tab) return false
      const activate = tab.querySelector('.ws-tab-activate')
      const close = tab.querySelector('.ws-close')
      if (!activate || !close) return false
      activate.focus()
      close.focus()
      return document.activeElement === close
    })()`)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let stage = 'boot'
    try {
      await sleep(1500)
      // Two workspaces: closing one must not collide with the last-workspace → Home path.
      await ES('window.__mogging.workspace.create({ name: "Alpha" })')
      await sleep(900)
      await ES('window.__mogging.workspace.create({ name: "Beta" })')
      await sleep(900)

      // ── A. The modal (driven through the ? shortcuts sheet — the simplest createModal
      //    consumer that is always available). ──
      stage = 'modal'
      await ES(`(document.querySelector('.palette-trigger')?.focus(), 1)`)
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))`)
      await sleep(450)

      const modal = await ES<Record<string, unknown>>(`(() => {
        const overlay = document.querySelector('.modal-overlay')
        const panel = overlay && overlay.querySelector('.modal')
        const shell = document.getElementById('app')
        if (!overlay || !panel || !shell) return { ok: false, reason: 'no modal' }

        const focusInside = overlay.contains(document.activeElement)
        const inertSet = shell.inert === true

        // FUNCTIONAL inert: ask a background control for focus and watch it be REFUSED.
        // aria-hidden alone would sail through an attribute check and still let Tab walk out.
        const bg = document.querySelector('.palette-trigger')
        bg && bg.focus()
        const inertRefusesFocus = document.activeElement !== bg

        // The name must POINT at the heading, not copy it — that is what makes setTitle() safe.
        const labelledby = panel.getAttribute('aria-labelledby')
        const heading = labelledby ? document.getElementById(labelledby) : null
        const namedByHeading = !!heading && (heading.textContent || '').trim().length > 0
        const noStaleLabel = !panel.hasAttribute('aria-label')

        const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
        const items = [...panel.querySelectorAll(FOCUSABLE)].filter((n) => !n.hidden)
        window.__a11yFirst = items[0] || null
        window.__a11yLast = items[items.length - 1] || null
        return {
          ok: focusInside && inertSet && inertRefusesFocus && namedByHeading && noStaleLabel && items.length > 0,
          focusInside, inertSet, inertRefusesFocus, namedByHeading, noStaleLabel, focusables: items.length,
          ariaModal: panel.getAttribute('aria-modal')
        }
      })()`)

      // Tab must WRAP at the last control rather than escaping into the (inert) shell.
      await ES(`(window.__a11yLast && window.__a11yLast.focus(), 1)`)
      await key('window.__a11yLast', `{ key: 'Tab', bubbles: true, cancelable: true }`)
      await sleep(120)
      const wrapForward = await ES<boolean>(`document.activeElement === window.__a11yFirst`)

      await ES(`(window.__a11yFirst && window.__a11yFirst.focus(), 1)`)
      await key('window.__a11yFirst', `{ key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }`)
      await sleep(120)
      const wrapBack = await ES<boolean>(`document.activeElement === window.__a11yLast`)

      // Escape closes AND hands focus back to whatever opened it.
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
      await sleep(400)
      const afterModal = await ES<Record<string, unknown>>(`(() => {
        const shell = document.getElementById('app')
        return {
          closed: !document.querySelector('.modal-overlay'),
          uninert: shell.inert === false,
          focusReturned: document.activeElement === document.querySelector('.palette-trigger')
        }
      })()`)

      // ── B. The palette, as a real combobox. ──
      stage = 'palette'
      await ES(`(document.querySelector('.palette-trigger')?.focus(), 1)`)
      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`)
      await sleep(450)

      const palette = await ES<Record<string, unknown>>(`(() => {
        const input = document.querySelector('.palette-input')
        const list = document.querySelector('.palette-list')
        const shell = document.getElementById('app')
        if (!input || !list) return { ok: false, reason: 'no palette' }
        const items = [...document.querySelectorAll('.palette-item')]
        const controls = input.getAttribute('aria-controls')
        const ids = items.map((n) => n.id)
        const selected = items.find((n) => n.getAttribute('aria-selected') === 'true')
        const activeDesc = input.getAttribute('aria-activedescendant')
        return {
          ok:
            input.getAttribute('role') === 'combobox' &&
            input.getAttribute('aria-expanded') === 'true' &&
            input.getAttribute('aria-autocomplete') === 'list' &&
            !!controls && document.getElementById(controls) === list &&
            items.length > 0 &&
            ids.every((id) => !!id) && new Set(ids).size === ids.length &&
            items.every((n) => n.getAttribute('role') === 'option') &&
            items.every((n) => n.tabIndex === -1) &&      // ONE tab stop: the input
            !!selected && activeDesc === selected.id &&    // the highlight is finally announced
            shell.inert === true &&
            document.activeElement === input,
          role: input.getAttribute('role'),
          expanded: input.getAttribute('aria-expanded'),
          controlsResolves: !!controls && document.getElementById(controls) === list,
          options: items.length,
          activeDesc, selectedId: selected ? selected.id : null,
          allOptionsUntabbable: items.every((n) => n.tabIndex === -1),
          inert: shell.inert === true
        }
      })()`)

      // ArrowDown moves the announced highlight while real focus stays on the input.
      const before = await ES<string>(`document.querySelector('.palette-input').getAttribute('aria-activedescendant')`)
      await key(`document.querySelector('.palette-input')`, `{ key: 'ArrowDown', bubbles: true, cancelable: true }`)
      await sleep(200)
      const arrowed = await ES<Record<string, unknown>>(`(() => {
        const input = document.querySelector('.palette-input')
        const now = input.getAttribute('aria-activedescendant')
        const sel = document.querySelector('.palette-item[aria-selected="true"]')
        return { now, tracksSelection: !!sel && sel.id === now, focusStillInput: document.activeElement === input }
      })()`)
      const arrowOk =
        arrowed.now !== before && arrowed.tracksSelection === true && arrowed.focusStillInput === true

      await ES(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
      await sleep(350)
      const paletteReturned = await ES<boolean>(
        `document.activeElement === document.querySelector('.palette-trigger') && document.getElementById('app').inert === false`
      )

      // ── C. The workspace tab: sibling buttons, and a close that the keyboard can reach. ──
      stage = 'tab'
      const structure = await ES<Record<string, unknown>>(`(() => {
        const closes = [...document.querySelectorAll('.workspace-tab .ws-close')]
        if (!closes.length) return { ok: false, reason: 'no tabs' }
        // No interactive ANCESTOR: walk up from the close button's parent. A button inside a
        // button is the invalid content that made this unreachable in the first place.
        const nested = closes.some((c) => !!c.parentElement.closest('button, [role="button"], a[href]'))
        const tabsNotButtons = [...document.querySelectorAll('.workspace-tab')].every(
          (t) => t.getAttribute('role') !== 'button' && !t.hasAttribute('tabindex')
        )
        const activateReal = [...document.querySelectorAll('.workspace-tab')].every(
          (t) => t.querySelector('.ws-tab-activate') instanceof HTMLButtonElement
        )
        return { ok: !nested && tabsNotButtons && activateReal, nested, tabsNotButtons, activateReal }
      })()`)

      // The regression itself: focus the close button of the NON-active workspace and press
      // Enter. Before the fix the wrapper ate the key and SWITCHED to that workspace instead.
      const alpha = await ES<{ id: string } | null>(
        `(() => { const w = window.__mogging.workspace.list().find((w) => w.name === 'Alpha'); return w ? { id: w.id } : null })()`
      )
      const activeBefore = await ES<string>(`window.__mogging.workspace.active().id`)
      // Trusted input goes to whatever the PAGE has focused, so the window must genuinely hold
      // focus first (boardrender's precedent). Then: reveal the ×, focus it, press Enter — the
      // exact sequence a keyboard user performs, and the one finding 30 says was impossible.
      win.focus()
      wc.focus()
      await sleep(150)
      const closeFocusable = await focusClose(alpha?.id ?? '')
      await press('Enter')
      await sleep(700)
      const afterEnter = await ES<Record<string, unknown>>(`(() => ({
        gone: !window.__mogging.workspace.list().some((w) => w.id === '${alpha?.id}'),
        active: window.__mogging.workspace.active() ? window.__mogging.workspace.active().id : null
      }))()`)
      // Closed by the keyboard, and it never switched to the workspace it was closing.
      const enterClosed = afterEnter.gone === true && afterEnter.active === activeBefore

      // Space is the button's other native activation — same contract, same road to it.
      await ES('window.__mogging.workspace.create({ name: "Gamma" })')
      await sleep(900)
      const gamma = await ES<{ id: string } | null>(
        `(() => { const w = window.__mogging.workspace.list().find((w) => w.name === 'Gamma'); return w ? { id: w.id } : null })()`
      )
      const gammaCloseFocusable = await focusClose(gamma?.id ?? '')
      await press('Space')
      await sleep(700)
      const spaceClosed = await ES<boolean>(
        `!window.__mogging.workspace.list().some((w) => w.id === '${gamma?.id}')`
      )

      // Non-regression: the activate button still switches on Enter (the verb we moved).
      await ES('window.__mogging.workspace.create({ name: "Delta" })')
      await sleep(900)
      const beta = await ES<{ id: string } | null>(
        `(() => { const w = window.__mogging.workspace.list().find((w) => w.name === 'Beta'); return w ? { id: w.id } : null })()`
      )
      await ES(`(document.querySelector('.workspace-tab[data-ws-id="${beta?.id}"] .ws-tab-activate').focus(), 1)`)
      await ES(`(document.querySelector('.workspace-tab[data-ws-id="${beta?.id}"] .ws-tab-activate').click(), 1)`)
      await sleep(600)
      const activateSwitches = await ES<boolean>(`window.__mogging.workspace.active().id === '${beta?.id}'`)

      const modalOk = modal.ok === true && wrapForward && wrapBack &&
        afterModal.closed === true && afterModal.uninert === true && afterModal.focusReturned === true
      const paletteOk = palette.ok === true && arrowOk && paletteReturned
      const tabOk =
        structure.ok === true && closeFocusable && gammaCloseFocusable &&
        enterClosed && spaceClosed && activateSwitches

      result = {
        pass: modalOk && paletteOk && tabOk,
        modalOk, paletteOk, tabOk,
        modal, wrapForward, wrapBack, afterModal,
        palette, arrowOk, arrowed, paletteReturned,
        structure, closeFocusable, gammaCloseFocusable, enterClosed, afterEnter, spaceClosed, activateSwitches
      }
    } catch (e) {
      result = { pass: false, stage, error: String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}
