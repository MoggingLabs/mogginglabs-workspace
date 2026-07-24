import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated pane-fit smoke (MOGGING_PANEFIT=1) — the terminal fills its pane, exactly.
//
// Gates the whole fit contract that the 2026-07 rendering review repaired:
//
//  A. FIT TRUTH ON WEBGL  every pane's grid equals the house derivation (pane-fit.ts)
//     against the ACTIVE renderer's cell — cols = floor(contentWidth / cellW), dead
//     strip < one cell. This bites on BOTH repaired width bugs: FitAddon's phantom
//     14px scrollbar lane, and the missing renderer-swap refit (panes are FITTED on
//     the DOM renderer at mount, then painted by WebGL, which floors the measured
//     cell at device pixels — 8.4px -> 8.0px even at dpr 1, a ~5% dead strip unless
//     onRendererChanged refits).
//  A2. NON-VACUITY  the two renderers' cell widths actually differ in this run — a
//     future font/size change that lands on an integral cell width would make A
//     structurally blind, and this gate SAYS so instead of passing green forever.
//  B. RELEASE/RE-ACQUIRE CONVERGENCE  force the GL budget to 0 (the FLICKER 3c seam),
//     hide the workspace (releases land after the 1.5s debounce), assert panes fell
//     back to the DOM renderer AND kept their grid (hidden boxes are zero — a refit
//     that didn't bail on unmeasurable would destroy the grid); restore the budget,
//     switch back, and assert every pane re-acquires WebGL and CONVERGES back to fit
//     truth. Reverting the onRendererChanged seam turns this red.
//  C. FONT COVERAGE, LIVE  the vendored faces actually serve the glyphs terminals
//     draw: JBM answers box drawing, the symbols face answers braille + the dingbat
//     spinners — and stays unicode-range-scoped (it must NOT answer latin).
//  D. WINDOWSPTY BEFORE FIRST BYTE (win32)  a freshly split pane has
//     options.windowsPty set while its buffer is still EMPTY — the pre-spawn
//     emulation fetch, observed at the only moment that proves the ordering.
const EXPECT_CONPTY = process.platform === 'win32'

