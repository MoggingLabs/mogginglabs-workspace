import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Env-gated Board render/keyboard regression gate (MOGGING_BOARDRENDER) — audit findings 28,
 * 29, 31, 37.
 *
 * The board is a surface that REBUILDS ITSELF ON SOMEONE ELSE'S SCHEDULE. Every external push —
 * a GitHub link status, an attention change, an approval, a pane's cwd going away, the agent
 * roster reloading — ran `root.replaceChildren()` and rebuilt every lane. Three things died with
 * that DOM, and a user notices all three:
 *
 *   (1) FOCUS. The ⋯ you had tabbed to was thrown away. activeElement fell to <body>. A
 *       keyboard user was returned to the start of the document every few seconds.
 *   (2) SCROLL. `.board-lane-cards` is a per-lane scroll container, so a lane you had scrolled
 *       down snapped back to the top. Mid-read, mid-drag, unasked.
 *   (3) A DOCUMENT-LEVEL LISTENER. The old hand-rolled ⋯ menu registered its outside-click
 *       handler on `document` and removed it only from its own closeMenu(). render() never closed
 *       a menu it was about to destroy, so the handler outlived the DOM it closed over — one more
 *       orphan for every open-then-push cycle, healing only on the next click anywhere.
 *
 * And the two keyboard findings that surround it: the Board's shortcut tested `e.ctrlKey` alone
 * (dead on macOS, finding 28) and fired into modals and text fields (finding 29); the ⋯ menu had
 * no role, no keys, no focus return, and card movement was drag-only — a mouse-only path to the
 * board's whole point (finding 31).
 *
 * The five assertions below each fail against the pre-fix Board. They are driven through the REAL
 * renderer: the fixture is a real card bound to a fake pane id, and the "push" is a real
 * attention-port state change on an UNRELATED pane — a rebuild with zero visual consequence, which
 * is exactly the push a user must never feel.
 */
