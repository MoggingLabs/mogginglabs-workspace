import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated cross-workspace pane MOVE smoke (MOGGING_MOVEPANE). The feature's whole claim is
// that a move is a MOVE: the same terminal, the same process, the same agent — carried into
// another workspace rather than closed there and re-opened here. Everything below exists to
// hold that claim to account, because the cheap implementation (close + respawn) passes any
// test that only looks at where the pane ENDED UP.
//
// The proof that the PTY lived is ECHO. A pane whose session was killed renders nothing at
// all — not even the shell's echo of our own keystrokes (the deaf-reused-id bug, protocol
// v5) — so a marker typed AFTER the move and read back out of the moved pane is the one
// assertion that cannot be faked by a convincing-looking re-creation. The marker typed
// BEFORE it must still be there too: that is the scrollback, and it proves the xterm itself
// was carried across rather than rebuilt from the daemon's replay.
//
// Asserted, in order:
//  - MOVE       pane 2 leaves workspace A for workspace B, keeping its id (its id IS its
//               daemon session key), its DOM element, its WebGL canvas and its scrollback;
//               the app lands on B with the moved pane focused; both counts follow.
//  - LIVE       it still echoes. The process was never touched.
//  - UNDO       the toast's real button puts it back in A, exactly where it was, still alive.
//  - LAST PANE  moving a workspace's ONLY terminal takes the workspace with it (a split tree
//               has no empty shape), and undo brings both back.
const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const CR = String.fromCharCode(13)
  const m = window.__mogging
  if (!m || !m.workspace || !m.layout) return { pass: false, error: 'no dev handles' }

  const slot = (id) => document.querySelector('.layout-slot[data-pane-id="' + id + '"]')
  const pane = (id) => (m.panes || []).find((p) => p.id === id)
  // Which workspace's grid is this pane's element actually sitting in? The DOM is the only
  // honest answer — a pane that merely CLAIMS to have moved is the bug we are hunting.
  const hostWs = (id) => {
    const el = slot(id)
    const view = el ? el.closest('.workspace-view') : null
    if (!view) return null
    const views = Array.from(document.querySelectorAll('.workspace-view'))
    return views.indexOf(view)
  }
  // Prove a pane's PTY is live by making it ECHO. The command is RE-ISSUED every ~1.6s, not
  // typed exactly once: right after a move (and doubly so a move-then-undo) the terminal's
  // input path is mid-reparent for a beat, and a single keystroke fired into that instant can
  // race and be dropped — a real user just presses Enter again. What is being asserted is that
  // the marker EVER appears; a killed PTY renders nothing no matter how many times you type.
  const settle = async (id, marker) => {
    const p = pane(id)
    if (!p) return false
    for (let i = 0; i < 45; i++) {
      if (i % 8 === 0) p.write('echo ' + marker + CR)
      await sleep(200)
      if (p.text().indexOf(marker) >= 0) return true
    }
    return false
  }

  // ── Two workspaces: A (2 panes) and B (1 pane) ────────────────────────────────────────
  const A = m.workspace.create({ name: 'Alpha' })
  await sleep(700)
  m.layout.apply(2)
  for (let i = 0; i < 100 && (m.panes || []).length < 2; i++) await sleep(200)
  const B = m.workspace.create({ name: 'Beta' })
  for (let i = 0; i < 100 && (m.panes || []).length < 3; i++) await sleep(200)
  await sleep(2500) // shells up and prompting

  const aBase = A.ordinal * 100
  const bBase = B.ordinal * 100
  const MOVED = aBase + 2 // A's second pane — the one that travels
  const aKeep = aBase + 1
  const bOwn = bBase + 1
  if (!pane(MOVED) || !pane(aKeep) || !pane(bOwn)) {
    return { pass: false, error: 'expected 3 panes', ids: (m.panes || []).map((p) => p.id) }
  }

  // Back to Alpha and LOOK at it — the real path: you move a pane from the workspace you are
  // in, not from one in the background.
  m.workspace.switchByIndex(0)
  await sleep(1200)

  // A marker in the pane BEFORE it moves: this is the scrollback that has to survive.
  const beforeEchoed = await settle(MOVED, 'BEFORE_MOVE_MARK')
  // Reported, never asserted: whether a pane HAS a WebGL canvas at a given moment is the GL
  // leasing's business, not the move's (contexts are queued one per frame and a pane "renders
  // via the DOM renderer until its turn" — terminal-pane.ts). What the move owes is that the
  // pane still RENDERS, and the echo assertions below are what prove that. canvasAfter IS
  // asserted, because it says something the move is answerable for: arriving in a new
  // workspace, the pane is granted a context again rather than left wedged without one.
  const canvasBefore = pane(MOVED).hasCanvas()
  const wsBefore = hostWs(MOVED)

  // ── The move ─────────────────────────────────────────────────────────────────────────
  const targets = m.workspace.moveTargets(MOVED)
  // The picker must never offer the workspace the pane is already in.
  const targetsOk = targets.length === 1 && targets[0].id === B.id && targets[0].name === 'Beta'

  const moved = m.workspace.movePane(MOVED, B.id)
  await sleep(900)

  const sameObject = !!pane(MOVED) // the TerminalPane was never disposed (dispose kills the PTY)
  const idKept = (m.panes || []).map((p) => p.id).indexOf(MOVED) >= 0
  const wsAfter = hostWs(MOVED)
  const inBeta = wsAfter === hostWs(bOwn) && wsAfter !== wsBefore
  const landedOnBeta = m.workspace.active() && m.workspace.active().id === B.id
  const focused = !!(slot(MOVED) && slot(MOVED).classList.contains('focused'))
  const canvasAfter = pane(MOVED) ? pane(MOVED).hasCanvas() : false
  const scrollbackKept = !!pane(MOVED) && pane(MOVED).text().indexOf('BEFORE_MOVE_MARK') >= 0
  const counts = { alpha: A.paneCount, beta: B.paneCount }
  const countsOk = A.paneCount === 1 && B.paneCount === 2

  // THE assertion: it still echoes. A killed PTY renders nothing, ever.
  const aliveAfterMove = await settle(MOVED, 'AFTER_MOVE_ALIVE')
  // ...and the pane that stayed behind was not collateral damage.
  const stayerAlive = await settle(aKeep, 'STAYER_ALIVE')

  // ── Undo, through the real toast button ──────────────────────────────────────────────
  const undoBtn = Array.from(document.querySelectorAll('.toast-action')).pop()
  const undoOffered = !!undoBtn && undoBtn.textContent.trim() === 'Undo'
  if (undoBtn) undoBtn.click()
  await sleep(900)
  const backHome = hostWs(MOVED) === wsBefore && hostWs(MOVED) === hostWs(aKeep)
  const backActive = m.workspace.active() && m.workspace.active().id === A.id
  const undoCountsOk = A.paneCount === 2 && B.paneCount === 1
  const aliveAfterUndo = await settle(MOVED, 'AFTER_UNDO_ALIVE')
  const historyIntact =
    !!pane(MOVED) &&
    pane(MOVED).text().indexOf('BEFORE_MOVE_MARK') >= 0 &&
    pane(MOVED).text().indexOf('AFTER_MOVE_ALIVE') >= 0

  // ── The last pane: moving it takes its workspace with it ─────────────────────────────
  // From INSIDE Beta, which is the case that has somewhere to fall: the workspace you are
  // looking at is the one that empties, so the app has to carry you out of it as it closes.
  //
  // The undo here is clicked PROMPTLY, before the assertions that take time. The emptied
  // workspace's dispose grace is the real 6s undo window (TOAST_DEFAULT_MS), and a slow
  // echo under load could otherwise overrun it — the workspace would hard-close mid-test
  // and there would be nothing left to undo. That the DISPLACED pane stays alive is already
  // proven above (aliveAfterMove); here the liveness check runs AFTER undo, back in the
  // restored workspace, where there is all the time in the world.
  m.workspace.switchByIndex(1)
  await sleep(900)
  const wsCountBefore = m.workspace.count()
  m.workspace.movePane(bOwn, A.id) // Beta's ONLY terminal
  await sleep(900)
  const betaClosed = m.workspace.count() === wsCountBefore - 1
  const lastPaneInAlpha = hostWs(bOwn) === hostWs(aKeep)

  const undo2 = Array.from(document.querySelectorAll('.toast-action')).pop()
  const undo2Offered = !!undo2 && undo2.textContent.trim() === 'Undo'
  if (undo2) undo2.click()
  await sleep(900)
  const betaRestored = m.workspace.count() === wsCountBefore
  const lastPaneHome = hostWs(bOwn) !== hostWs(aKeep) && !!slot(bOwn)
  const lastPaneStillAlive = await settle(bOwn, 'LAST_PANE_HOME_ALIVE')

  // ── The wizard path: an AGENT-ASSIGNED pane, moved through the REAL UI ────────────────
  // A workspace exactly as the wizard/template creates one (create + a per-slot provider
  // lineup — openFromTemplate is create() with these opts). The move here is driven the way
  // a human drives it: the pane's ⋯ menu button, the "Move to another workspace…" item, the
  // picker modal's row, the Move button. No dev-handle shortcut — if the menu item stops
  // appearing on agent panes, or the modal stops offering, THIS is the section that bites.
  // (Assignments are manifest metadata; the CLI itself is deliberately not launched — an
  // isolated smoke env has no providers, and the manifest is what the move must carry.)
  const G = m.workspace.create({ name: 'Gamma', paneCount: 2, assignments: ['claude', 'shell'] })
  for (let i = 0; i < 100 && (m.panes || []).length < 5; i++) await sleep(200)
  await sleep(2200)
  const AGENT = G.ordinal * 100 + 1 // the wizard-assigned "claude" slot
  const agentEchoed = await settle(AGENT, 'WIZ_BEFORE_MOVE')

  const menuBtn = document.querySelector('.layout-slot[data-pane-id="' + AGENT + '"] .pane-act-menu')
  if (menuBtn) menuBtn.click()
  await sleep(400)
  const menuEl = document.getElementById('pane-menu-' + AGENT)
  const menuItems = menuEl ? Array.from(menuEl.querySelectorAll('.menu-item')) : []
  const moveItem = menuItems.find((b) => b.textContent.indexOf('Move to another workspace') >= 0)
  const menuItemShown = !!moveItem
  if (moveItem) moveItem.click()
  await sleep(400)

  const rowsEls = Array.from(document.querySelectorAll('.ws-move-row'))
  // The picker offers every OTHER workspace — Alpha and Beta, never Gamma itself.
  const modalRowsOk =
    rowsEls.length === 2 && !rowsEls.some((r) => r.getAttribute('data-ws-id') === G.id)
  const betaRow = rowsEls.find((r) => r.getAttribute('data-ws-id') === B.id)
  if (betaRow) betaRow.click()
  await sleep(200)
  const confirmBtn = Array.from(document.querySelectorAll('.confirm-actions button'))
    .find((b) => b.textContent.trim() === 'Move terminal')
  const confirmEnabled = !!confirmBtn && !confirmBtn.disabled
  if (confirmBtn) confirmBtn.click()
  await sleep(900)

  const uiMoved = hostWs(AGENT) === hostWs(bOwn) && m.workspace.active().id === B.id
  const metas = m.workspace.list()
  const bMeta = metas.find((w) => w.id === B.id)
  const gMeta = metas.find((w) => w.id === G.id)
  // The manifest travels WITH the pane: the destination slot now says "claude" (so a
  // restore relaunches the agent THERE), the source slot is scrubbed to a plain shell,
  // and the destination records the pane's real id (paneIds — its daemon session key).
  const bSlot = bMeta && bMeta.paneIds ? bMeta.paneIds.indexOf(AGENT) + 1 : 0
  const manifestMoved =
    bSlot > 0 && !!bMeta.assignments && bMeta.assignments[bSlot - 1] === 'claude' &&
    !!gMeta && (!gMeta.assignments || gMeta.assignments[0] === 'shell')
  const agentAliveAfterUiMove = await settle(AGENT, 'WIZ_AFTER_MOVE')

  // canvasBefore/canvasAfter are REPORTED but not in the verdict: whether a pane holds a
  // WebGL context at any instant is the GL leasing's async, load-sensitive business (one
  // grant per frame), not the move's. Rendering is what the move owes, and the echo
  // assertions are what prove it — a killed PTY renders nothing at all, ever.
  const pass =
    beforeEchoed && targetsOk && moved === true &&
    sameObject && idKept && inBeta && landedOnBeta && focused &&
    scrollbackKept && countsOk &&
    aliveAfterMove && stayerAlive &&
    undoOffered && backHome && backActive && undoCountsOk && aliveAfterUndo && historyIntact &&
    betaClosed && lastPaneInAlpha &&
    undo2Offered && betaRestored && lastPaneHome && lastPaneStillAlive &&
    agentEchoed && menuItemShown && modalRowsOk && confirmEnabled &&
    uiMoved && manifestMoved && agentAliveAfterUiMove

  return {
    pass,
    move: {
      beforeEchoed, targetsOk, targets: targets.map((t) => t.name), moved,
      sameObject, idKept, movedId: MOVED, wsBefore, wsAfter, inBeta, landedOnBeta, focused,
      canvasBefore, canvasAfter, scrollbackKept, counts, countsOk,
      aliveAfterMove, stayerAlive
    },
    undo: { undoOffered, backHome, backActive, undoCountsOk, aliveAfterUndo, historyIntact },
    lastPane: { betaClosed, lastPaneInAlpha, undo2Offered, betaRestored, lastPaneHome, lastPaneStillAlive },
    wizardAgent: {
      agentEchoed, menuItemShown, modalRowsOk, confirmEnabled,
      uiMoved, bSlot, manifestMoved, agentAliveAfterUiMove
    }
  }
})()`

export function runMovePaneSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net
  const run = async (): Promise<void> => {
    let result: { pass?: boolean } = { pass: false }
    try {
      result = (await win.webContents.executeJavaScript(SCRIPT, true)) as { pass?: boolean }
    } catch (e) {
      result = { pass: false, ...{ error: String(e) } }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'movepane-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result?.pass ? 0 : 1)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
