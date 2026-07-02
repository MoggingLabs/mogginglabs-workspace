import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated pane-operations smoke (MOGGING_PANEOPS): drive the terminal top bar's
// headline actions end-to-end on a 2×2 grid and assert real outcomes:
//  - expand VERTICAL (col): the pane spans full height, the pane under it hides,
//    the other column stays; toggling restores all four.
//  - expand HORIZONTAL (row): full width, the row-mate hides, other rows stay.
//  - CLOSE: the pane's terminal is disposed (its PTY dies via the slots port), the
//    grid reflows to a ragged 3-pane layout, and the survivors' content is intact.
const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const CR = String.fromCharCode(13)
  const m = window.__mogging
  if (!m || !m.workspace || !m.layout) return { pass: false, error: 'no dev handles' }

  if (m.workspace.count() === 0) m.workspace.create({ name: 'Workspace 1' })
  await sleep(600)
  m.layout.apply(4)
  for (let i = 0; i < 100 && (m.panes || []).length < 4; i++) await sleep(200)
  if ((m.panes || []).length < 4) return { pass: false, error: 'expected 4 panes' }
  await sleep(2200)
  for (const p of m.panes) p.write('echo OPS_' + p.id + '_END' + CR)
  await sleep(1500)

  const slot = (id) => document.querySelector('.layout-slot[data-pane-id="' + id + '"]')
  const visible = (id) => {
    const el = slot(id)
    return !!el && getComputedStyle(el).display !== 'none'
  }

  // 2×2 layout: [1 2] / [3 4]. Expand pane 1 to FULL HEIGHT -> 3 (below it) hides.
  m.layout.expand(1, 'col')
  await sleep(300)
  const colState = { p1: visible(1), p2: visible(2), p3: visible(3), p4: visible(4) }
  const colSpan = slot(1) ? slot(1).style.gridRow : ''
  const colOk = colState.p1 && colState.p2 && !colState.p3 && colState.p4 && colSpan.indexOf('-1') >= 0
  m.layout.expand(1, 'col') // toggle back
  await sleep(300)
  const colRestored = visible(1) && visible(2) && visible(3) && visible(4)

  // Expand pane 1 to FULL WIDTH -> 2 (beside it) hides, row 2 stays.
  m.layout.expand(1, 'row')
  await sleep(300)
  const rowState = { p1: visible(1), p2: visible(2), p3: visible(3), p4: visible(4) }
  const rowSpan = slot(1) ? slot(1).style.gridColumn : ''
  const rowOk = rowState.p1 && !rowState.p2 && rowState.p3 && rowState.p4 && rowSpan.indexOf('-1') >= 0
  m.layout.expand(1, 'row')
  await sleep(300)
  const rowRestored = visible(1) && visible(2) && visible(3) && visible(4)

  // CLOSE pane 2: its terminal disposes, survivors reflow (ragged 3) with content intact.
  m.layout.close(2)
  await sleep(800)
  const idsAfter = m.layout.paneIds()
  const paneObjs = (m.panes || []).map((p) => p.id)
  const closedGone = !paneObjs.includes(2) && !slot(2)
  const survivors = [1, 3, 4]
  const contentIntact = survivors.every((id) => {
    const p = (m.panes || []).find((x) => x.id === id)
    return !!p && p.text().indexOf('OPS_' + id + '_END') >= 0
  })
  const reflow = survivors.every((id) => visible(id)) && m.layout.paneCount() === 3

  const pass =
    colOk && colRestored && rowOk && rowRestored && closedGone && contentIntact && reflow &&
    idsAfter.length === 3
  return {
    pass,
    colOk, colState, colSpan, colRestored,
    rowOk, rowState, rowSpan, rowRestored,
    closedGone, contentIntact, reflow, idsAfter, paneObjs
  }
})()`

export function runPaneOpsSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000) // safety net
  const run = async (): Promise<void> => {
    let result: { pass?: boolean } = { pass: false }
    try {
      result = (await win.webContents.executeJavaScript(SCRIPT, true)) as { pass?: boolean }
    } catch (e) {
      result = { pass: false, ...{ error: String(e) } }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'paneops-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result?.pass ? 0 : 1)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
