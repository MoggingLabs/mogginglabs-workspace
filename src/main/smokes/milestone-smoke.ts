import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { softFps, softGapMs } from './smoke-shell'

// Env-gated Phase-2 MILESTONE smoke (MOGGING_MILESTONE): "16 agents, see who needs you at a
// glance, nothing freezes." Two phases, all ASSERTED (not eyeballed):
//
//  A — scale + responsiveness: apply the 16-pane grid (16 real PTYs through the daemon), then for
//      ~4s torrent ANSI-colored, scrolling output into ALL 16 xterms (the worst rendering case —
//      full-viewport scroll everywhere) while sampling requestAnimationFrame gaps. During the
//      torrent, flip panes 13-16 to attention END-TO-END (a `node -e` one-liner in each pane emits
//      OSC 9 -> daemon OscParser -> state relay -> badge chip). Assert: 16 panes mounted, the perf
//      budget below holds, the 4 badges ring, a control pane does not, and the visible grid runs
//      (mostly) on the WebGL renderer.
//
//  B — attention at a glance + context management: create a 2nd workspace (the 16-pane grid backgrounds)
//      -> its tab must ring (latched attention) and ALL 16 hidden panes must have RELEASED their
//      WebGL contexts (DOM renderer; the browser caps ~16 live contexts/page). Switch back ->
//      the ring clears, panes re-acquire WebGL, and an idle frame sample stays within budget.
//
// Run with a FRESH isolated daemon (see docs/05-perf-budget.md): deterministic pane ids + new code.

/** The Phase-2 perf budget — asserted below, documented (with the measured baseline) in
 *  docs/05-perf-budget.md. Calibrated 2026-07-01 from a first measured run (worst gap 48.6ms,
 *  135avg fps @144Hz, 28MB heap, 16/16 webgl): each gate carries ~3-10x headroom for slower
 *  machines, yet a real regression (a sync stall, a leak, a dead renderer) blows straight
 *  through it. A regression here FAILS the Phase-2 gate. */
export const BUDGET = {
  panes: 16,
  /** Main thread must never be blocked longer than this (worst rAF gap) — during stress OR idle.
   *  MOGGING_CI_GPU=soft (Linux CI, software GL) relaxes ONLY this, loudly. */
  maxFrameGapMs: softGapMs(150),
  /** Average fps floor across the 4s stress window (60fps target; display-rate-independent floor). */
  minAvgFps: softFps(30),
  /** Renderer JS heap cap with 16 live panes + scrollback (-1 heap reading skips the check). */
  maxHeapMB: 300,
  /** Visible panes that must hold the WebGL renderer (tolerates a few cap evictions on weak GPUs). */
  minWebglVisible: 12
}

