import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated EQUALIZE smoke (MOGGING_EQUALIZE) — the equalize/balance verbs, driven through
// the REAL surfaces a user touches, never the model directly:
//
//   SEAM      double-click a gutter → its whole LINE takes equal per-member shares; '=' on a
//             focused gutter is the keyboard twin. The layout-invariants script proves the
//             pure model; THIS gate proves the wiring — the DOM gesture reaches the tree and
//             the pixels move.
//   ⋯ MENU    "Equal widths in this row" / "Equal heights in this column" — offered per axis
//             off the slot's data-eq-axes stamp. The honesty negative is the point: a pane
//             that SPANS the stack's rows sits in an outer line, so it must get NO
//             "Equal heights" entry — and equalizing the stack must not move the spanner.
//   BALANCE   the layout popover's "Balance layout" row and Ctrl+Shift+= both equalize every
//             line of the active workspace.
//
// The bar matches kbapg: every positive is asserted in PIXELS (slot rects), every negative
// rides a preceding positive control on the same dispatch path, and scoping claims assert
// byte-identical rects for what must NOT move.

const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const m = window.__mogging
  const fail = []
  const check = (name, ok, detail) => { if (!ok) fail.push(name + (detail ? ': ' + detail : '')) ; return !!ok }
  const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 3 : tol)
  const gutter = (path, index) => document.querySelector('.layout-gutter[data-path="' + path + '"][data-index="' + index + '"]')
  const slotEl = (paneId) => document.querySelector('.layout-slot[data-pane-id="' + paneId + '"]')
  const slotBox = (paneId) => {
    const el = slotEl(paneId)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const press = async (el, key, opts) => {
    if (!el) return false
    el.focus()
    el.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, opts || {})))
    await sleep(140)
    return true
  }
  const dblclick = async (el) => {
    if (!el) return false
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    await sleep(200)
    return true
  }
  /** Open pane ⋯ menu, read entry labels, leave it OPEN (caller clicks or closes). */
  const openMenu = async (paneId) => {
    const btn = slotEl(paneId)?.querySelector('[aria-label="Pane menu"]')
    if (!(btn instanceof HTMLButtonElement)) return null
    btn.click()
    await sleep(250)
    const menu = document.getElementById('pane-menu-' + paneId)
    if (!menu || menu.hidden) return null
    return { menu, btn, items: [...menu.querySelectorAll('.menu-item')].map((el) => (el.textContent || '').trim()) }
  }
  const clickEntry = async (paneId, label) => {
    const open = await openMenu(paneId)
    if (!open) return false
    const entry = [...open.menu.querySelectorAll('.menu-item')].find((el) => (el.textContent || '').trim() === label)
    if (!entry) { open.btn.click(); return false }
    entry.click()
    await sleep(250)
    return true
  }
