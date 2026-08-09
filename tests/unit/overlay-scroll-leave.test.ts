import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installOverlayScrollbars } from '@ui/core/scroll/overlay-scroll'
import { FakeDocument, FakeElement, installFakeDom, makeEvent, uninstallFakeDom } from './fake-dom'

// THE SCROLLBAR THAT HID WHEN THE LIST UNDER A STATIONARY POINTER RE-RENDERED.
//
// F007 · `pointerleave` does not bubble — which is why the listener looked safe. But it is
// registered CAPTURE-phase on the document, and the capture phase visits every ancestor
// regardless of `bubbles`. So it fired whenever the pointer left ANY element, not the window:
// a live-updating list (file tree, board) that re-rendered the row under a resting pointer
// cleared the lane, and since only `onMove` can re-light it, the bar stayed hidden until the
// user jiggled the mouse.
//
// `installOverlayScrollbars(doc)` takes its document, so this needs no globals beyond the ones
// `getComputedStyle` and the element geometry come from — the module's own injection seam.

const HOT = 'ovs-hot'

let doc: FakeDocument
let scroller: FakeElement
let row: FakeElement
let stop: () => void

/** A container that genuinely scrolls, with the pointer resting inside its right-edge lane. */
function lightTheLane(): void {
  scroller = doc.createElement('div')
  scroller.style.overflowY = 'auto'
  scroller.scrollHeight = 900
  scroller.clientHeight = 300
  scroller.rect = { top: 0, left: 0, right: 500, bottom: 300, width: 500, height: 300 }
  row = doc.createElement('div')
  scroller.append(row)
  doc.body.append(scroller)
  // Inside LANE_PX (14) of the right edge, vertically within the box.
  doc.dispatchEvent(makeEvent('pointermove', { target: scroller, clientX: 494, clientY: 120 }))
}

beforeEach(() => {
  installFakeDom()
  doc = new FakeDocument()
  // The shim's globals point at the module-level document; this test drives its OWN, so the
  // geometry reads (getComputedStyle) must see the same elements. Reinstall against it.
  ;(globalThis as unknown as Record<string, unknown>).document = doc
  stop = installOverlayScrollbars(doc as unknown as Document)
})

afterEach(() => uninstallFakeDom())

describe('the overlay scrollbar lane', () => {
  it('lights when the pointer rests in it — the precondition everything below reads', () => {
    lightTheLane()
    expect(scroller.classList.contains(HOT)).toBe(true)
    stop()
  })

  // THE DEFECT. A child re-rendering under a stationary pointer emits pointerleave at the
  // CHILD; the capture listener on the document heard it and cleared the lane.
  it('a pointerleave aimed at a CHILD does not hide it', () => {
    lightTheLane()
    doc.dispatchEvent(makeEvent('pointerleave', { target: row }))
    expect(scroller.classList.contains(HOT), 'the pointer never moved — the bar must stay lit').toBe(true)
    stop()
  })

  it('a pointerleave aimed at the scroller itself does not hide it either', () => {
    lightTheLane()
    doc.dispatchEvent(makeEvent('pointerleave', { target: scroller }))
    expect(scroller.classList.contains(HOT)).toBe(true)
    stop()
  })

  // …and the behaviour the listener exists for is intact: leaving the WINDOW clears the lane,
  // because no pointermove can ever arrive to clear it.
  it('a pointerleave aimed at the document DOES hide it', () => {
    lightTheLane()
    doc.dispatchEvent(makeEvent('pointerleave', { target: doc }))
    expect(scroller.classList.contains(HOT), 'the pointer left the window').toBe(false)
    stop()
  })

  it('and so does one aimed at <html> or <body>', () => {
    lightTheLane()
    doc.dispatchEvent(makeEvent('pointerleave', { target: doc.documentElement }))
    expect(scroller.classList.contains(HOT)).toBe(false)
    stop()
  })

  it('teardown clears the lane and drops every listener', () => {
    lightTheLane()
    stop()
    expect(scroller.classList.contains(HOT)).toBe(false)
    expect(doc.listenerCount('pointerleave')).toBe(0)
    expect(doc.listenerCount('pointermove')).toBe(0)
  })
})