export function runBoardRenderSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const waitTrue = async (js: string, tries = 30, gap = 200): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await ES<boolean>(js).catch(() => false)) return true
      await sleep(gap)
    }
    return false
  }
  /**
   * A TRUSTED key press. This is not decoration: an untrusted `new KeyboardEvent('keydown')` runs
   * JS handlers but performs NO default action — synthetic Tab does not move focus, and synthetic
   * Enter on a <button> does not activate it. Proving "a keyboard user can reach the ⋯ and move a
   * card" therefore requires real input from the main process (the precedent is gallery.ts's
   * focus-visible walk). The menu's ARROW keys are a different matter — the context-menu primitive
   * handles those in JS — so those stay dispatched KeyboardEvents, as the audit asked.
   *
   * ...and a trusted press is THREE events, not two. Blink activates a <button> from Enter on the
   * `keypress` — HTMLButtonElement's default handler switches on charCode '\r' — and NOT on the
   * keydown. A real OS keystroke produces keydown → keypress → keyup as one native gesture;
   * `sendInputEvent` does no such thing, it forwards exactly the events you hand it. keyDown+keyUp
   * is therefore a keystroke a button never feels: it reached the ⋯ (Tab moves focus off the
   * keydown, which is why the walk worked) and then pressed nothing.
   *
   * The char's keyCode must be '\r' and not 'Enter': the char event's TEXT is what becomes
   * keypress.charCode, and Electron fills that text verbatim from this string — 'Enter' would
   * deliver charCode 'E' to a button waiting for 13. (Space needs no char: keydown arms it,
   * keyup fires it.)
   */
  const press = async (keyCode: string): Promise<void> => {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(45)
  }
  /** The two chord dispatches, one per modifier: Ctrl is what the OLD code honoured (so a "must
   *  not fire" assertion built on it genuinely fails pre-fix) and ⌘ is finding 28 itself. */
  const chord = (target: string, mods: 'ctrl' | 'meta'): string =>
    `${target}.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', code: 'KeyG', ${mods === 'ctrl' ? 'ctrlKey' : 'metaKey'}: true, shiftKey: true, bubbles: true }))`
  /** The active view, read the way the app writes it (#content carries `view-<name>`). */
  const VIEW = `(document.getElementById('content')?.className ?? '')`

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1800)
      await ES(`window.__mogging.view('board')`)
      await waitTrue(`!!document.querySelector('#content.view-board')`)
      await sleep(300)

      // ── fixture ─────────────────────────────────────────────────────────────
      // One tracked card bound to a fixture pane id (no launch — board:save writes the binding
      // straight to the db, then refresh() pulls it into the in-memory list), plus enough backlog
      // cards to make the "todo" lane genuinely overflow. The binding matters: the board only
      // re-renders on an attention push when SOME card holds a paneId.
      const cardId = await ES<string>(
        `window.__mogging.board.createCard('Rebuild survivor', 'Focus and scroll must survive a push.')`
      )
      const CARD = JSON.stringify(cardId)
      const cardSel = `.board-card[data-card-id=${CARD}]`
      const CARDSEL = JSON.stringify(cardSel)
      const MORE = JSON.stringify(`${cardSel} .board-card-more`)
      const IN_DOING = JSON.stringify(`.board-lane[data-lane="doing"] ${cardSel}`)
      await ES(`(async () => {
        const c = window.__mogging.board.list().find((x) => x.id === ${CARD})
        if (c) { await window.bridge.invoke('board:patch', { id: c.id, patch: { paneId: 101, workspaceId: 'fx-ws' } }); await window.__mogging.board.refresh() }
        return 1
      })()`)
      await ES(`window.__mogging.attention.setPaneState(101, 'busy')`)
      await ES(`(() => { for (let i = 0; i < 12; i++) window.__mogging.board.createCard('Backlog ' + i, ''); return 1 })()`)
      const laneFilled = await waitTrue(
        `document.querySelectorAll('.board-lane[data-lane="todo"] .board-card').length >= 13`
      )
      // THE PUSH, in one place. It flips an UNRELATED pane's state, so the board rebuilds with no
      // visual change to any card — isolating the rebuild itself from any layout the card's own
      // chip might have shifted. Alternating is not optional: setPaneState is a no-op when the
      // state is unchanged, and a push that never fires proves nothing.
      await ES(`(() => {
        let n = 0
        window.__boardPush = () => {
          n += 1
          window.__mogging.attention.setPaneState(901, n % 2 ? 'attention' : 'busy')
          return n
        }
        return 1
      })()`)
      await sleep(300)

      // ── (1) a push must not steal FOCUS ─────────────────────────────────────
      // "Still inside the board" is not the claim. The claim is that the caret is on the SAME
      // control of the SAME card — a rebuilt node, re-found by identity (data-card-id), which is
      // the only thing that survives replaceChildren().
      await ES(`(document.querySelector(${MORE}).focus(), 1)`)
      const focusBefore = await ES<boolean>(`document.activeElement === document.querySelector(${MORE})`)
      await ES(`window.__boardPush()`)
      await sleep(150)
      await ES(`window.__boardPush()`)
      await sleep(250)
      const focusAfter = await ES<{ isMore: boolean; cardId: string | null; tag: string }>(`(() => {
        const a = document.activeElement
        return {
          isMore: a instanceof HTMLElement && a.classList.contains('board-card-more'),
          cardId: a instanceof HTMLElement ? a.closest('.board-card')?.dataset.cardId ?? null : null,
          tag: a instanceof HTMLElement ? a.tagName : String(a && a.nodeName)
        }
      })()`)
      const focusKept = focusBefore && focusAfter.isMore && focusAfter.cardId === cardId

      // ── (2) a push must not reset a lane's SCROLL ───────────────────────────
      const scrolled = await ES<{ top: number; max: number }>(`(() => {
        const list = document.querySelector('.board-lane[data-lane="todo"] .board-lane-cards')
        list.scrollTop = 1e6
        const max = list.scrollTop // the browser clamps: this IS the lane's scroll range
        list.scrollTop = Math.min(120, max)
        return { top: list.scrollTop, max }
      })()`)
      await ES(`window.__boardPush()`)
      await sleep(250)
      const scrollAfter = await ES<number>(
        `document.querySelector('.board-lane[data-lane="todo"] .board-lane-cards').scrollTop`
      )
      // A lane that cannot scroll would make this assertion vacuous — so "it really overflowed" is
      // part of the verdict, not an assumption.
      const scrollKept = laneFilled && scrolled.max > 0 && scrolled.top > 0 && Math.abs(scrollAfter - scrolled.top) <= 1

      // ── (3) an open menu must not LEAK a document-level listener per rebuild ─
      // getEventListeners() is a DevTools-only function, so the count comes from an in-page spy
      // that wraps document.add/removeEventListener and tracks only (document, 'pointerdown')
      // pairs. Everything before the spy is invisible to it, which is exactly what we want: it
      // measures the DELTA the board is responsible for, not the app's baseline.
      await ES(`(() => {
        if (window.__pdSpy) return 1
        const add = document.addEventListener.bind(document)
        const rm = document.removeEventListener.bind(document)
        const live = []
        const cap = (o) => o === true || (!!o && o.capture === true)
        document.addEventListener = function (type, fn, opts) {
          if (type === 'pointerdown') live.push({ fn, capture: cap(opts) })
          return add(type, fn, opts)
        }
        document.removeEventListener = function (type, fn, opts) {
          if (type === 'pointerdown') {
            const i = live.findIndex((e) => e.fn === fn && e.capture === cap(opts))
            if (i >= 0) live.splice(i, 1)
          }
          return rm(type, fn, opts)
        }
        window.__pdSpy = live
        return 1
      })()`)
      const pdBefore = await ES<number>(`window.__pdSpy.length`)
      // .click() and NOT a real pointer press, deliberately: a real pointerdown would fire every
      // stale outside-click handler still attached to document, each of which removes itself — the
      // leak self-heals the moment you touch anything. Opening the menu with a bare click event is
      // the only way to SEE it accumulate.
      const OPENS = 4
      for (let i = 0; i < OPENS; i++) {
        await ES(`(document.querySelector(${MORE}).click(), 1)`)
        await sleep(120)
        await ES(`window.__boardPush()`) // a rebuild underneath an open menu
        await sleep(150)
      }
      const pdAfter = await ES<number>(`window.__pdSpy.length`)
      // <= 1, not 0: a menu legitimately holds ONE while it is up. Pre-fix this reads OPENS.
      const noLeak = pdAfter - pdBefore <= 1

      // ── (4) a card must be movable BY KEYBOARD ──────────────────────────────
      // Tab (trusted) to the card's ⋯, Enter (trusted) to open, ArrowDown (dispatched — the
      // primitive handles it in JS) to reach "Move to Doing", Enter (trusted) to run it. No
      // .click() anywhere on this path: the point is that a keyboard alone can do it.
      win.focus()
      wc.focus()
      await ES(`(document.activeElement instanceof HTMLElement && document.activeElement.blur(), 1)`)
      let tabHops = 0
      let reachedByTab = false
      for (; tabHops < 80 && !reachedByTab; tabHops++) {
        await press('Tab')
        reachedByTab = await ES<boolean>(`document.activeElement === document.querySelector(${MORE})`)
      }
      // Guarded: a trusted Enter into whatever the walk landed on instead would ACTIVATE it — a
      // titlebar button, say — and quietly corrupt every assertion after this one. A gate that
      // fails must fail on its own claim, not on collateral damage.
      if (reachedByTab) await press('Enter')
      const menuUp = reachedByTab && (await waitTrue(`!!document.querySelector('.ctx-menu [role="menuitem"]')`, 20, 150))
      const menu = await ES<{
        role: string | null
        items: string[]
        focusIdx: number
        moveIdx: number
        haspopup: string | null
        expanded: string | null
      }>(`(() => {
        const m = document.querySelector('.ctx-menu')
        const items = [...(m?.querySelectorAll('.ctx-item:not(:disabled)') ?? [])]
        const labels = items.map((b) => (b.textContent || '').trim())
        const trigger = document.querySelector(${MORE})
        return {
          role: m?.getAttribute('role') ?? null,
          items: labels,
          focusIdx: items.indexOf(document.activeElement),
          moveIdx: labels.indexOf('Move to Doing'),
          haspopup: trigger?.getAttribute('aria-haspopup') ?? null,
          expanded: trigger?.getAttribute('aria-expanded') ?? null
        }
      })()`)
      // Roving focus starts on the first item; walk down to the Move verb.
      const steps = menu.moveIdx >= 0 && menu.focusIdx >= 0 ? menu.moveIdx - menu.focusIdx : -1
      for (let i = 0; i < steps; i++) {
        await ES(`(document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })), 1)`)
        await sleep(40)
      }
      const focusedItem = await ES<string>(`(document.activeElement?.textContent ?? '').trim()`)
      await press('Enter')
      await sleep(450)
      const moved = await ES<{ dom: boolean; model: string | null; menuGone: boolean; expandedAfter: string | null }>(`(() => {
        const c = window.__mogging.board.list().find((x) => x.id === ${CARD})
        const trigger = document.querySelector(${MORE})
        return {
          // BOTH, or it does not count: the lane a card is drawn in and the lane it is SAVED in
          // must agree — a move that only repaints is a move the next reload forgets.
          dom: !!document.querySelector(${IN_DOING}),
          model: c?.lane ?? null,
          menuGone: !document.querySelector('.ctx-menu'),
          // The rebuild that the move triggered handed the caret back to the card's ⋯ in its NEW
          // lane — capture/restore and the menu port, proving each other.
          expandedAfter: trigger?.getAttribute('aria-expanded') ?? null
        }
      })()`)
      const keyboardMove =
        reachedByTab &&
        menuUp &&
        menu.role === 'menu' &&
        menu.haspopup === 'menu' &&
        menu.expanded === 'true' &&
        menu.moveIdx >= 0 &&
        focusedItem === 'Move to Doing' &&
        moved.dom &&
        moved.model === 'doing' &&
        moved.menuGone &&
        moved.expandedAfter === 'false'

      // ── (5) the shortcut: ⌘ works (28), and it holds its tongue (29) ────────
      await ES(`window.__mogging.view('board')`)
      await waitTrue(`!!document.querySelector('#content.view-board')`)
      // …with a real blocking modal up (the card editor). e.target is `window`, never the modal's
      // input, so ONLY isBlockingModalOpen() can refuse this — the modal branch, isolated.
      await ES(`(document.querySelector(${CARDSEL}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), 1)`)
      const modalUp = await waitTrue(`!!document.querySelector('.modal-overlay')`)
      await ES(`(${chord('window', 'ctrl')}, ${chord('window', 'meta')}, 1)`)
      await sleep(250)
      const viewUnderModal = await ES<string>(VIEW)
      const blockedByModal = modalUp && viewUnderModal.includes('view-board')
      await ES(`([...document.querySelectorAll('.modal-overlay button')].find((b) => (b.textContent || '').trim() === 'Cancel')?.click(), 1)`)
      await waitTrue(`!document.querySelector('.modal-overlay')`)

      // …and while TYPING. The palette is deliberately NOT a .modal-overlay (its own search box is
      // an <input>, and a palette that disabled every command would be a joke), so its input
      // isolates the OTHER branch of the guard: an editable target.
      // Re-seat the view first: a PRE-FIX run has already been toggled off the board by the modal
      // step above, and starting this one from the wrong view would let a toggle READ as a refusal.
      await ES(`window.__mogging.view('board')`)
      await waitTrue(`!!document.querySelector('#content.view-board')`)
      await ES(`(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })), 1)`)
      const paletteUp = await waitTrue(`!!document.querySelector('.palette-overlay:not([hidden]) .palette-input')`)
      await ES(`(() => {
        const i = document.querySelector('.palette-input')
        i.focus()
        ${chord('i', 'ctrl')}
        ${chord('i', 'meta')}
        return 1
      })()`)
      await sleep(250)
      const viewWhileTyping = await ES<string>(VIEW)
      const blockedWhileTyping = paletteUp && viewWhileTyping.includes('view-board')
      await ES(`(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 1)`)
      await waitTrue(`!document.querySelector('.palette-overlay:not([hidden])')`)

      // The positive control, ⌘ ONLY: nothing is blocking now, so the chord must toggle OFF the
      // board and then back ON. Pre-fix this never moves — the handler read e.ctrlKey and metaKey
      // was invisible to it, which is the whole of finding 28.
      await ES(`window.__mogging.view('board')`)
      await waitTrue(`!!document.querySelector('#content.view-board')`)
      await ES(`(${chord('window', 'meta')}, 1)`)
      await sleep(300)
      const viewAfterMetaOnce = await ES<string>(VIEW)
      await ES(`(${chord('window', 'meta')}, 1)`)
      await sleep(300)
      const viewAfterMetaTwice = await ES<string>(VIEW)
      const metaToggles = !viewAfterMetaOnce.includes('view-board') && viewAfterMetaTwice.includes('view-board')

      const pass = focusKept && scrollKept && noLeak && keyboardMove && metaToggles && blockedByModal && blockedWhileTyping
      result = {
        pass,
        focusKept,
        focusBefore,
        focusAfter,
        scrollKept,
        scrolled,
        scrollAfter,
        laneFilled,
        noLeak,
        pdBefore,
        pdAfter,
        opens: OPENS,
        keyboardMove,
        reachedByTab,
        tabHops,
        menuUp,
        menu,
        focusedItem,
        moved,
        metaToggles,
        viewAfterMetaOnce,
        viewAfterMetaTwice,
        blockedByModal,
        modalUp,
        viewUnderModal,
        blockedWhileTyping,
        paletteUp,
        viewWhileTyping
      }
    } catch (e) {
      result = { pass: false, error: e instanceof Error ? e.message : String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'boardrender-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