const SCRIPT = `(async () => {
  const B = ${JSON.stringify(BUDGET)}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const CR = String.fromCharCode(13)
  const ESC = String.fromCharCode(27)
  const m = window.__mogging
  if (!m || !m.layout || !m.workspace) return { pass: false, error: 'no dev handles' }

  // --- Phase A: 16 panes -------------------------------------------------------------------
  // Launcher-first boot: provision the workspace whose grid we stress.
  if (m.workspace.count() === 0) {
    m.workspace.create({ name: 'Workspace 1' })
    await sleep(600)
  }
  m.layout.apply(16)
  for (let i = 0; i < 300 && (m.panes || []).filter((p) => p.id <= 16).length < 16; i++) await sleep(200)
  const panes = (m.panes || []).filter((p) => p.id <= 16)
  if (panes.length < 16) return { pass: false, error: 'expected 16 panes, got ' + panes.length }
  await sleep(2500) // let all 16 shells reach a prompt

  // Frame sampler: collect rAF gaps for a window.
  const sample = (ms) => new Promise((res) => {
    const gaps = []
    let last = performance.now()
    const t0 = last
    const tick = (now) => {
      gaps.push(now - last)
      last = now
      if (now - t0 < ms) requestAnimationFrame(tick)
      else res(gaps)
    }
    requestAnimationFrame(tick)
  })
  const metrics = (gaps, ms) => ({
    frames: gaps.length,
    avgFps: Math.round((gaps.length / (ms / 1000)) * 10) / 10,
    maxGapMs: Math.round(Math.max.apply(null, gaps) * 10) / 10,
    longFrames100: gaps.filter((g) => g > 100).length
  })

  // ANSI torrent chunk: 8 colored full-width lines -> forces scrolling in every pane.
  const chunk = (id, t) => {
    let s = ''
    for (let l = 0; l < 8; l++) {
      s += ESC + '[3' + ((l % 7) + 1) + 'mp' + id + ' t' + t + ' ' + 'x'.repeat(96) + ESC + '[0m\\r\\n'
    }
    return s
  }

  // End-to-end attention: run a node one-liner IN panes 13..16 that emits OSC 9 onto the PTY
  // (daemon parses -> state relay -> badge). Sent right as the stress window opens.
  // The dot is gated on a tracked provider session (availability contract) — adopt one
  // per pane first, exactly what a launcher launch would have registered.
  for (const p of panes) m.agents.adopt(p.id, 'claude', '')
  const osc9 = 'node -e "process.stdout.write(String.fromCharCode(27)+' + "']9;milestone'" + '+String.fromCharCode(7))"' + CR
  const flip = [13, 14, 15, 16]

  const STRESS_MS = 4000
  let ticks = 0
  const writer = setInterval(() => {
    ticks++
    for (const p of panes) p.term.write(chunk(p.id, ticks))
  }, 50)
  for (const id of flip) window.bridge.send('terminal:write', { id: id, data: osc9 })
  const stressGaps = await sample(STRESS_MS)
  clearInterval(writer)
  const stress = metrics(stressGaps, STRESS_MS)
  const heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1

  // Badges: the 4 flipped panes must ring attention; pane 1 (control) must not.
  const badge = (id) => {
    const el = document.querySelector('.layout-slot[data-pane-id="' + id + '"] .pane-state')
    return el ? el.getAttribute('data-state') : null
  }
  let flipped = []
  for (let i = 0; i < 30; i++) {
    flipped = flip.map(badge)
    if (flipped.every((s) => s === 'attention')) break
    await sleep(500)
  }
  const attention4 = flipped.every((s) => s === 'attention')
  const controlState = badge(1)
  const controlOk = controlState !== 'attention'
  const webglVisible = panes.filter((p) => p.renderer() === 'webgl').length

  // --- Phase B: background attention + GL release ------------------------------------------
  m.workspace.create({ name: 'Watch' }) // ws2 active; the 16-pane grid backgrounds
  await sleep(800)
  const ws1Tab = document.querySelectorAll('.workspace-tab')[0]
  const tabRing = ws1Tab ? ws1Tab.getAttribute('data-attention') : null
  // Hidden panes release their contexts after a deliberate 1.5s quiet window (the
  // perception budget keeps GL warm through rapid flips — docs/07). The ASSERTION is
  // unchanged (all 16 must release); the wait polls instead of assuming the timing.
  let domHidden = 0
  for (let i = 0; i < 20; i++) {
    domHidden = panes.filter((p) => p.renderer() === 'dom').length
    if (domHidden === 16) break
    await sleep(400)
  }

  m.workspace.switchByIndex(0) // back to the grid
  await sleep(1500)
  const ringAfterFocus = ws1Tab ? ws1Tab.getAttribute('data-attention') : null
  // Re-acquire is slower under software GL — POLL for it (the CLAIM is unchanged:
  // panes must get WebGL back; only the wait is robust instead of a fixed beat).
  let webglBack = 0
  for (let i = 0; i < 20; i++) {
    webglBack = panes.filter((p) => p.renderer() === 'webgl').length
    if (webglBack >= B.minWebglVisible) break
    await sleep(500)
  }
  const idleGaps = await sample(1500)
  const idle = metrics(idleGaps, 1500)

  const budgetOk =
    stress.maxGapMs <= B.maxFrameGapMs &&
    stress.avgFps >= B.minAvgFps &&
    (heapMB === -1 || heapMB <= B.maxHeapMB) &&
    idle.maxGapMs <= B.maxFrameGapMs
  const pass =
    panes.length === 16 &&
    budgetOk &&
    attention4 &&
    controlOk &&
    webglVisible >= B.minWebglVisible &&
    tabRing === 'attention' &&
    domHidden === 16 &&
    !ringAfterFocus &&
    webglBack >= B.minWebglVisible

  return {
    pass, budget: B,
    mounted: panes.length, ticks, stress, idle, heapMB,
    attention4, flipped, controlState, webglVisible,
    tabRing, domHidden, ringAfterFocus, webglBack
  }
})()`

export function runMilestoneSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 150000) // safety net (16 PTY spawns + stress + 2 phases)
  // rAF must not be throttled if the window is unfocused/occluded during an automated run —
  // the measurement is of OUR main thread, not the compositor's scheduling.
  win.webContents.setBackgroundThrottling(false)

  const run = async (): Promise<void> => {
    let result: { pass?: boolean } = { pass: false }
    try {
      result = (await win.webContents.executeJavaScript(SCRIPT, true)) as { pass?: boolean }
    } catch (e) {
      result = { pass: false, ...{ error: String(e) } }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'milestone-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result?.pass ? 0 : 1)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
