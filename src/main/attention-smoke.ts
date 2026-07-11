import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OscParser } from '@backend/features/agent-state'

// Env-gated tab-attention smoke (MOGGING_ATTENTION): create a 2nd workspace so Workspace 1 is
// backgrounded, flip a pane in that background workspace to attention, assert its tab rings, then
// focus it and assert the ring clears. Exercises the per-workspace attention aggregation + latch.
// Plus (A) a main-side unit assert on the ONE parser rule that manufactures false attention.

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

  // FINISHED derivation (0.8.1): the green halo stamps ONLY a busy->idle edge that
  // lasted like work (>= 2.5s); an attention->idle edge answered/replayed its latch
  // away and completed NOTHING (a permission-blocked pane once pulsed green through
  // that edge — found live 2026-07-10). Port-driven: the chip attribute renders from
  // the port on every change, so no adopted session is needed to read it.
  const chip = () => { const e = document.querySelector('.layout-slot[data-pane-id="1"] .pane-state'); return e ? e.getAttribute('data-state') : null }
  m.attention.setPaneState(1, 'busy')
  await sleep(2700) // outlive the 2.5s work floor
  m.attention.setPaneState(1, 'idle')
  await sleep(300)
  const finishedFromBusy = chip() === 'finished'
  // A real click on the pane acknowledges the halo: back to plain idle.
  const slot1 = document.querySelector('.layout-slot[data-pane-id="1"]')
  if (slot1) slot1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await sleep(300)
  const ackClears = chip() === 'idle'
  // Same duration, blocked edge: never the green story.
  m.attention.setPaneState(1, 'attention')
  await sleep(2700)
  m.attention.setPaneState(1, 'idle')
  await sleep(300)
  const blockedNotFinished = chip() === 'idle'

  return {
    pass: ringed === 'attention' && !afterFocus && finishedFromBusy && ackClears && blockedNotFinished,
    ringed,
    afterFocus,
    finishedFromBusy,
    ackClears,
    blockedNotFinished,
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
