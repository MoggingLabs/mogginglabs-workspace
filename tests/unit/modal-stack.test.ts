import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeElement, installFakeDom, makeEvent, uninstallFakeDom, type FakeEvent } from './fake-dom'

// ONE ESCAPE TOOK THE WHOLE STACK, AND THE SHEET UNDERNEATH WAS NEVER INERT.
//
// F021 · Every open modal registers its OWN capture-phase Escape listener on `window`, and
// `stopPropagation()` does not stop siblings on the same node (that needs
// stopImmediatePropagation). So the listeners fired in REGISTRATION order and the OUTER sheet
// closed FIRST: raising a confirm over the settings sheet and pressing Escape once dismissed
// both, discarding whatever the confirm was about.
//
// F022 · `trapOverlay` inerts only `#app`. A modal stacked over another therefore left the
// one BENEATH it fully reachable — only the app behind both was covered — so a screen reader
// in browse mode could walk its virtual cursor out of the top dialog into the one under it.
//
// Both are about several listeners on one node and about which elements a second open
// covers. Neither is visible to a source grep, so this runs the real module against the
// minimal DOM in ./fake-dom — whose one deliberate fidelity is that stopPropagation does NOT
// silence a sibling listener, which is exactly the hazard F021 is about.

let win: FakeElement

async function loadModal(): Promise<typeof import('@ui/components/modal')> {
  // Imported AFTER the globals exist: modal.ts's import graph reaches document at module scope.
  return import('@ui/components/modal')
}

const escape = (): FakeEvent => makeEvent('keydown', { key: 'Escape' })

beforeEach(() => {
  const dom = installFakeDom()
  win = dom.window
})

afterEach(() => uninstallFakeDom())

describe('a modal stacked over another', () => {
  it('answers ONE Escape with ONE close — the topmost', async () => {
    const { createModal } = await loadModal()
    const sheet = createModal({ title: 'Keyboard shortcuts' })
    const confirm = createModal({ title: 'Close this workspace?' })

    sheet.open()
    confirm.open()
    expect([sheet.isOpen(), confirm.isOpen()], 'the stack must be two deep first').toEqual([true, true])

    win.dispatchEvent(escape())

    // The pre-fix bytes close BOTH: the sheet's listener was registered first, so it ran
    // first, and the confirm's stopPropagation could not reach back to stop it.
    expect(confirm.isOpen(), 'the top modal takes the Escape').toBe(false)
    expect(sheet.isOpen(), 'the sheet underneath must survive it').toBe(true)
  })

  // The anti-vacuity check for the one above: if this shim let stopPropagation silence a
  // sibling on the same node, the test would pass on the DEFECT. Both listeners must run.
  it('every listener on window still runs after one calls stopPropagation', async () => {
    const { createModal } = await loadModal()
    const top = createModal({ title: 'Confirm' })
    top.open()
    let after = 0
    win.addEventListener('keydown', () => after++)
    win.dispatchEvent(escape())
    expect(after, 'a sibling listener registered later still hears the event').toBe(1)
  })

  it('a second Escape then closes the one now on top', async () => {
    const { createModal } = await loadModal()
    const sheet = createModal({ title: 'Keyboard shortcuts' })
    const confirm = createModal({ title: 'Close this workspace?' })
    sheet.open()
    confirm.open()
    win.dispatchEvent(escape())
    win.dispatchEvent(escape())
    expect(sheet.isOpen()).toBe(false)
  })

  it('inerts the overlay beneath it, and un-inerts exactly that one on close', async () => {
    const { createModal } = await loadModal()
    const sheet = createModal({ title: 'Keyboard shortcuts' })
    const confirm = createModal({ title: 'Close this workspace?' })

    sheet.open()
    expect((sheet.el as unknown as FakeElement).inert, 'the only modal up is not inert').toBe(false)

    confirm.open()
    expect((sheet.el as unknown as FakeElement).inert, 'the sheet is covered — it must be inert').toBe(true)
    expect((confirm.el as unknown as FakeElement).inert, 'the top modal is the reachable one').toBe(false)

    confirm.close()
    expect((sheet.el as unknown as FakeElement).inert, 'closing the top hands the sheet back').toBe(false)
  })

  // A modal even higher owns its own set: the middle one must not un-inert an overlay the
  // top is still covering when IT closes.
  it('three deep, each open restores only what it inerted', async () => {
    const { createModal } = await loadModal()
    const a = createModal({ title: 'A' })
    const b = createModal({ title: 'B' })
    const c = createModal({ title: 'C' })
    a.open()
    b.open()
    c.open()
    const el = (m: { el: unknown }): FakeElement => m.el as FakeElement
    expect([el(a).inert, el(b).inert, el(c).inert]).toEqual([true, true, false])

    c.close()
    // c inerted only b (a was already inert), so a stays covered by b.
    expect([el(a).inert, el(b).inert]).toEqual([true, false])

    b.close()
    expect(el(a).inert).toBe(false)
  })
})
