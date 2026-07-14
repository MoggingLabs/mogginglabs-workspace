import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OscParser } from '@backend/features/agent-state'

// Env-gated tab-attention smoke (MOGGING_ATTENTION): create a 2nd workspace so Workspace 1 is
// backgrounded, flip a pane in that background workspace to attention, assert its tab rings, then
// focus it and assert the ring clears. Exercises the per-workspace attention aggregation + latch.
// Plus (A) a main-side unit assert on the ONE parser rule that manufactures false attention.
//
// It is ALSO the gate on THE VERDICT LAW — that green has exactly one source, an explicit `done`,
// and that silence is never mistaken for a completion. Those asserts are written to fail on the
// engine this replaced: it derived "finished" from a busy->idle edge over a 2.5s duration floor,
// so a pane that merely went quiet for long enough was stamped as having finished work.

/** Count the terminal bells a chunk sequence produces — the signal that latches a pane red. */
function bellsFor(chunks: string[]): number {
  let bells = 0
  const p = new OscParser(
    () => {},
    (ev) => {
      if (ev.kind === 'bell') bells++
    }
  )
  for (const c of chunks) p.push(c)
  return bells
}

/** A. An OSC body over MAX_OSC used to drop the parser to ground state mid-sequence, so the
 *  sequence's OWN terminator scanned as output: a >4KB OSC 52 clipboard write (vim/tmux emit
 *  exactly this) rang a bell and latched the pane red — "needs your input" for a yank. The
 *  overflow now discards to the real terminator instead. Both halves are asserted: the false
 *  bell is gone, and a GENUINE bell still rings (an overzealous swallow would be the same bug
 *  wearing the other mask). */
