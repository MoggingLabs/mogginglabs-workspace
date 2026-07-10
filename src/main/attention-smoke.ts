import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated tab-attention smoke (MOGGING_ATTENTION): create a 2nd workspace so Workspace 1 is
// backgrounded, flip a pane in that background workspace to attention, assert its tab rings, then
// focus it and assert the ring clears. Exercises the per-workspace attention aggregation + latch.
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
    let result: { pass?: boolean } = { pass: false }
    try {
      result = (await win.webContents.executeJavaScript(SCRIPT, true)) as { pass?: boolean }
    } catch (e) {
      result = { pass: false, ...{ error: String(e) } }
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