`

// ── Phase A · seam gestures on a 2×2 grid, with the other row as the scoping witness ─────
// v[ h[a,b], h[c,d] ]: row 0's seam is gutter('0',1); row 1 is a DIFFERENT line, so its
// pixels are the proof that an equalize is line-scoped.
const PHASE_A = `(async () => {
  ${HELPERS}
  if (!m || !m.workspace || !m.layout) return { failures: ['no dev handles'] }
  if (m.workspace.count() === 0) m.workspace.create({ name: 'Equalize' })
  await sleep(700)
  m.layout.apply(4)
  for (let i = 0; i < 100 && m.layout.paneIds().length < 4; i++) await sleep(200)
  const ids = m.layout.paneIds()
  if (ids.length < 4) return { failures: ['expected 4 panes, got ' + ids.length] }
  await sleep(1200)

  // ══ 1 · double-click equalizes THIS row and only this row ═══════════════════════════════
  const seam = gutter('0', 1)
  check('1 the row seam exists', !!seam)
  if (!seam) return { failures: fail }
  check('1 the seam tooltip teaches the gesture', /double-click/i.test(seam.title || ''), JSON.stringify(seam.title))
  // Skew BOTH rows, so "row 1 unchanged" is a real claim about a genuinely unequal line.
  for (let i = 0; i < 3; i++) await press(seam, 'ArrowRight')
  for (let i = 0; i < 3; i++) await press(gutter('1', 1), 'ArrowLeft')
  const a0 = slotBox(ids[0]); const b0 = slotBox(ids[1])
  const c0 = slotBox(ids[2]); const d0 = slotBox(ids[3])
  check('1 CONTROL: row 0 is unequal before the gesture', a0.w - b0.w >= 32, a0.w + ' vs ' + b0.w)
  check('1 CONTROL: row 1 is unequal before the gesture', d0.w - c0.w >= 32, c0.w + ' vs ' + d0.w)

  await dblclick(seam)
  const a1 = slotBox(ids[0]); const b1 = slotBox(ids[1])
  const c1 = slotBox(ids[2]); const d1 = slotBox(ids[3])
  check('1 double-click equalizes the row', near(a1.w, b1.w, 1), a1.w + ' vs ' + b1.w)
  check('1 the pair kept its total', near(a1.w + b1.w, a0.w + b0.w, 1), JSON.stringify({ before: [a0.w, b0.w], after: [a1.w, b1.w] }))
  check('1 NEGATIVE: the OTHER row did not move', JSON.stringify([c1, d1]) === JSON.stringify([c0, d0]),
    JSON.stringify({ before: [c0, d0], after: [c1, d1] }))
  check('1 the seam announces the new position', near(Number(seam.getAttribute('aria-valuenow')), a1.w, 1),
    seam.getAttribute('aria-valuenow') + ' vs ' + a1.w)

  // ══ 2 · '=' on a focused seam is the same verb ═══════════════════════════════════════════
  for (let i = 0; i < 3; i++) await press(seam, 'ArrowRight')
  const skew = slotBox(ids[0])
  check('2 CONTROL: the row is unequal again', skew.w - slotBox(ids[1]).w >= 32, JSON.stringify(skew))
  await press(seam, '=')
  const a2 = slotBox(ids[0]); const b2 = slotBox(ids[1])
  check("2 '=' equalizes the row", near(a2.w, b2.w, 1), a2.w + ' vs ' + b2.w)
  check('2 NEGATIVE: row 1 still untouched', JSON.stringify([slotBox(ids[2]), slotBox(ids[3])]) === JSON.stringify([c1, d1]),
    JSON.stringify([slotBox(ids[2]), slotBox(ids[3])]))
  return { failures: fail, rows: { equalized: [a2, b2], witness: [c1, d1] } }
})()`

// ── Phase B · the spanning pane, the ⋯ menu's honesty, and Balance ───────────────────────
// h[ SPANNER, v[top, bottom] ]: the spanner is a member of the root row and of NO column.
const PHASE_B = `(async () => {
  ${HELPERS}
  m.layout.apply(1)
  await sleep(800)
  m.layout.split('h')
  await sleep(700)
  m.layout.split('v')
  for (let i = 0; i < 60 && m.layout.paneIds().length < 3; i++) await sleep(200)
  const ids = m.layout.paneIds() // DFS: [spanner, top, bottom]
  if (ids.length !== 3) return { failures: ['expected 3 panes, got ' + ids.length] }
  await sleep(900)
  const spanner = ids[0]; const top = ids[1]; const bottom = ids[2]

  // ══ 3 · the stamp and the menu tell the same truth ══════════════════════════════════════
  check('3 the spanner is stamped row-only', slotEl(spanner)?.dataset.eqAxes === 'h', slotEl(spanner)?.dataset.eqAxes)
  check('3 a stacked pane is stamped both-axes', slotEl(top)?.dataset.eqAxes === 'hv', slotEl(top)?.dataset.eqAxes)
  const stacked = await openMenu(top)
  check('3 CONTROL: the stacked pane offers both entries',
    !!stacked && stacked.items.includes('Equal widths in this row') && stacked.items.includes('Equal heights in this column'),
    JSON.stringify(stacked && stacked.items))
  if (stacked) { stacked.btn.click(); await sleep(150) }
  const span = await openMenu(spanner)
  check('3 the spanner offers the row entry', !!span && span.items.includes('Equal widths in this row'), JSON.stringify(span && span.items))
  check('3 NEGATIVE: the spanner is offered NO column entry', !!span && !span.items.includes('Equal heights in this column'),
    JSON.stringify(span && span.items))
  if (span) { span.btn.click(); await sleep(150) }

  // ══ 4 · the menu entry equalizes the stack; the spanner cannot move ═════════════════════
  for (let i = 0; i < 3; i++) await press(gutter('1', 1), 'ArrowDown')
  const t0 = slotBox(top); const b0 = slotBox(bottom); const s0 = slotBox(spanner)
  check('4 CONTROL: the stack is unequal', t0.h - b0.h >= 32, t0.h + ' vs ' + b0.h)
  check('4 the menu entry ran', await clickEntry(top, 'Equal heights in this column'))
  const t1 = slotBox(top); const b1 = slotBox(bottom); const s1 = slotBox(spanner)
  check('4 the stack equalized', near(t1.h, b1.h, 1), t1.h + ' vs ' + b1.h)
  check('4 NEGATIVE: the spanning pane did not move', JSON.stringify(s1) === JSON.stringify(s0),
    JSON.stringify({ before: s0, after: s1 }))

  // ══ 5 · Balance: the popover row, then the chord — every line equal ═════════════════════
  await press(gutter('', 1), 'End')
  await press(gutter('1', 1), 'ArrowDown')
  const sSkew = slotBox(spanner)
  check('5 CONTROL: the root row is skewed', sSkew.w - slotBox(top).w >= 60, sSkew.w + ' vs ' + slotBox(top).w)
  const launcher = document.querySelector('.layout-launcher button')
  check('5 the layout popover opens', !!launcher)
  if (launcher) { launcher.click(); await sleep(300) }
  const rows = [...document.querySelectorAll('.layout-menu .menu-item')]
  const balanceRow = rows.find((el) => (el.textContent || '').includes('Balance layout'))
  check('5 the popover offers Balance layout, with its chord', !!balanceRow && /Ctrl\\+Shift\\+=/.test(balanceRow.textContent || ''),
    JSON.stringify(rows.map((el) => (el.textContent || '').trim())))
  if (!balanceRow) return { failures: fail }
  balanceRow.click()
  await sleep(300)
  const sB = slotBox(spanner); const tB = slotBox(top); const bB = slotBox(bottom)
  check('5 Balance equalizes the root row', near(sB.w, tB.w, 2), sB.w + ' vs ' + tB.w)
  check('5 Balance equalizes the stack too', near(tB.h, bB.h, 1), tB.h + ' vs ' + bB.h)

  await press(gutter('', 1), 'End')
  await press(gutter('1', 1), 'ArrowDown')
  check('5 CONTROL: skewed again for the chord', slotBox(spanner).w - slotBox(top).w >= 60,
    slotBox(spanner).w + ' vs ' + slotBox(top).w)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
  await sleep(300)
  const sK = slotBox(spanner); const tK = slotBox(top); const bK = slotBox(bottom)
  check('5 Ctrl+Shift+= balances', near(sK.w, tK.w, 2) && near(tK.h, bK.h, 1), JSON.stringify({ sK, tK, bK }))
  return { failures: fail, balanced: { spanner: sK, top: tK, bottom: bK } }
})()`

interface Phase {
  failures?: string[]
  [k: string]: unknown
}

export function runEqualizeSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 200000) // watchdog: a hung renderer must never hang the sweep
  const wc = win.webContents
  wc.setBackgroundThrottling(false)
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const errors: string[] = []
  wc.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + d.reason))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      win.setSize(1280, 860) // known geometry, so equal/skew thresholds are about the verbs
      await sleep(1500)
      const a = (await wc.executeJavaScript(PHASE_A, true)) as Phase
      const b = (await wc.executeJavaScript(PHASE_B, true)) as Phase
      const failures = [...(a.failures ?? []), ...(b.failures ?? [])]
      result = { pass: failures.length === 0, failures, seams: a, spanning: b }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    if (errors.length) {
      result.rendererErrors = errors
      result.pass = false
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'equalize-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