function oscOverflowAsserts(): { pass: boolean; falseBells: number; realBell: number; splitBells: number; stBells: number; cwdOk: boolean } {
  const big = 'A'.repeat(5000)
  const falseBells = bellsFor(['\x1b]52;c;' + big + '\x07'])
  // Same payload, arriving in small chunks: the discard state must survive push() boundaries.
  const payload = '\x1b]52;c;' + 'B'.repeat(6000) + '\x07'
  const chunks: string[] = []
  for (let i = 0; i < payload.length; i += 137) chunks.push(payload.slice(i, i + 137))
  const splitBells = bellsFor(chunks)
  // ST-terminated overflow with ESC and '\' landing in DIFFERENT chunks.
  const stBells = bellsFor(['\x1b]52;c;' + 'C'.repeat(5000) + '\x1b', '\\', 'plain output\n'])
  // The other half of the contract: a real bell, and a normal OSC 7, still work.
  const realBell = bellsFor(['some output\x07more'])
  let cwd: string | undefined
  const p = new OscParser(
    () => {},
    (ev) => {
      if (ev.kind === 'cwd') cwd = ev.payload
    }
  )
  p.push('\x1b]7;file:///C:/repo\x07')
  const cwdOk = cwd === 'file:///C:/repo'
  return {
    pass: falseBells === 0 && splitBells === 0 && stBells === 0 && realBell === 1 && cwdOk,
    falseBells,
    splitBells,
    stBells,
    realBell,
    cwdOk
  }
}
const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const m = window.__mogging
  if (!m || !m.workspace || !m.attention) return { pass: false, error: 'no dev handles' }
  // Launcher-first boot: provision Workspace 1 (ordinal 0 -> pane 1) ourselves.
  if (m.workspace.count() === 0) {
    m.workspace.create({ name: 'Workspace 1' })
    await sleep(600)
  }
  m.workspace.create({ name: 'Foreground' }) // ordinal 1, active -> Workspace 1 (ordinal 0) backgrounded
  await sleep(700)
  const bgTab = document.querySelectorAll('.workspace-tab')[0] // Workspace 1
  m.attention.setPaneState(1, 'attention') // pane 1 lives in Workspace 1 (base 0)
  await sleep(400)
  const ringed = bgTab.getAttribute('data-attention')
  m.workspace.switchByIndex(0) // focus Workspace 1 -> its ring clears
  await sleep(400)
  const afterFocus = bgTab.getAttribute('data-attention')

  // THE VERDICT LAW. Green has exactly ONE source — an explicit \`done\` verdict — and this is
  // the gate that says so. It is written to FAIL on the old engine, which derived "finished"
  // from a busy->idle EDGE over a 2.5s duration floor and therefore could not tell a Stop hook
  // from a terminal that had merely gone quiet. Under that rule, typing a prompt slowly, or
  // switching workspaces (the refit resizes the pty and ConPTY repaints its whole viewport),
  // or an agent pausing on a slow tool call, each stamped a pane "finished working".
  const slot = () => document.querySelector('.layout-slot[data-pane-id="1"]')
  const chip = () => { const e = document.querySelector('.layout-slot[data-pane-id="1"] .pane-state'); return e ? e.getAttribute('data-state') : null }
  const alert = () => { const s = slot(); return s ? s.getAttribute('data-alert') : null }
  const click = () => { const s = slot(); if (s) s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) }

  // 1. SILENCE IS NOT A COMPLETION. A long busy stretch that simply settles to idle greens
  //    NOTHING — this is the phantom green, and it is the whole reason for the rewrite.
  m.attention.setPaneState(1, 'busy')
  await sleep(2700) // outlive the OLD 2.5s work floor — under the old rule this WOULD have greened
  m.attention.setPaneState(1, 'idle')
  await sleep(300)
  const quietIsNotGreen = chip() === 'idle' && !alert()

  // 2. A VERDICT IS. \`done\` greens the pane, and the duration floor is gone with the guess that
  //    needed it: a done is a done whether the task took 300ms or 30 seconds.
  m.attention.setPaneState(1, 'busy')
  await sleep(150) // deliberately FAR under the old floor
  m.attention.setPaneState(1, 'done')
  await sleep(300)
  const doneGreensFast = chip() === 'finished' && alert() === 'finished'

  // 3. A click acknowledges it: dot back to yellow, resting outline gone.
  click()
  await sleep(300)
  const ackClears = chip() === 'idle' && !alert()

  // 4. A blocked pane wears a RED resting outline — the pane carries its own state now, rather
  //    than fading to nothing and leaving a 13px dot to tell the whole story.
  m.attention.setPaneState(1, 'attention')
  await sleep(300)
  const blockedOutline = chip() === 'attention' && alert() === 'input'

  // 5. ...and answering it is not finishing it. An attention->idle edge completed nothing.
  m.attention.setPaneState(1, 'idle')
  await sleep(300)
  const blockedNotFinished = chip() === 'idle' && !alert()

  // 6. A pane that has never spoken a verdict is HOLLOW, not yellow. \`unknown\` is the absence
  //    of a claim; \`idle\` is a claim ("nothing is running") we would have no basis for.
  const pane2 = document.querySelector('.layout-slot[data-pane-id="101"] .pane-state')
  const unknownIsHollow = !pane2 || pane2.getAttribute('data-state') === 'unknown'

  const pass = ringed === 'attention' && !afterFocus &&
    quietIsNotGreen && doneGreensFast && ackClears && blockedOutline && blockedNotFinished && unknownIsHollow
  return {
    pass,
    ringed,
    afterFocus,
    quietIsNotGreen,
    doneGreensFast,
    ackClears,
    blockedOutline,
    blockedNotFinished,
    unknownIsHollow,
    chipFinal: chip(),
    tabs: document.querySelectorAll('.workspace-tab').length
  }
})()`

export function runAttentionSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 30000) // safety net
  const run = async (): Promise<void> => {
    let result: { pass?: boolean; osc?: unknown; error?: string } = { pass: false }
    const osc = oscOverflowAsserts()
    try {
      const ui = (await win.webContents.executeJavaScript(SCRIPT, true)) as { pass?: boolean }
      result = { ...ui, osc, pass: ui.pass === true && osc.pass }
    } catch (e) {
      result = { pass: false, osc, ...{ error: String(e) } }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'attention-result.json'), JSON.stringify(result))
    } catch {
      /* best effort */
    }
    app.exit(result?.pass ? 0 : 1)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
