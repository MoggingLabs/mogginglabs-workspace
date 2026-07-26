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

  // The POSITIVE side of the spawn-dims seam. The negative side alone (hiddenGrid, below)
  // still passes on bytes that never send dims AT ALL - it takes both to pin the rule. A
  // VISIBLE, MEASURABLE pane must claim the grid it MEASURED. Reading this.term.cols at spawn
  // time sent xterm's CONSTRUCTED 80x24 instead: the ResizeObserver's first callback lands in
  // the NEXT frame's rendering steps, while the spawn runs a microtask after construction, so
  // the pane the user is actually looking at claimed a viewport it never had and the daemon
  // squeezed its agent to 80 columns until the first refit resized it back. Same three-state
  // discipline as hiddenGrid: poll the undefined state out (the spawn must have ISSUED) first.
  let visibleGrid = { pass: false, why: 'not run' }
  {
    const vp = panes[0]
    const vw = vp.el().closest('.workspace-view')
    const isShown = !!vw && getComputedStyle(vw).display !== 'none'
    let vd = vp.spawnDims ? vp.spawnDims() : 'seam-missing'
    for (let i = 0; i < 200 && vd === undefined; i++) { await sleep(25); vd = vp.spawnDims() }
    const measuredNow = { cols: vp.cols(), rows: vp.rows() }
    visibleGrid = {
      pass: isShown === true && !!vd && typeof vd === 'object' &&
        // Non-vacuity, stated: 80x24 is exactly what xterm carries when NOTHING measured it,
        // which is what the pre-fix spawn sent for a fully measurable pane.
        !(vd.cols === 80 && vd.rows === 24) &&
        // ...and it is THIS pane's grid, not merely some other number. Compared with a small
        // tolerance rather than by equality: the spawn measures against the DOM renderer and
        // WebGL attaches ~60ms later, and WebGL floors cells at DEVICE pixels while the DOM
        // renderer does not (PANEFIT A2 asserts those two measures DIFFER), so the post-swap
        // refit may legitimately land a column or a row away. A pre-fix 80x24 claim is nowhere
        // near this window, so the tolerance costs the assertion nothing.
        Math.abs(vd.cols - measuredNow.cols) <= 2 && Math.abs(vd.rows - measuredNow.rows) <= 2,
      mountedVisible: isShown,
      spawnIssued: vd !== undefined,
      claimed: vd === undefined ? 'spawn-never-issued' : vd,
      measuredNow: measuredNow
    }
  }

  // A live OSC 52 copy must survive a replay landing on top of it. Suppression used to be a
  // BOOLEAN raised when the replay EVENT arrived - but term.write only ENQUEUES (xterm parses
  // queued chunks in order and fires each chunk's callback after ITS own parse), so the flag
  // covered whatever was already in the queue rather than the replay payload. Two bites, both
  // driven through the pane's own backend-write door (p.feed - everything past it is shipped
  // code: the fence, xterm's parse, the OSC 52 handler, copyOrWarn, the system clipboard):
  //   (a) a LIVE chunk still unparsed when a replay lands must STILL copy. Pre-fix it parsed
  //       with the flag already up and was dropped silently - the exact case the feature
  //       exists for, after the CLI already told the user "Copied N characters to clipboard".
  //   (b) back-to-back REPLAYS must both stay inert. Pre-fix chunk 1's callback cleared the
  //       flag, so chunk 2 re-executed an old agent copy onto the live clipboard.
  // Read back through the same main-side door the CLIPBOARD gate uses, and restored after - a
  // gate must not walk off with the operator's clipboard.
  let osc52Replay = { pass: false, why: 'not run' }
  const bridge = window.bridge
  const p0 = panes[0]
  if (!bridge) osc52Replay = { pass: false, why: 'no bridge' }
  else if (typeof p0.feed !== 'function') osc52Replay = { pass: false, why: 'pane handle has no feed seam' }
  else {
    const ESC = String.fromCharCode(27)
    const BEL = String.fromCharCode(7)
    const osc52 = (text) => ESC + ']52;c;' + btoa(text) + BEL
    const prior = await bridge.invoke('clipboard:read')
    await bridge.invoke('clipboard:write', { text: 'BEFORE_5591', source: 'app' })
    // Legibility: this phase hard-depends on a usable system clipboard. Say THAT rather than
    // letting a headless runner's dead clipboard read as a replay-suppression failure.
    const clipboardUsable = (await bridge.invoke('clipboard:read')) === 'BEFORE_5591'
    // Live FIRST, replay immediately after: the live chunk is still QUEUED and unparsed when
    // the replay arrives - the exact ordering that used to eat it.
    p0.feed(osc52('LIVE_5591'), false)
    p0.feed(osc52('REPLAYED_5591'), true)
    let held = ''
    for (let i = 0; i < 40; i++) {
      held = await bridge.invoke('clipboard:read')
      if (held === 'LIVE_5591') break
      await sleep(100)
    }
    const liveHonoured = held === 'LIVE_5591'
    p0.feed(osc52('REPLAY_A_5591'), true)
    p0.feed(osc52('REPLAY_B_5591'), true)
    await sleep(1200) // nothing to poll FOR - this asserts that nothing happened
    const afterReplays = await bridge.invoke('clipboard:read')
    const replaysInert = afterReplays !== 'REPLAY_A_5591' && afterReplays !== 'REPLAY_B_5591'
    osc52Replay = {
      pass: clipboardUsable === true && liveHonoured === true && replaysInert === true,
      why: clipboardUsable ? undefined : 'no usable system clipboard on this runner',
      clipboardUsable: clipboardUsable, liveHonoured: liveHonoured, replaysInert: replaysInert,
      held: held, afterReplays: afterReplays
    }
    if (typeof prior === 'string' && prior) {
      try { await bridge.invoke('clipboard:write', { text: prior, source: 'app' }) } catch (e) { /* best effort */ }
    }
  }

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
    // Stated dependency: this phase needs real WebGL on the runner (new for MULTIPANE).
    // Record what the panes were doing BEFORE the budget is touched, so "this box has no GL"
    // reads as itself instead of as a give-up-branch failure.
    const webglBefore = panes.filter((p) => p.renderer && p.renderer() === 'webgl').length
    // Budget 0 FIRST, then hide: the release is budget-aware (a hidden pane keeps its context
    // warm while the count fits), so hiding at budget 16 would leave all 8 attached and the
    // reveal would early-return with nothing to attach - no pressure, a vacuous check.
    window.__moggingGlBudget = 0
    m.workspace.switchByIndex(1)          // hide the 8 (the HiddenFit workspace made above)
    // POLL, never a fixed beat. BOTH transitions are a debounce (1500ms release / 60ms
    // acquire) followed by the app-wide ONE-JOB-PER-requestAnimationFrame queue, so eight
    // panes cost eight frames when rAF is healthy and seconds when it is throttled - which is
    // exactly the "rAF starves an occluded window" mode RAILFOLD was bitten by. flicker-smoke
    // drives these identical transitions with the same ladder. The ASSERTIONS below stay
    // exact (=== 0, === 3); only the waiting is robust.
    let releasedAll = panes.length
    for (let i = 0; i < 25; i++) {
      releasedAll = panes.filter((p) => p.renderer && p.renderer() === 'webgl').length
      if (releasedAll === 0) break
      await sleep(400)
    }
    window.__moggingGlBudget = 3
    m.workspace.switchByIndex(0)          // reveal: every pane runs onShow -> attachNow
    let live = 0
    for (let i = 0; i < 25; i++) {
      live = panes.filter((p) => p.renderer && p.renderer() === 'webgl').length
      if (live === 3) break
      await sleep(500)
    }
    // EXACTLY the budget, not merely "at most": without the give-up branch the panes attach
    // past the cap, Chromium force-loses contexts, and the retry ladder leaves the count
    // THRASHING - it reads 0 as readily as 8. A <= assertion passes on that churn for the
    // wrong reason. The fix's actual guarantee is that budget-many attach and STAY - so
    // SETTLE, then CONFIRM: re-read after a beat and demand the same number, or a poll that
    // caught 3 in passing through a churn would report the fix's guarantee on its absence.
    await sleep(900)
    const stillLive = panes.filter((p) => p.renderer && p.renderer() === 'webgl').length
    glCap = {
      pass: webglBefore > 0 && releasedAll === 0 && live === 3 && stillLive === 3,
      why: webglBefore === 0 ? 'no WebGL contexts on this runner before the budget was touched' : undefined,
      budget: 3, visiblePanes: panes.length, webglBefore: webglBefore,
      webglLive: live, webglStillLive: stillLive, releasedBeforeReveal: releasedAll
    }
    window.__moggingGlBudget = 16
  }

  return { pass: allOwn && noCrossTalk && panes.length === N && visibleGrid.pass === true && osc52Replay.pass === true && hiddenGrid.pass === true && glCap.pass === true, count: panes.length, allOwn, noCrossTalk, webglPanes, visibleGrid, osc52Replay, hiddenGrid, glCap, results }
})()`

export function runMultipaneSmoke(win: BrowserWindow): void {
  // Hard safety net: never hang the app if the renderer script stalls. It must sit ABOVE the
  // script's own worst case, not near it: the timer starts HERE, before did-finish-load and
  // before the +2500 ms below, and a burned net is app.exit(1) with NO result file - the gate
  // then reports MISSING, which loses every flag the script would have written. Worst case at
  // 200 ms/poll granularity: 0.8 + 12 (pane mount) + 1.5 + 30 (marker cap) + 0.6 + 5
  // (visibleGrid) + ~5.5 (osc52) + 11 (hiddenGrid) + ~23 (glCap polls) ~= 90 s, so 120 s
  // leaves real headroom while staying well inside the gate's own 180 s (qa-smokes.sh).
  setTimeout(() => app.exit(1), 120000)

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
