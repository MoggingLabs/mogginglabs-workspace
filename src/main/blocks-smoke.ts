import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated command-block smoke (MOGGING_BLOCKS): inject two OSC 133 command sequences (exit 0 +
// non-zero) into a pane's terminal, then assert the block model (count, exit codes, commands),
// the collapse toggle, and search. Injected via term.write so no shell 133 emitter is needed.
const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7)
  const CRLF = String.fromCharCode(13) + String.fromCharCode(10)
  const osc = (s) => ESC + ']133;' + s + BEL
  const m = window.__mogging
  if (!m || !m.workspace) return { pass: false, error: 'no dev handles' }
  // Launcher-first boot: provision the pane this smoke writes into.
  if (m.workspace.count() === 0) m.workspace.create({ name: 'Workspace 1' })
  for (let i = 0; i < 50 && !(m.panes && m.panes[0]); i++) await sleep(200)
  const pane = m.panes && m.panes[0]
  if (!pane || !pane.blocks) return { pass: false, error: 'no pane/blocks handle' }
  pane.term.write(osc('A') + 'prompt$ ' + osc('B') + 'echo hi' + osc('C') + CRLF + 'hi' + CRLF + osc('D;0'))
  await sleep(300)
  pane.term.write(osc('A') + 'prompt$ ' + osc('B') + 'false' + osc('C') + CRLF + osc('D;1'))
  await sleep(400)
  const blocks = pane.blocks()
  const exits = blocks.map((b) => b.exitCode)
  const cmds = blocks.map((b) => b.command)
  if (blocks[0]) pane.toggleBlock(blocks[0].id)
  await sleep(200)
  const after = pane.blocks()
  const collapsed = !!(after[0] && after[0].collapsed)
  const found = pane.findBlocks('1')
  return {
    pass: blocks.length === 2 && exits[0] === 0 && exits[1] === 1 && collapsed && found.length >= 1,
    count: blocks.length,
    exits,
    cmds,
    collapsed,
    found: found.length
  }
})()`

export function runBlocksSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 30000) // safety net
  const run = async (): Promise<void> => {
    let result: { pass?: boolean } = { pass: false }
    try {
      result = (await win.webContents.executeJavaScript(SCRIPT, true)) as { pass?: boolean }
    } catch (e) {
      result = { pass: false, ...{ error: String(e) } }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'blocks-result.json'), JSON.stringify(result))
    } catch {
      /* best effort */
    }
    app.exit(result?.pass ? 0 : 1)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
