import { app, type BrowserWindow } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env-gated keyboard + APG-semantics smoke (MOGGING_KBAPG — audit 31, "mouse-first menus,
// resizers and Board movement"). Three controls in this app could only be worked by a POINTER,
// and each was a different flavour of the same failure:
//
//   GRID GUTTER  the seam between panes was a bare <div> with one mousedown listener: no role,
//                no tab stop, no keys, no aria-value*. A keyboard-only user could not rebalance
//                a workspace at all, and a screen reader met an unnamed box. It is the
//                highest-traffic resizer in the product — it exists from the second pane on.
//   SCROLLBACK   xterm answers Shift+PageUp/PageDown itself, but reads Shift+Home/End as CURSOR
//                keys (ESC[1;2H / ESC[1;2F) and types them at the shell. So the two ENDS of the
//                history were unreachable without a mouse (the slide bar is a pointer scrub, the
//                jump pill a click), and every press leaked an escape sequence into the agent.
//   STEPPER      [− n +] was two buttons around a plain <span>: no role, no value, no keys.
//
// The bar for a fix is not "the attribute is present". Every assertion pairs the ARIA with the
// PIXELS or the BYTES it claims to describe — an aria-valuenow that moves while the panes do not
// is a lie, and a scroll key that moves the viewport AND reaches the shell is a different one.
// Every step carries its negative (a seam with nowhere left to go must not advertise a range it
// cannot reach; a spinbutton at its ceiling must not fire an out-of-range onChange), and every
// negative is preceded by the positive control that proves the same dispatch DOES work — so a
// gate that passes because the app went deaf is impossible.
//
// Phased, because only MAIN can resize the window: the renderer builds each fixture, main sets
// the size, the renderer probes. Each phase returns its own failures; the verdict is their sum.

// Shared by every phase (each executeJavaScript is its own scope).
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const m = window.__mogging
  const fail = []
  const check = (name, ok, detail) => { if (!ok) fail.push(name + (detail ? ': ' + detail : '')) ; return !!ok }
  const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 3 : tol)
  // ARIA on the left, REAL GEOMETRY on the right — this gate never reads one without the other.
  const aria = (el) => el ? {
    role: el.getAttribute('role'),
    orientation: el.getAttribute('aria-orientation'),
    min: Number(el.getAttribute('aria-valuemin')),
    max: Number(el.getAttribute('aria-valuemax')),
    now: Number(el.getAttribute('aria-valuenow')),
    label: el.getAttribute('aria-label'),
    disabled: el.getAttribute('aria-disabled'),
    hidden: el.hasAttribute('aria-hidden'),
    tabbable: el.tabIndex >= 0
  } : null
  const gutter = (path, index) => document.querySelector('.layout-gutter[data-path="' + path + '"][data-index="' + index + '"]')
  const slotBox = (paneId) => {
    const el = document.querySelector('.layout-slot[data-pane-id="' + paneId + '"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  // A real press at a real target, carrying the keyCode a real one carries: xterm's key table
  // switches on keyCode, so an event without one would silently exercise nothing there — and this
  // gate has to stay a faithful regression test for the bytes Shift+Home/End USED to send.
  const CODES = { PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }
  const press = async (el, key, shift) => {
    if (!el) return false
    el.focus()
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key, code: key, keyCode: CODES[key] || 0, which: CODES[key] || 0,
      shiftKey: !!shift, bubbles: true, cancelable: true
    }))
    await sleep(140)
    return true
  }

  // ── What the TERMINAL says on its own, on the same wire the KEYBOARD writes to ──────────────
  // xterm ANSWERS the host program through onData — the very channel keystrokes ride: focus in /
  // focus out (CSI I / CSI O, mode 1004 — and press() above calls el.focus(), so the first press
  // at the pane emits one), cursor-position reports, device attributes, status and mode reports,
  // colour and DCS replies. Those bytes are the terminal replying to a program, NOT a person
  // typing. This codebase already draws exactly that line, in one place, for exactly this reason:
  // src/backend/features/agent-state/replies.ts (isTerminalReply) — auto-replies must not clear the
  // attention latch. The patterns below are that same repertoire, transcribed into the renderer
  // scope this script runs in (executeJavaScript cannot import). Keep the two in step.
  //
  // The negative in phase 3 stays EXACTLY as strong. Every final byte matched here is a RESPONSE
  // final (I O R c n t, $y, and the OSC/DCS terminators). The bytes finding 31 leaked — ESC[1;2H
  // and ESC[1;2F, the CURSOR finals xterm used to type at the shell for Shift+Home / Shift+End —
  // match NOTHING in this set: H and F are not response finals. So a pre-fix build still fails on
  // precisely the sequence it used to send, even if a focus report arrives in the same chunk. So
  // does any other key-derived byte (arrows, PageUp's ESC[5~, ^C, plain 'x' — the positive control
  // below asserts the last of those really does get through).
  const AUTO_REPLIES = [
    /^\\x1b\\[[?>]?[0-9;]*[Rcn]/, // CPR (CSI r;c R) · DA1 (CSI ? … c) · DA2 (CSI > … c) · DSR-ok (CSI 0 n)
    /^\\x1b\\[\\??[0-9;]*\\$y/, // DECRPM — the mode report answering a DECRQM
    /^\\x1b\\[[0-9;]*t/, // window-ops report (CSI 8 ; rows ; cols t)
    /^\\x1b\\[[IO]/, // focus in / focus out (mode 1004)
    /^\\x1b\\][0-9]+;[^\\x07\\x1b]*(\\x07|\\x1b\\\\)/, // OSC query reply (10/11 colour, …)
    /^\\x1bP[^\\x1b]*\\x1b\\\\/ // DCS reply (DECRQSS / XTGETTCAP / XTVERSION)
  ]
  /** Subtract the terminal's own answers from a captured chunk. What is LEFT is what a HUMAN would
   *  have had to press for it to be on the wire — '' means the shell heard nothing from us. */
  const humanBytes = (chunk) => {
    let rest = chunk
    let out = ''
    scan: while (rest) {
      for (const re of AUTO_REPLIES) {
        const mm = re.exec(rest)
        if (mm) { rest = rest.slice(mm[0].length); continue scan }
      }
      out += rest[0]
      rest = rest.slice(1)
    }
    return out
  }
`

// ── Phase A · the two grid seams, then the terminal scrollback ────────────────────────────
// A 2×2 grid is a 'v' split of two 'h' rows, so it carries BOTH seam axes at once: the row seam
// (a vertical line between two panes) and the root seam (a horizontal line between two rows).
const PHASE_A = `(async () => {
  ${HELPERS}
  if (!m || !m.workspace || !m.layout) return { failures: ['no dev handles'] }
  if (m.workspace.count() === 0) m.workspace.create({ name: 'KbApg' })
  await sleep(700)
  m.layout.apply(4)
  for (let i = 0; i < 100 && (m.panes || []).length < 4; i++) await sleep(200)
  const ids = m.layout.paneIds()
  if (ids.length < 4) return { failures: ['expected 4 panes, got ' + ids.length] }
  await sleep(1200)

  // ══ 1 · The VERTICAL seam ('h' split — panes side by side) ═══════════════════════════════
  // Its aria-valuenow is the RENDERED width of the pane on its left, so an arrow key has to move
  // the number and the pane together, or the number is a lie.
  const vSeam = gutter('0', 1)
  const v0 = aria(vSeam)
  check('1 the vertical seam exists', !!vSeam)
  if (!vSeam) return { failures: fail }
  check('1 it is a separator, on the right axis', v0.role === 'separator' && v0.orientation === 'vertical', JSON.stringify(v0))
  check('1 it is reachable, named, and not hidden', v0.tabbable && !!v0.label && !v0.hidden, JSON.stringify(v0))
  check('1 its value is inside its range', v0.min <= v0.now && v0.now <= v0.max, JSON.stringify(v0))
  check('1 it has room to move', v0.max > v0.min, JSON.stringify(v0))
  const a0 = slotBox(ids[0])
  const b0 = slotBox(ids[1])
  check('1 the value IS the pane', near(v0.now, a0.w), 'now=' + v0.now + ' rendered=' + a0.w)

  await press(vSeam, 'ArrowRight')
  const tookFocus = document.activeElement === vSeam
  const v1 = aria(vSeam)
  const a1 = slotBox(ids[0])
  const b1 = slotBox(ids[1])
  check('1 the seam takes focus', tookFocus)
  check('1 ArrowRight moves the value', v1.now > v0.now, JSON.stringify({ before: v0.now, after: v1.now }))
  check('1 ArrowRight moves the PIXELS', a1.w > a0.w, 'w ' + a0.w + ' -> ' + a1.w)
  check('1 the attribute still matches the pixels', near(v1.now, a1.w), 'now=' + v1.now + ' rendered=' + a1.w)
  check('1 the neighbour gave up exactly that space', b1.w < b0.w && near(a1.w + b1.w, a0.w + b0.w),
    JSON.stringify({ before: [a0.w, b0.w], after: [a1.w, b1.w] }))

  await press(vSeam, 'ArrowLeft')
  check('1 ArrowLeft comes back', near(aria(vSeam).now, v0.now), JSON.stringify({ start: v0.now, back: aria(vSeam).now }))
  await press(vSeam, 'End')
  const vEnd = aria(vSeam)
  const aEnd = slotBox(ids[0])
  check('1 End snaps to the maximum', vEnd.now === vEnd.max, JSON.stringify(vEnd))
  check('1 End snaps the PIXELS', near(aEnd.w, vEnd.max), 'rendered=' + aEnd.w + ' max=' + vEnd.max)
  await press(vSeam, 'Home')
  const vHome = aria(vSeam)
  const aHome = slotBox(ids[0])
  check('1 Home snaps to the minimum', vHome.now === vHome.min, JSON.stringify(vHome))
  check('1 Home snaps the PIXELS', near(aHome.w, vHome.min), 'rendered=' + aHome.w + ' min=' + vHome.min)
  check('1 the two ends really are different places', aHome.w < aEnd.w, aHome.w + ' vs ' + aEnd.w)
  await press(vSeam, 'ArrowUp') // the axis this seam does NOT own: no move, and the key bubbles on
  check('1 the cross-axis arrow is not its business', aria(vSeam).now === vHome.now, JSON.stringify(aria(vSeam)))

  // ══ 2 · The HORIZONTAL seam ('v' split — the two ROWS) ═══════════════════════════════════
  // Same contract, other axis. Its children are SPLITS, not leaves: the value is the top row's
  // rendered height, which is the height of every pane in it.
  const hSeam = gutter('', 1)
  const h0 = aria(hSeam)
  const top0 = slotBox(ids[0])
  const bot0 = slotBox(ids[2])
  check('2 it is a separator, on the right axis', h0 && h0.role === 'separator' && h0.orientation === 'horizontal', JSON.stringify(h0))
  check('2 the value IS the row', h0 && near(h0.now, top0.h), 'now=' + (h0 && h0.now) + ' rendered=' + top0.h)
  await press(hSeam, 'ArrowDown')
  const h1 = aria(hSeam)
  const top1 = slotBox(ids[0])
  const bot1 = slotBox(ids[2])
  check('2 ArrowDown grows the top row', h1.now > h0.now && top1.h > top0.h,
    JSON.stringify({ now: [h0.now, h1.now], h: [top0.h, top1.h] }))
  check('2 the bottom row gave up the space', bot1.h < bot0.h, bot0.h + ' -> ' + bot1.h)
  check('2 the attribute matches the pixels', near(h1.now, top1.h), 'now=' + h1.now + ' rendered=' + top1.h)
  await press(hSeam, 'ArrowRight') // wrong axis for THIS seam
  check('2 the cross-axis arrow is not its business', aria(hSeam).now === h1.now, JSON.stringify(aria(hSeam)))
  await press(hSeam, 'ArrowUp')
  check('2 ArrowUp comes back', near(aria(hSeam).now, h0.now), JSON.stringify({ start: h0.now, back: aria(hSeam).now }))

  // ══ 3 · TERMINAL SCROLLBACK — the keyboard's door into the history ═══════════════════════
  const p0 = (m.panes || [])[0]
  if (!p0) return { failures: fail.concat(['no pane dev handle']) }
  const ta = p0.el().querySelector('.xterm-helper-textarea') || p0.term.textarea
  let hist = ''
  for (let i = 0; i < 400; i++) hist += 'HIST ' + i + '\\r\\n'
  await new Promise((r) => p0.term.write(hist, r))
  await sleep(500)
  // term.onData IS the wire to the PTY (terminal-pane.ts pipes it straight into terminalClient.write):
  // anything landing here is a byte the shell would have seen.
  const sent = []
  const wire = p0.term.onData((d) => { sent.push(d) })
  const base = p0.scroll()
  const thumb0 = p0.sliderGeometry()
  check('3 the pane starts on the newest line', base.atBottom && base.following && base.baseY > 0, JSON.stringify(base))

  await press(ta, 'PageUp', true)
  const up = p0.scroll()
  const thumb1 = p0.sliderGeometry()
  check('3 Shift+PageUp moves the viewport up', up.viewportY < base.viewportY && !up.atBottom, JSON.stringify(up))
  check('3 a page is a screenful', base.viewportY - up.viewportY === p0.rows() - 1,
    'moved=' + (base.viewportY - up.viewportY) + ' rows=' + p0.rows())
  // The cross-check in PIXELS: the overlay thumb is driven off the viewport, so it must have
  // climbed the rail. (It is aria-hidden decoration now — but decoration still may not lie.)
  check('3 the rendered thumb climbed', thumb0 && thumb1 && thumb1.thumbTop < thumb0.thumbTop,
    JSON.stringify({ before: thumb0, after: thumb1 }))
  await sleep(600) // the anchor's gesture window closes and it reads where we came to rest
  const rested = p0.scroll()
  check('3 the anchor released, the pill appeared', !rested.following && rested.jumpShown, JSON.stringify(rested))

  await press(ta, 'Home', true)
  check('3 Shift+Home reaches the oldest line', p0.scroll().viewportY === 0, JSON.stringify(p0.scroll()))
  await press(ta, 'End', true)
  const end = p0.scroll()
  const thumbEnd = p0.sliderGeometry()
  check('3 Shift+End returns to the newest', end.atBottom && !end.jumpShown, JSON.stringify(end))
  check('3 Shift+End re-arms the follow anchor', end.following, JSON.stringify(end))
  check('3 the thumb is back on the floor', thumbEnd && Math.abs(thumbEnd.thumbBottom - thumbEnd.trackBottom) <= 1, JSON.stringify(thumbEnd))
  let more = ''
  for (let i = 0; i < 60; i++) more += 'AFTER ' + i + '\\r\\n'
  await new Promise((r) => p0.term.write(more, r)) // re-armed for REAL: the next output follows on its own
  await sleep(400)
  check('3 the pane follows again', p0.scroll().atBottom, JSON.stringify(p0.scroll()))
  wire.dispose()
  // THE NEGATIVE: not one byte of any of that reached the shell. Before the fix, Shift+Home and
  // Shift+End alone would have put ESC[1;2H and ESC[1;2F on this wire.
  //
  // "Reached the shell" means a byte a HUMAN produced. The raw capture is not that: the very first
  // press() focuses the helper textarea, and xterm answers the host with its focus-in report
  // (CSI I) on this same onData wire — a terminal protocol REPLY, not a keystroke and not a scroll
  // key. Asserting on the raw capture confused the terminal talking to the program with the user
  // talking to the shell, and failed with ["\x1b[I"]. Subtract the terminal's own answers first
  // (humanBytes, above); what remains is the assertion that was always meant. It is not weaker —
  // H and F are not response finals, so a pre-fix build's ESC[1;2H / ESC[1;2F survive the
  // subtraction intact and still fail this line, focus report or no focus report.
  const heard = humanBytes(sent.join(''))
  check('3 NEGATIVE: no scroll key reached the shell', heard === '', JSON.stringify({ heard, raw: sent }))
  // ...and the positive control, on the SAME dispatch path: the pane did not simply go deaf.
  const typed = []
  const wire2 = p0.term.onData((d) => { typed.push(d) })
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', keyCode: 88, which: 88, bubbles: true, cancelable: true }))
  await sleep(200)
  wire2.dispose()
  // Same subtraction, same reason — an auto-reply landing in this window is not the user, and must
  // neither satisfy this control nor break it. The 'x' still has to be there, alone.
  check('3 CONTROL: ordinary keys still reach the shell', humanBytes(typed.join('')) === 'x', JSON.stringify(typed))
  // The rail is decoration over a buffer the keyboard can now reach, and says so. The jump pill is
  // a real labelled button with a real action, and stays announced.
  const decor = ['.pane-slider', '.pane-slider-track', '.pane-slider-thumb'].map((s) => p0.el().querySelector(s)?.getAttribute('aria-hidden'))
  const pill = p0.el().querySelector('.pane-jump')
  check('3 the slide bar is declared decorative', decor.every((v) => v === 'true'), JSON.stringify(decor))
  check('3 the jump pill stays announced', !!pill && !pill.hasAttribute('aria-hidden') && !!pill.getAttribute('aria-label'))

  // ── Fixture for phase B: FIVE panes in one row. Main narrows the window next, which pins the
  //    layout at its recursive minimum and puts every pane on the 132px floor.
  m.layout.apply(1)
  await sleep(600)
  for (let i = 0; i < 4; i++) { m.layout.split('h'); await sleep(500) }
  for (let i = 0; i < 60 && (m.panes || []).length < 5; i++) await sleep(200)

  // sent = the RAW wire (auto-replies and all); heard = what a PERSON put on it. Kept apart in the
  // evidence so a future failure says which of the two moved.
  return { failures: fail, seams: { vertical: v0, horizontal: h0 }, keys: { sent, heard, typed }, decor }
})()`

// ── Phase B · the negative: a seam with nowhere to go ─────────────────────────────────────
// Five panes at MIN_PANE_WIDTH_PX (132) in a window too narrow for them. resizeSplitWeights
// rightly refuses to move such a seam — so the seam must not ADVERTISE a range it cannot reach.
// min === max === now, no key pushes the value outside it, and no pixel moves.
const PHASE_B = `(async () => {
  ${HELPERS}
  const ids = m.layout.paneIds()
  const pinned = gutter('', 2) // a middle seam of the line: a pinned neighbour on either side
  const before = aria(pinned)
  const boxes0 = ids.map(slotBox)
  check('4 the line has five panes', ids.length === 5, JSON.stringify(ids))
  check('4 every pane is on the 132px floor', boxes0.every((b) => b && b.w === 132), JSON.stringify(boxes0.map((b) => b && b.w)))
  check('4 the pinned seam exists', !!pinned)
  if (!pinned) return { failures: fail }
  check('4 it advertises no room at all', before.min === before.max && before.now === before.min, JSON.stringify(before))
  check('4 its value is still INSIDE its range', before.min <= before.now && before.now <= before.max, JSON.stringify(before))
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) await press(pinned, key)
  const after = aria(pinned)
  const boxes1 = ids.map(slotBox)
  check('4 NEGATIVE: no key pushed it out of range', after.min <= after.now && after.now <= after.max, JSON.stringify(after))
  check('4 NEGATIVE: the value did not move', after.now === before.now, JSON.stringify({ before, after }))
  check('4 NEGATIVE: not one pixel moved', JSON.stringify(boxes1) === JSON.stringify(boxes0),
    JSON.stringify({ before: boxes0.map((b) => b && b.w), after: boxes1.map((b) => b && b.w) }))
  return { failures: fail, pinned: before }
})()`

// ── Phase C · the stepper, driven through the wizard ──────────────────────────────────────
// Steppers live in the wizard, and its fill meter is the observable of onChange (refreshAgents
// rewrites it). So "the value moved" and "onChange fired" are two different facts here — which is
// exactly the difference the clamping negatives below turn on.
const phaseC = (cwd: string): string => `(async () => {
  ${HELPERS}
  if (!m || !m.templates) return { failures: ['no wizard dev handle'] }
  m.templates.openWizard({ cwd: ${JSON.stringify(cwd)}, paneCount: 4, mix: [{ provider: 'custom:echo audit', count: 1 }] })
  await sleep(1400)
  const stepper = () => document.querySelector('#view-wizard .wizard-custom-row .stepper')
  const shown = () => document.querySelector('#view-wizard .wizard-custom-row .stepper-value')?.textContent ?? ''
  const meter = () => document.querySelector('#view-wizard .wizard-fill-label')?.textContent ?? ''
  // The roster arrives ASYNCHRONOUSLY (PATH detection for each CLI, then the profiles list), and
  // every arrival re-renders the roster subtree — which would swap the stepper out from under a
  // focus assertion mid-test. The value survives a re-render (it is rebuilt from the wizard's own
  // state), the ELEMENT does not: so wait until the same node survives a beat before touching it.
  let settled = stepper()
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    const next = stepper()
    if (next && next === settled) break
    settled = next
  }
  const s0 = aria(stepper())
  check('5 the stepper exists', !!stepper())
  if (!stepper()) return { failures: fail }
  check('5 it is a spinbutton', s0.role === 'spinbutton', JSON.stringify(s0))
  check('5 it is reachable and named', s0.tabbable && !!s0.label, JSON.stringify(s0))
  check('5 it carries its value at mount', s0.now === 1 && s0.min === 0 && s0.max === 4, JSON.stringify(s0))
  check('5 the announced value IS the rendered one', String(s0.now) === shown(), 'now=' + s0.now + ' shown=' + shown())
  const meter0 = meter()

  await press(stepper(), 'ArrowUp')
  check('5 the stepper takes focus', document.activeElement === stepper())
  check('5 ArrowUp steps up', aria(stepper()).now === 2 && shown() === '2', JSON.stringify(aria(stepper())))
  check('5 ArrowUp fires onChange', meter() !== meter0 && /2 \\/ 4/.test(meter()), meter())
  await press(stepper(), 'ArrowDown')
  check('5 ArrowDown steps down', aria(stepper()).now === 1 && shown() === '1', JSON.stringify(aria(stepper())))

  await press(stepper(), 'End')
  const sMax = aria(stepper())
  const meterMax = meter()
  check('5 End goes to the ceiling', sMax.now === sMax.max && shown() === String(sMax.max), JSON.stringify(sMax))
  check('5 End fires onChange', /4 \\/ 4/.test(meterMax), meterMax)
  await press(stepper(), 'ArrowUp') // ...and past it
  check('5 NEGATIVE: ArrowUp at the ceiling is clamped', aria(stepper()).now === sMax.max && shown() === String(sMax.max), JSON.stringify(aria(stepper())))
  check('5 NEGATIVE: no out-of-range onChange at the ceiling', meter() === meterMax, meter() + ' vs ' + meterMax)

  await press(stepper(), 'Home')
  const sMin = aria(stepper())
  const meterMin = meter()
  check('5 Home goes to the floor', sMin.now === sMin.min && shown() === String(sMin.min), JSON.stringify(sMin))
  check('5 Home fires onChange', /0 \\/ 4/.test(meterMin), meterMin)
  await press(stepper(), 'ArrowDown') // ...and past it
  check('5 NEGATIVE: ArrowDown at the floor is clamped', aria(stepper()).now === sMin.min, JSON.stringify(aria(stepper())))
  check('5 NEGATIVE: no out-of-range onChange at the floor', meter() === meterMin, meter() + ' vs ' + meterMin)

  // A DISABLED spinbutton says so, and answers nothing. Blanking the custom command is what
  // disables this one — an empty command can own no panes.
  const input = document.querySelector('#view-wizard .wizard-custom-input')
  input.value = '   '
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(300)
  const off = aria(stepper())
  check('5 a disabled stepper says it is disabled', off.disabled === 'true', JSON.stringify(off))
  await press(stepper(), 'ArrowUp')
  check('5 NEGATIVE: a disabled stepper answers no key', aria(stepper()).now === 0 && meter() === meterMin,
    JSON.stringify(aria(stepper())) + ' ' + meter())
  return { failures: fail, stepper: s0 }
})()`

interface Phase {
  failures?: string[]
  [k: string]: unknown
}

export function runKbApgSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 200000) // watchdog: a hung renderer must never hang the sweep
  const wc = win.webContents
  wc.setBackgroundThrottling(false) // the seam + scroll phases need their rAFs even unfocused
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const errors: string[] = []
  wc.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + d.reason))
  let fixture = ''

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      fixture = mkdtempSync(join(tmpdir(), 'mogging-kbapg-')) // the wizard needs a real folder
      // A known window, so the seam assertions are about the KEYS and not about whatever size the
      // gate happened to boot at: wide enough that a 16px step and the two ends are far apart.
      win.setSize(1280, 860)
      await sleep(1500)
      const a = (await wc.executeJavaScript(PHASE_A, true)) as Phase
      // Now narrow it under the 5-pane line: the grid pins at its recursive minimum and every pane
      // lands on the floor — the one state in which a seam has nowhere left to go.
      win.setSize(600, 760)
      await sleep(1500)
      const b = (await wc.executeJavaScript(PHASE_B, true)) as Phase
      win.setSize(1280, 860)
      await sleep(800)
      const c = (await wc.executeJavaScript(phaseC(fixture), true)) as Phase
      const failures = [...(a.failures ?? []), ...(b.failures ?? []), ...(c.failures ?? [])]
      result = { pass: failures.length === 0, failures, grid: a, pinned: b, stepper: c }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    if (errors.length) {
      result.rendererErrors = errors
      result.pass = false
    }
    try {
      rmSync(fixture, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'kbapg-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
