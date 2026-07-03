import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { softGapMs } from './smoke-shell'

// Env-gated terminal-artifact smoke (MOGGING_FLICKER): prove that rapid view churn —
// the exact moments where flicker/cross-pane artifacts would appear — stays clean.
//
//  1. 8 live panes, each stamped with a DISTINCT marker.
//  2. CHURN: 16 rapid workspace switches (show/hide + WebGL release/re-acquire per
//     pane, the heaviest chrome transition) while streaming output into panes, with
//     rAF gaps sampled the whole time.
//  3. ZOOM CHURN: 6 rapid zoom/restore toggles of the focused pane (grid-area swap +
//     sibling hide/show), sampled the same way.
//  4. Assert afterwards: every pane kept ONLY its own content (no cross-talk, no
//     buffer loss), all 8 visible panes re-acquired WebGL, the frame budget held
//     (worst gap ≤ 150ms — a dropped-frame stutter fails), and the renderer logged
//     zero errors and never crashed.
// PERCEPTION-anchored (docs/07): a >100 ms frame is a humanly visible hitch — the gate
// is what a person can notice, not what the machine can survive (that's docs/05).
const BUDGET = { maxFrameGapMs: softGapMs(100) } // CI soft mode relaxes gaps only, loudly

const SCRIPT = `(async () => {
  const B = ${JSON.stringify(BUDGET)}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const CR = String.fromCharCode(13)
  const m = window.__mogging
  if (!m || !m.workspace || !m.layout) return { pass: false, error: 'no dev handles' }

  // Frame sampler: collects rAF gaps until told to stop.
  const startSampler = () => {
    const gaps = []
    let last = performance.now()
    let on = true
    const tick = (now) => {
      gaps.push(now - last)
      last = now
      if (on) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return {
      stop() {
        on = false
        return {
          frames: gaps.length,
          maxGapMs: Math.round(Math.max.apply(null, gaps) * 10) / 10,
          longFrames100: gaps.filter((g) => g > 100).length
        }
      }
    }
  }

  // --- Setup: 8 stamped panes in ws1, plus a second workspace to churn against ----
  if (m.workspace.count() === 0) m.workspace.create({ name: 'Grid' })
  await sleep(600)
  m.layout.apply(8)
  for (let i = 0; i < 100 && (m.panes || []).length < 8; i++) await sleep(200)
  const panes = (m.panes || []).slice(0, 8)
  if (panes.length < 8) return { pass: false, error: 'expected 8 panes, got ' + panes.length }
  await sleep(2200) // shells reach prompts
  for (const p of panes) p.write('echo FLICK_' + p.id + '_END' + CR)
  await sleep(1600)
  const baseLines = panes.map((p) => p.bufferLines())
  m.workspace.create({ name: 'Churn' })
  await sleep(900)

  // --- Phase 1: rapid workspace switching under load ------------------------------
  const s1 = startSampler()
  const writer = setInterval(() => {
    panes[0].write('tick ' + Date.now() + CR)
    panes[7].write('tick ' + Date.now() + CR)
  }, 150)
  for (let i = 0; i < 16; i++) {
    m.workspace.switchByIndex(i % 2)
    await sleep(300)
  }
  clearInterval(writer)
  m.workspace.switchByIndex(0)
  await sleep(1500) // WebGL re-acquire settles
  const churn = s1.stop()

  // --- Phase 2: zoom churn on the focused pane ------------------------------------
  const s2 = startSampler()
  for (let i = 0; i < 6; i++) {
    m.layout.zoom()
    await sleep(280)
  }
  await sleep(1200) // even toggle count -> grid restored; GL re-acquires
  const zoom = s2.stop()

  // --- Assertions ------------------------------------------------------------------
  const ids = panes.map((p) => p.id)
  const results = panes.map((p, i) => {
    const txt = p.text()
    return {
      id: p.id,
      hasOwn: txt.indexOf('FLICK_' + p.id + '_END') >= 0,
      foreign: ids.filter((o) => o !== p.id && txt.indexOf('FLICK_' + o + '_END') >= 0),
      renderer: p.renderer(),
      bufferKept: p.bufferLines() >= baseLines[i]
    }
  })
  const contentIntact = results.every((r) => r.hasOwn && r.foreign.length === 0)
  const buffersKept = results.every((r) => r.bufferKept)
  const webglBack = results.filter((r) => r.renderer === 'webgl').length
  const smooth = churn.maxGapMs <= B.maxFrameGapMs && zoom.maxGapMs <= B.maxFrameGapMs

  const pass = contentIntact && buffersKept && webglBack === 8 && smooth
  return { pass, churn, zoom, webglBack, contentIntact, buffersKept, results }
})()`

export function runFlickerSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 120000) // safety net
  const wc = win.webContents
  wc.setBackgroundThrottling(false) // measure OUR frames, not the compositor's scheduling

  // Any renderer error or crash during churn = an artifact — collected and gating.
  const errors: string[] = []
  wc.on('console-message', (...args: unknown[]) => {
    const a1 = args[1] as { level?: unknown; message?: unknown } | number | string
    const level = a1 && typeof a1 === 'object' ? a1.level : a1
    const message = a1 && typeof a1 === 'object' ? String(a1.message ?? '') : String(args[2] ?? '')
    if (level === 3 || level === 'error') errors.push('console.error: ' + message)
  })
  wc.on('render-process-gone', (_e, details) => errors.push('render-process-gone: ' + details.reason))

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      result = (await wc.executeJavaScript(SCRIPT, true)) as Record<string, unknown>
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    result.rendererErrors = errors
    if (errors.length) result.pass = false
    try {
      writeFileSync(join(process.cwd(), 'out', 'flicker-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
