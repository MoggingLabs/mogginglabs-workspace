import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated app-wide overlay-scrollbar smoke (MOGGING_APPSCROLL). The pane's slide bar
// taught the app a contract; this gate holds the REST of the app to it:
//
//   A REST      every scrollable surface is invisible at rest — no bar sitting there
//               drawing the eye at a box you are not touching. Asserted in BOTH scrollbar
//               systems (standard `scrollbar-color` and the ::-webkit-* pseudos), because
//               Chromium honours the former when set and then ignores the latter — a rule
//               written in only one of them silently stops applying on an Electron bump.
//   B LANE      the pointer in the bar's own lane at the container's edge reveals it, and
//               the pointer merely INSIDE the container does not. That distinction is the
//               whole contract, and it is the one a CSS `:hover` cannot express.
//   C SCROLL    scrolling reveals it (you want the position readout mid-flick) and it
//               fades ~900ms after you stop.
//   D DEAD BOX  an overflow:auto box with nothing to scroll never lights up.
//   E NO LAYOUT revealing the bar must not move the content under it (the gutter is
//               reserved at all times — a bar that reflows text as it appears is worse
//               than one that never hides).
//   F PANES OPT OUT  terminal panes keep their own bar (a real, draggable element) and
//               must not also grow a native one.
//
// It drives the shipped listeners with real events at real coordinates — the delegated
// pointermove/scroll handlers in core/scroll/overlay-scroll.ts — never their internals.

