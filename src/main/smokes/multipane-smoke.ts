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
  // Launcher-first boot: provision the workspace this smoke drives.
  if (m.workspace && m.workspace.count() === 0) {
    m.workspace.create({ name: 'Workspace 1' })
    await sleep(800)
  }
  m.layout.apply(N)
  for (let i = 0; i < 60 && ((m.panes && m.panes.length) || 0) < N; i++) await sleep(200)
  const panes = (m.panes || []).slice()
  if (panes.length !== N) return { pass: false, error: 'expected ' + N + ' panes, got ' + panes.length, count: panes.length }
  await sleep(1500)
  // MARKER-based readiness with periodic re-sends, never a clock (the FLICKER
  // lesson, same signature: macos-26 run 30123386698 saw panes 5-7 hasOwn=false
  // with ZERO cross-talk — the slow shells of an 8-pane spawn wave ate the echo
  // during init; nothing was misrouted, the fill never landed). ~5s cadence,
  // 30s cap.
  for (let i = 0; i < 75; i++) {
    const missing = panes.filter((p) => p.text().indexOf('MARK_' + p.id + '_END') < 0)
    if (missing.length === 0) break
    if (i % 12 === 0) for (const p of missing) p.write('echo MARK_' + p.id + '_END' + CR)
    await sleep(400)
  }
  await sleep(600) // let the last echo settle before the capture
  const ids = panes.map((p) => p.id)
  const results = panes.map((p) => {
    const txt = p.text()
    const foreign = ids.filter((o) => o !== p.id && txt.indexOf('MARK_' + o + '_END') >= 0)
    return { id: p.id, hasOwn: txt.indexOf('MARK_' + p.id + '_END') >= 0, foreign: foreign, canvas: !!p.hasCanvas() }
  })
  const allOwn = results.every((r) => r.hasOwn)
  const noCrossTalk = results.every((r) => r.foreign.length === 0)
  const webglPanes = results.filter((r) => r.canvas).length

  // A pane that cannot MEASURE must claim no grid. Boot restore builds every workspace with
  // activate:false and switches to exactly one, so panes routinely mount into a display:none
  // subtree where proposeGrid returns null and xterm still holds its constructed 80x24.
  // Sending that as a viewport made the daemon RESIZE the surviving session down to it -
  // every workspace the user did not click first had its live agent squeezed to 80 columns.
  // Three-state seam: undefined = no spawn yet, null = spawned and claimed nothing, object =
  // claimed that grid. Waiting for the spawn to ISSUE is what keeps this from being vacuous.
  let hiddenGrid = { pass: false, why: 'not run' }
  if (m.workspace) {
    const before = new Set((m.panes || []).map((p) => p.id))
    m.workspace.create({ name: 'HiddenFit', activate: false })
    let hp = null
    for (let i = 0; i < 120 && !hp; i++) {
      hp = (m.panes || []).find((p) => !before.has(p.id)) || null
      if (!hp) await sleep(50)
    }
    if (!hp) hiddenGrid = { pass: false, why: 'hidden pane never mounted' }
    else {
      const view = hp.el().closest('.workspace-view')
      const isHidden = !!view && getComputedStyle(view).display === 'none'
      let dims = hp.spawnDims ? hp.spawnDims() : 'seam-missing'
      for (let i = 0; i < 200 && dims === undefined; i++) { await sleep(25); dims = hp.spawnDims() }
      hiddenGrid = {
        pass: isHidden === true && dims === null,
        mountedHidden: isHidden,
        spawnIssued: dims !== undefined,
        spawnDims: dims === undefined ? 'spawn-never-issued' : dims
      }
    }
  }

  // Past the WebGL cap with EVERY holder visible, the manager must ride the DOM renderer -
  // pane-capacity.ts says so in words ("GPU is deliberately NOT a count limit ... already
  // rides the DOM renderer past that edge"). Without a give-up branch it attached anyway,
  // Chromium force-lost the oldest context, and its owner re-acquired 1.5s later and evicted
  // the next one: a renderer-swap churn, each swap a metrics event -> refit -> ConPTY repaint
  // over whatever the agent is drawing. These 8 panes are all VISIBLE, so a forced budget of
  // 3 creates the real pressure (no hidden victim exists to reclaim).
  let glCap = { pass: false, why: 'not run' }
  if (m.workspace && m.workspace.switchByIndex) {
    // Budget 0 FIRST, then hide: the release is budget-aware (a hidden pane keeps its context
    // warm while the count fits), so hiding at budget 16 would leave all 8 attached and the
    // reveal would early-return with nothing to attach - no pressure, a vacuous check.
    window.__moggingGlBudget = 0
    m.workspace.switchByIndex(1)          // hide the 8 (the HiddenFit workspace made above)
    await sleep(3000)                     // release debounce + the one-per-frame job queue
    const releasedAll = panes.filter((p) => p.renderer && p.renderer() === 'webgl').length
    window.__moggingGlBudget = 3
    m.workspace.switchByIndex(0)          // reveal: every pane runs onShow -> attachNow
    await sleep(3500)
    const live = panes.filter((p) => p.renderer && p.renderer() === 'webgl').length
    // EXACTLY the budget, not merely "at most": without the give-up branch the panes attach
    // past the cap, Chromium force-loses contexts, and the retry ladder leaves the count
    // THRASHING - it reads 0 as readily as 8. A <= assertion passes on that churn for the
    // wrong reason. The fix's actual guarantee is that budget-many attach and STAY.
    glCap = { pass: live === 3 && releasedAll === 0, budget: 3, visiblePanes: panes.length, webglLive: live, releasedBeforeReveal: releasedAll }
    window.__moggingGlBudget = 16
  }

  return { pass: allOwn && noCrossTalk && panes.length === N && hiddenGrid.pass === true && glCap.pass === true, count: panes.length, allOwn, noCrossTalk, webglPanes, hiddenGrid, glCap, results }
})()`

export function runMultipaneSmoke(win: BrowserWindow): void {
  // Hard safety net: never hang the app if the renderer script stalls.
  setTimeout(() => app.exit(1), 60000)

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