const SCRIPT = `(async () => {
  const EXPECT_CONPTY = ${JSON.stringify(EXPECT_CONPTY)}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const oneFrame = () => new Promise((r) => requestAnimationFrame(r))
  const m = window.__mogging
  if (!m || !m.workspace || !m.layout) return { pass: false, error: 'no dev handles' }

  if (m.workspace.count() === 0) m.workspace.create({ name: 'Fit' })
  await sleep(600)
  m.layout.apply(4)
  for (let i = 0; i < 100 && (m.panes || []).length < 4; i++) await sleep(200)
  const panes = (m.panes || []).slice(0, 4)
  if (panes.length < 4) return { pass: false, error: 'panes never mounted' }
  const checks = {}

  const cellOf = (p) => p.term._core._renderService.dimensions.css.cell
  const fitTruth = (p) => {
    const body = p.el().querySelector('.pane-body')
    const cs = getComputedStyle(body)
    const xs = getComputedStyle(p.term.element)
    const availW = parseFloat(cs.width) - parseFloat(xs.paddingLeft) - parseFloat(xs.paddingRight)
    const availH = parseFloat(cs.height) - parseFloat(xs.paddingTop) - parseFloat(xs.paddingBottom)
    const cell = cellOf(p)
    const wantCols = Math.max(2, Math.floor(availW / cell.width))
    const wantRows = Math.max(1, Math.floor(availH / cell.height))
    const deadPx = availW - p.cols() * cell.width
    return {
      renderer: p.renderer(),
      cols: p.cols(), wantCols, rows: p.rows(), wantRows,
      cellW: Math.round(cell.width * 1000) / 1000,
      deadPx: Math.round(deadPx * 10) / 10,
      ok: p.cols() === wantCols && p.rows() === wantRows && deadPx >= -0.01 && deadPx < cell.width
    }
  }
  const settleToFit = async (wantRenderer) => {
    // renderer + the 120ms refit coalescer + the resize round trip
    for (let i = 0; i < 80; i++) {
      await sleep(100)
      if (panes.every((p) => p.renderer() === wantRenderer) && panes.map(fitTruth).every((f) => f.ok)) break
    }
    return panes.map(fitTruth)
  }

  // A. fit truth on webgl
  const fitsA = await settleToFit('webgl')
  checks.fitOnWebgl = { pass: fitsA.every((f) => f.ok && f.renderer === 'webgl'), panes: fitsA }

  // A2. non-vacuity: the DOM measure vs webgl's device-floored cell must differ, or
  // assertion A cannot bite on the swap-refit seam — say so rather than rot silently.
  const raw = panes[0].term._core._charSizeService.width
  const webglCell = cellOf(panes[0]).width
  checks.divergence = {
    pass: Math.abs(raw - webglCell) > 0.01,
    domMeasuredCellW: Math.round(raw * 1000) / 1000,
    webglCellW: Math.round(webglCell * 1000) / 1000
  }

  // B. release on hide (budget 0), grid kept while unmeasurable, convergence on return
  const colsBefore = panes.map((p) => p.cols())
  window.__moggingGlBudget = 0
  m.workspace.create({ name: 'Other' })
  await sleep(2600) // hide + 1.5s release debounce + the one-per-frame job queue
  const released = panes.map((p) => p.renderer())
  const colsHidden = panes.map((p) => p.cols())
  checks.releaseOnHide = {
    pass: released.every((r) => r === 'dom') && colsHidden.join() === colsBefore.join(),
    released, colsBefore, colsHidden
  }
  window.__moggingGlBudget = 16
  m.workspace.switchByIndex(0)
  const fitsB = await settleToFit('webgl')
  checks.reacquireConverges = { pass: fitsB.every((f) => f.ok && f.renderer === 'webgl'), panes: fitsB }

  // C. font coverage, live in THIS renderer. No negative check here: fonts.check()
  // answers TRUE for any text that needs no loading, so a char OUTSIDE every face's
  // unicode-range is vacuously true — range scoping is asserted where it is knowable,
  // in FONTCOVER's parse of fonts.css.
  try { await document.fonts.load('14px "MoggingLabs Symbols"', '\\u280b') } catch {}
  const jbmBox = document.fonts.check('14px "JetBrains Mono Variable"', '\\u256d')
  const symBraille = document.fonts.check('14px "MoggingLabs Symbols"', '\\u280b')
  const symDingbat = document.fonts.check('14px "MoggingLabs Symbols"', '\\u273b')
  checks.fonts = { pass: jbmBox && symBraille && symDingbat, jbmBox, symBraille, symDingbat }

  // D. windowsPty before the first byte: split a FRESH pane and catch it at mount.
  // knownIds snapshots ALL current panes (the second workspace created in B spawned its
  // own — an id-set of only the first four would "discover" that stale pane, banner and
  // all). The check is .backend, not truthiness: xterm's DEFAULT windowsPty is {}.
  const knownIds = new Set((m.panes || []).map((p) => p.id))
  m.layout.apply(5)
  let p5 = null
  for (let i = 0; i < 600 && !p5; i++) {
    p5 = (m.panes || []).find((p) => !knownIds.has(p.id)) || null
    if (!p5) await oneFrame()
  }
  if (!p5) {
    checks.ptyEmulation = { pass: false, error: 'fifth pane never mounted' }
  } else if (!EXPECT_CONPTY) {
    checks.ptyEmulation = { pass: true, skipped: 'posix pty — windowsPty stays unset by contract' }
  } else {
    let textAtReady = null
    for (let i = 0; i < 600; i++) {
      const wp = p5.term.options.windowsPty
      if (wp && wp.backend) { textAtReady = p5.text().trim(); break }
      await oneFrame()
    }
    checks.ptyEmulation = {
      pass: textAtReady === '',
      backend: (p5.term.options.windowsPty || {}).backend || '(never set)',
      textAtReady: textAtReady === null ? '(never set)' : textAtReady.slice(0, 60)
    }
  }

  const pass = Object.values(checks).every((c) => c.pass === true)
  return { pass, ...checks }
})()`

export function runPaneFitSmoke(win: BrowserWindow): void {
  const wc = win.webContents
  const errors: string[] = []
  wc.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  const run = async (): Promise<void> => {
    let result: Record<string, unknown>
    try {
      result = (await wc.executeJavaScript(SCRIPT, true)) as Record<string, unknown>
    } catch (err) {
      result = { pass: false, error: String(err) }
    }
    result.rendererErrors = errors
    if (errors.length) result.pass = false
    try {
      writeFileSync(join(process.cwd(), 'out', 'panefit-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass === true ? 0 : 1)
  }
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
