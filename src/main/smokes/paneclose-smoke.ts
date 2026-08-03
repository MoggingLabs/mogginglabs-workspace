import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated pane-close UNDO smoke (MOGGING_PANECLOSE). Closing a pane now gets the same
// grace a workspace close gets (WS-01): the pane is DETACHED from its grid but parked
// alive — same terminal, same PTY — for exactly as long as the undo toast is up, and only
// disposed for good when the grace lapses. The cheap implementation (kill + respawn on
// undo) passes any test that only looks at where the pane ended up, so the proof of life
// here is ECHO, exactly as in the move-pane smoke: a marker typed into the pane WHILE it
// is parked can only ever render if the PTY was never killed.
//
// Asserted, in order:
//  - SOFT    × on an idle pane asks nothing, drops the count, hides the slot
//            (.soft-closed), and offers Undo in a toast.
//  - PARKED  the parked pane still echoes — the PTY lived through the whole grace.
//  - UNDO    the toast's real button puts it back: count, visibility, focus, scrollback
//            (the pre-close marker AND the parked-echo marker), and it still echoes.
//  - COPY    a LIVE pane still confirms first, and the dialog now promises the undo
//            ("a few seconds to undo") instead of claiming the close is irreversible;
//            Cancel keeps it; Close soft-closes it; Undo brings the live pane back.
//  - RESHAPE closing a pane and then SPLITTING during the grace must not make Undo
//            restore the old arrangement over the new pane's head — the pane re-enters
//            beside the focused one and NOTHING (old or new) is torn down.
//  - LAPSE   let the grace run out: the pane is disposed for real (handle gone, slot
//            gone, count stays down) and its survivors are untouched.
const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const CR = String.fromCharCode(13)
  const m = window.__mogging
  if (!m || !m.workspace || !m.layout) return { pass: false, error: 'no dev handles' }

  const slot = (id) => document.querySelector('.layout-slot[data-pane-id="' + id + '"]')
  const pane = (id) => (m.panes || []).find((p) => p.id === id)
  const undoBtn = () => Array.from(document.querySelectorAll('.toast-action')).pop()
  const modal = () => document.querySelector('.modal[role="dialog"]')
  const xClose = (id) => {
    const btn = document.querySelector('.layout-slot[data-pane-id="' + id + '"] .pane-act-close')
    if (btn) btn.click()
    return !!btn
  }
  // Echo-proof of a live PTY, re-issued because a single keystroke can race a reparent.
  const settle = async (id, marker, iters) => {
    const p = pane(id)
    if (!p) return false
    for (let i = 0; i < (iters || 45); i++) {
      if (i % 8 === 0) p.write('echo ' + marker + CR)
      await sleep(200)
      if (p.text().indexOf(marker) >= 0) return true
    }
    return false
  }

  // ── One workspace, three panes, shells prompting ─────────────────────────────────────
  const A = m.workspace.create({ name: 'Alpha', paneCount: 3 })
  for (let i = 0; i < 100 && (m.panes || []).length < 3; i++) await sleep(200)
  await sleep(2500)
  const P1 = A.ordinal * 100 + 1
  const P3 = A.ordinal * 100 + 3
  if (!pane(P1) || !pane(P3)) {
    return { pass: false, error: 'expected 3 panes', ids: (m.panes || []).map((p) => p.id) }
  }
  const beforeEchoed = await settle(P3, 'BEFORE_CLOSE_MARK')

  // ── SOFT: idle close asks nothing and offers Undo ────────────────────────────────────
  const closed = xClose(P3)
  await sleep(500)
  const askedNothing = !modal()
  const countDropped = m.layout.paneCount() === 2
  const idsExclude = m.layout.paneIds().indexOf(P3) < 0
  const parkedHidden = !!slot(P3) && slot(P3).classList.contains('soft-closed')
  const undoOffered = !!undoBtn() && undoBtn().textContent.trim() === 'Undo'

  // ── PARKED: it still echoes while hidden. Bounded tighter than the 6s grace — the
  // marker is re-checked after undo too, so a slow render cannot flake this red.
  const parked = pane(P3)
  const parkedSameObject = !!parked // the TerminalPane was never disposed (dispose kills the PTY)
  if (parked) parked.write('echo PARKED_ALIVE_MARK' + CR)
  let parkedEchoedLive = false
  for (let i = 0; i < 12 && !parkedEchoedLive; i++) {
    await sleep(200)
    parkedEchoedLive = !!parked && parked.text().indexOf('PARKED_ALIVE_MARK') >= 0
  }

  // ── UNDO: back in the grid, focused, history intact, still alive ─────────────────────
  const b1 = undoBtn()
  if (b1) b1.click()
  await sleep(600)
  const undoCount = m.layout.paneCount() === 3
  const undoInGrid = m.layout.paneIds().indexOf(P3) >= 0
  const undoVisible = !!slot(P3) && !slot(P3).classList.contains('soft-closed')
  const undoFocused = !!slot(P3) && slot(P3).classList.contains('focused')
  const aliveAfterUndo = await settle(P3, 'AFTER_UNDO_ALIVE')
  const parkedEchoed = parkedEchoedLive || (!!pane(P3) && pane(P3).text().indexOf('PARKED_ALIVE_MARK') >= 0)
  const historyIntact = !!pane(P3) && pane(P3).text().indexOf('BEFORE_CLOSE_MARK') >= 0

  // ── COPY: a live pane confirms first, and the dialog promises the undo ───────────────
  m.attention.setPaneTracked(P3, true)
  m.attention.setPaneState(P3, 'busy')
  await sleep(300)
  xClose(P3)
  await sleep(400)
  const liveAsks = !!modal()
  const liveMsg = modal() ? modal().textContent : ''
  const copyPromisesUndo = /a few seconds to undo/i.test(liveMsg) && !/cannot be undone/i.test(liveMsg)
  const ghost = document.querySelector('.modal .btn--ghost')
  if (ghost) ghost.click()
  await sleep(300)
  const cancelKept = m.layout.paneCount() === 3 && m.layout.paneIds().indexOf(P3) >= 0
  xClose(P3)
  await sleep(400)
  const danger = document.querySelector('.modal .btn--danger')
  if (danger) danger.click()
  await sleep(500)
  const liveSoftClosed = m.layout.paneCount() === 2 && !!undoBtn()
  const b2 = undoBtn()
  if (b2) b2.click()
  await sleep(600)
  const liveUndone = m.layout.paneCount() === 3 && (await settle(P3, 'LIVE_UNDO_ALIVE'))
  m.attention.setPaneState(P3, 'idle')
  m.attention.setPaneTracked(P3, false)
  await sleep(300)

  // ── RESHAPE: split during the grace; Undo must tear nothing down ─────────────────────
  xClose(P3)
  await sleep(400)
  const before = (m.panes || []).length
  m.layout.split('h')
  for (let i = 0; i < 15 && (m.panes || []).length <= before; i++) await sleep(200)
  const splitId = (m.layout.paneIds() || []).find((id) => id !== P1 && id !== P1 + 1 && id !== P3)
  const splitLanded = splitId != null
  const b3 = undoBtn()
  if (b3) b3.click()
  await sleep(600)
  const reshapeCount = m.layout.paneCount() === 4
  const reshapeBothPresent = m.layout.paneIds().indexOf(P3) >= 0 && splitLanded && m.layout.paneIds().indexOf(splitId) >= 0
  const reshapeClosedAlive = await settle(P3, 'RESHAPE_UNDO_ALIVE')
  const reshapeSplitAlive = splitLanded ? await settle(splitId, 'RESHAPE_SPLIT_ALIVE') : false

  // ── LAPSE: the grace runs out and the pane is disposed for real ──────────────────────
  xClose(P3)
  await sleep(6800)
  const lapsedHandleGone = !pane(P3)
  const lapsedSlotGone = !slot(P3)
  const lapsedCount = m.layout.paneCount() === 3
  const survivorAlive = await settle(P1, 'SURVIVOR_ALIVE')

  const pass =
    beforeEchoed && closed && askedNothing && countDropped && idsExclude && parkedHidden &&
    undoOffered && parkedSameObject &&
    undoCount && undoInGrid && undoVisible && undoFocused && aliveAfterUndo &&
    parkedEchoed && historyIntact &&
    liveAsks && copyPromisesUndo && cancelKept && liveSoftClosed && liveUndone &&
    splitLanded && reshapeCount && reshapeBothPresent && reshapeClosedAlive && reshapeSplitAlive &&
    lapsedHandleGone && lapsedSlotGone && lapsedCount && survivorAlive

  return {
    pass,
    soft: { beforeEchoed, closed, askedNothing, countDropped, idsExclude, parkedHidden, undoOffered },
    parked: { parkedSameObject, parkedEchoedLive, parkedEchoed },
    undo: { undoCount, undoInGrid, undoVisible, undoFocused, aliveAfterUndo, historyIntact },
    copy: { liveAsks, copyPromisesUndo, cancelKept, liveSoftClosed, liveUndone, liveMsg },
    reshape: { splitLanded, splitId, reshapeCount, reshapeBothPresent, reshapeClosedAlive, reshapeSplitAlive },
    lapse: { lapsedHandleGone, lapsedSlotGone, lapsedCount, survivorAlive }
  }
})()`

export function runPaneCloseSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const run = async (): Promise<void> => {
    let result: { pass?: boolean } = { pass: false }
    try {
      result = (await win.webContents.executeJavaScript(SCRIPT, true)) as { pass?: boolean }
    } catch (e) {
      result = { pass: false, ...{ error: String(e) } }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'paneclose-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result?.pass ? 0 : 1)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