const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const m = window.__mogging
  const fail = []
  const check = (name, ok, detail) => { if (!ok) fail.push(name + (detail ? ': ' + detail : '')) ; return ok }

  const FLASH_MS = 900
  const REST_MS = FLASH_MS + 500

  // A scrollable surface of our own, in the real document, styled by the real stylesheet:
  // the app's own scrollable panels come and go with views, but the CONTRACT is global
  // (a * rule + two delegated listeners), so any element in the page proves it.
  const box = document.createElement('div')
  box.style.cssText = 'position:fixed;left:40px;top:120px;width:240px;height:160px;overflow:auto;z-index:9999'
  const tall = document.createElement('div')
  tall.style.cssText = 'height:1200px'
  tall.textContent = 'scrollable'
  box.append(tall)
  document.body.append(box)

  // A box that can NOT scroll: overflow:auto, but nothing overflowing.
  const dead = document.createElement('div')
  dead.style.cssText = 'position:fixed;left:320px;top:120px;width:240px;height:160px;overflow:auto;z-index:9999'
  dead.textContent = 'nothing to scroll'
  document.body.append(dead)
  await sleep(200)

  const thumb = (el) => getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor
  const track = (el) => getComputedStyle(el).scrollbarColor
  const invisible = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent'
  // 'transparent transparent' in the standard system; anything else = a visible thumb.
  // The standard system computes 'transparent' as rgba(0, 0, 0, 0): the rail is invisible
  // when NO colour survives once those are struck out.
  const railInvisible = (el) => {
    const t = track(el)
    return t.split('rgba(0, 0, 0, 0)').join('').indexOf('rgb') === -1
  }
  const move = (x, y, target) => (target || document.body).dispatchEvent(
    new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true })
  )
  const r = () => box.getBoundingClientRect()

  check('0 installer ran', !!window.__ovs, 'window.__ovs=' + window.__ovs)

  // --- A · REST: invisible, in both systems ------------------------------------------
  check('A thumb invisible at rest', invisible(thumb(box)), thumb(box))
  check('A rail invisible at rest', railInvisible(box), track(box))
  check('A no reveal classes', !box.classList.contains('ovs-hot') && !box.classList.contains('ovs-scrolling'))

  // --- B · LANE: inside the box is NOT a reveal; the edge lane IS ----------------------
  const bx = r()
  move(bx.left + 40, bx.top + 80, box) // well inside, nowhere near the bar
  await sleep(120)
  check('B inside is not a reveal', invisible(thumb(box)) && !box.classList.contains('ovs-hot'),
    'thumb=' + thumb(box) + ' classes=' + box.className)
  move(bx.right - 5, bx.top + 80, box) // in the lane at the right edge
  await sleep(120)
  const laneThumb = thumb(box)
  check('B lane reveals', box.classList.contains('ovs-hot') && !invisible(laneThumb),
    'thumb=' + laneThumb + ' classes=' + box.className)
  check('B lane reveals the rail too', !railInvisible(box), track(box))
  move(bx.left + 40, bx.top + 80, box) // ...and leaving the lane hides it again
  await sleep(120)
  check('B leaving the lane hides it', !box.classList.contains('ovs-hot') && invisible(thumb(box)), thumb(box))

  // --- C · SCROLL: reveal while scrolling, fade after ----------------------------------
  box.scrollTop = 300
  await sleep(120)
  check('C scrolling reveals', box.classList.contains('ovs-scrolling') && !invisible(thumb(box)), thumb(box))
  await sleep(REST_MS)
  check('C flash fades', !box.classList.contains('ovs-scrolling') && invisible(thumb(box)), thumb(box))

  // --- D · DEAD BOX: nothing to scroll, nothing to show --------------------------------
  const dr = dead.getBoundingClientRect()
  move(dr.right - 5, dr.top + 80, dead)
  await sleep(120)
  check('D dead box stays dark', !dead.classList.contains('ovs-hot') && invisible(thumb(dead)), thumb(dead))

  // --- E · NO LAYOUT SHIFT: revealing the bar must not move the content ----------------
  move(bx.left + 40, bx.top + 80, box)
  await sleep(150)
  const restW = tall.getBoundingClientRect().width
  move(bx.right - 5, bx.top + 80, box)
  await sleep(150)
  const hotW = tall.getBoundingClientRect().width
  check('E reveal does not reflow', restW === hotW, 'rest=' + restW + ' hot=' + hotW)
  move(bx.left + 40, bx.top + 80, box)

  // --- F · PANES OPT OUT: the terminal keeps its own bar, and only its own -------------
  let pane = null
  if (m && m.workspace && m.layout) {
    if (m.workspace.count() === 0) m.workspace.create({ name: 'Panes' })
    await sleep(600)
    m.layout.apply(1)
    for (let i = 0; i < 60 && (m.panes || []).length < 1; i++) await sleep(200)
    await sleep(1500)
    pane = (m.panes || [])[0]
  }
  if (pane) {
    const body = document.querySelector('.pane-body')
    const vp = body ? body.querySelector('.xterm-viewport') : null
    const pr = body.getBoundingClientRect()
    move(pr.right - 5, pr.top + 60, vp || body)
    await sleep(150)
    const marked = (body.classList.contains('ovs-hot') || (vp && vp.classList.contains('ovs-hot')))
    check('F pane never takes a native bar', !marked,
      'body=' + body.className + ' vp=' + (vp ? vp.className : 'none'))
    check('F pane keeps its own bar', !!body.querySelector('.pane-slider'))
  } else {
    check('F pane available', false, 'no pane to check')
  }

  box.remove()
  dead.remove()
  return { pass: fail.length === 0, failures: fail }
})()`

export function runAppScrollSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents

  const errors: string[] = []
  wc.on('console-message', (...args: unknown[]) => {
    const a1 = args[1] as { level?: unknown; message?: unknown } | number | string
    const level = a1 && typeof a1 === 'object' ? a1.level : a1
    const message = a1 && typeof a1 === 'object' ? String(a1.message ?? '') : String(args[2] ?? '')
    if (level === 3 || level === 'error') errors.push('console.error: ' + message)
  })
  wc.on('render-process-gone', (_e, details) => errors.push('render-process-gone: ' + details.reason))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      result = (await wc.executeJavaScript(SCRIPT, true)) as Record<string, unknown>
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    result.rendererErrors = errors
    if (errors.length) result.pass = false
    try {
      writeFileSync(join(process.cwd(), 'out', 'appscroll-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
