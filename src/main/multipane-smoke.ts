import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Env-gated multi-pane smoke (MOGGING_MULTIPANE): apply an 8-pane layout, write a DISTINCT
 * marker into each pane, then assert every pane shows ONLY its own marker (isolation +
 * per-pane routing). Proves N panes stream concurrently with no cross-talk.
 */
const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const CR = String.fromCharCode(13)
  const N = 8
  const m = window.__mogging
  if (!m || !m.layout) return { pass: false, error: 'no layout dev handle' }
  m.layout.apply(N)
  for (let i = 0; i < 60 && ((m.panes && m.panes.length) || 0) < N; i++) await sleep(200)
  const panes = (m.panes || []).slice()
  if (panes.length !== N) return { pass: false, error: 'expected ' + N + ' panes, got ' + panes.length, count: panes.length }
  await sleep(1500)
  for (const p of panes) p.write('echo MARK_' + p.id + '_END' + CR)
  await sleep(2800)
  const ids = panes.map((p) => p.id)
  const results = panes.map((p) => {
    const txt = p.text()
    const foreign = ids.filter((o) => o !== p.id && txt.indexOf('MARK_' + o + '_END') >= 0)
    return { id: p.id, hasOwn: txt.indexOf('MARK_' + p.id + '_END') >= 0, foreign: foreign, canvas: !!p.hasCanvas() }
  })
  const allOwn = results.every((r) => r.hasOwn)
  const noCrossTalk = results.every((r) => r.foreign.length === 0)
  const webglPanes = results.filter((r) => r.canvas).length
  return { pass: allOwn && noCrossTalk && panes.length === N, count: panes.length, allOwn, noCrossTalk, webglPanes, results }
})()`

export function runMultipaneSmoke(win: BrowserWindow): void {
  // Hard safety net: never hang the app if the renderer script stalls.
  setTimeout(() => app.exit(1), 30000)

  const run = async (): Promise<void> => {
    let result: unknown
    try {
      result = await win.webContents.executeJavaScript(SCRIPT, true)
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'multipane-result.json'), JSON.stringify(result))
    } catch {
      /* best effort */
    }
    app.exit(result && (result as { pass?: boolean }).pass ? 0 : 1)
  }

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => setTimeout(run, 2500))
  } else {
    setTimeout(run, 2500)
  }
}
