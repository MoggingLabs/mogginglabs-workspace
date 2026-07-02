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
  return {
    pass: ringed === 'attention' && !afterFocus,
    ringed,
    afterFocus,
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
