import { app, type BrowserWindow, type Rectangle } from 'electron'
import { createHash } from 'node:crypto'
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
//  3b. DWELL EXPAND/RESTORE: expand one pane over the workspace, DWELL past the 1.5s
//     WebGL release debounce, restore — the reported all-terminals-flicker case, which
//     the 280ms churn above is structurally blind to (it never lets a release land).
//     Assert covered siblings hide via VISIBILITY (box kept), keep their WebGL leases
//     through the dwell, report webgl again within two frames of the restore (restore
//     is pure paint — no cold reattach ripple), take ZERO PTY resizes across the whole
//     cycle, and one sibling's pixels after restore hash byte-identical to before the
//     expand (main-process captures). Frame budget sampled across the restore.
//  3c. …and the budget path SURVIVES the fix: under budget a hidden WORKSPACE keeps its
//     leases warm (the switch-flicker fix); with the budget forced to 0 it still
//     releases all 8 contexts (poll) and re-acquires on switch-back — pinned so nobody
//     "fixes" flicker by disabling the leasing outright (MILESTONE phase B's claim).
//  4. Assert afterwards: every pane kept ONLY its own content (no cross-talk, no
//     buffer loss), all 8 visible panes re-acquired WebGL, the frame budget held
//     (worst gap ≤ 100ms — a dropped-frame stutter fails), and the renderer logged
//     zero errors and never crashed.
//  5. Feed a Codex-style synchronized frame in split writes and assert xterm holds
//     every render until ESU. This is the cursor/icon flicker regression: Codex wraps
//     its ratatui draws in DEC mode 2026, so an embedder that ignores it exposes the
//     intermediate erase/cursor/glyph passes as visible tearing.
// PERCEPTION-anchored (docs/07): a >100 ms frame is a humanly visible hitch — the gate
// is what a person can notice, not what the machine can survive (that's docs/05).
// CI soft mode relaxes gaps only, loudly. Factor 6 here (vs the default 4): the
// churn phase re-creates WebGL contexts, and SwiftShader context churn spikes
// past 400ms (measured 416.7ms on the 2026-07 ubuntu image — run 28640874102).
const BUDGET = { maxFrameGapMs: softGapMs(100, 6) }

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
  const oneFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
  const twoFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

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
  // The buffer-survival baseline is CONTENT, not line count: reflow (a pane
  // remeasured wider merges wrapped lines — long runner hostnames wrap zsh
  // prompts in narrow grid panes) legally shrinks the line count with zero
  // loss. Found by the macOS CI sweep: 6/8 idle panes "lost" lines while
  // every marker survived (run 28657760100).
  const baseTexts = panes.map((p) => p.text().replace(/\\s+/g, ''))
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

  // --- Phase 2b: DWELL expand/restore — the reported flicker, as a contract --------
  // The 280ms churn above never lets the 1.5s WebGL release debounce land, so it is
  // structurally blind to the real gesture: expand a pane, WORK in it, restore. Before
  // the fix, covered siblings were display:none — their IntersectionObservers read
  // "gone", their contexts released mid-dwell, and the restore re-acquired seven of
  // them one per frame: a per-pane DOM→WebGL rasterizer swap the user saw as every
  // terminal in the workspace flickering. The fix hides covered siblings via
  // VISIBILITY (box kept, IO quiet, lease kept), so restore is pure paint. Each
  // assertion below is one clause of that contract, and each one bites alone:
  //   siblingsCoveredRight  — hidden by visibility, NOT display (the mechanism itself)
  //   leasesKeptThroughDwell— all 8 still webgl AFTER a 2.4s covered dwell
  //   restoreInstantWebgl   — all 8 webgl within TWO FRAMES of restore (nothing to redo)
  //   noSiblingResizes      — zero PTY resizes on siblings (no ConPTY repaint storm)
  //   dwellPixels (main)    — a sibling's pixels after restore hash identical to before
  const dwellFocusedEl = document.querySelector('.layout-slot.focused')
  const dwellFocusedId = Number(dwellFocusedEl ? dwellFocusedEl.dataset.paneId : panes[0].id)
  const dwellSibling = panes.find((p) => p.id !== dwellFocusedId) ?? panes[1]
  const dwellResizes = {}
  const dwellSubs = panes.map((p) =>
    p.term.onResize(() => { dwellResizes[p.id] = (dwellResizes[p.id] || 0) + 1 })
  )
  const sibScreen = document.querySelector(
    '.layout-slot[data-pane-id="' + dwellSibling.id + '"] .xterm-screen'
  )
  const sibRect = sibScreen ? sibScreen.getBoundingClientRect() : null
  const dwellBridge = window.__moggingFlickerSync = {
    stage: 'dwell-before',
    stageAt: performance.now(),
    advance: 0,
    clip: sibRect ? {
      x: Math.floor(sibRect.left),
      y: Math.floor(sibRect.top),
      width: Math.max(1, Math.ceil(sibRect.right) - Math.floor(sibRect.left)),
      height: Math.max(1, Math.ceil(sibRect.bottom) - Math.floor(sibRect.top))
    } : null
  }
  const waitDwell = async (advance) => {
    for (let i = 0; i < 1000 && dwellBridge.advance < advance; i++) await sleep(10)
    if (dwellBridge.advance < advance) throw new Error('pixel capture timed out at ' + dwellBridge.stage)
  }
  await waitDwell(1) // main hashed the sibling's screen BEFORE the expand
  m.layout.zoom() // expand the focused pane over the whole workspace
  await sleep(300)
  const coveredDuring = panes.filter((p) => p.id !== dwellFocusedId).map((p) => {
    const el = document.querySelector('.layout-slot[data-pane-id="' + p.id + '"]')
    const cs = el ? getComputedStyle(el) : null
    return { id: p.id, hidden: !!cs && cs.visibility === 'hidden', displayNone: !!cs && cs.display === 'none' }
  })
  await sleep(2100) // total dwell ≈2.4s — past the 1.5s release debounce + the job queue
  const duringRenderers = panes.map((p) => ({ id: p.id, renderer: p.renderer() }))
  const s3 = startSampler()
  m.layout.zoom() // restore the grid
  await twoFrames()
  const afterRenderers = panes.map((p) => ({ id: p.id, renderer: p.renderer() }))
  await sleep(600) // sampler covers the restore's settle, and no capture runs inside it
  const dwellRestore = s3.stop()
  dwellBridge.stage = 'dwell-after'
  dwellBridge.stageAt = performance.now()
  await waitDwell(2) // main hashed the SAME sibling rect after the restore
  dwellSubs.forEach((s) => s.dispose())
  const siblingIds = panes.filter((p) => p.id !== dwellFocusedId).map((p) => p.id)
  const dwellSiblingResizes = siblingIds.map((id) => dwellResizes[id] || 0)
  const dwellExpandedResizes = dwellResizes[dwellFocusedId] || 0
  const dwell = {
    siblingsCoveredRight: coveredDuring.every((c) => c.hidden && !c.displayNone),
    leasesKeptThroughDwell: duringRenderers.every((r) => r.renderer === 'webgl'),
    restoreInstantWebgl: afterRenderers.every((r) => r.renderer === 'webgl'),
    noSiblingResizes: dwellSiblingResizes.every((n) => n === 0),
    // It DID resize both ways (grow + shrink; the trailing settle fit may add no-ops).
    expandedResized: dwellExpandedResizes >= 2 && dwellExpandedResizes <= 4,
    smooth: dwellRestore.maxGapMs <= B.maxFrameGapMs,
    expandedResizes: dwellExpandedResizes,
    siblingResizes: dwellSiblingResizes,
    siblingId: dwellSibling.id,
    coveredDuring, duringRenderers, afterRenderers,
    restore: dwellRestore
  }
  dwell.pass =
    dwell.siblingsCoveredRight && dwell.leasesKeptThroughDwell && dwell.restoreInstantWebgl &&
    dwell.noSiblingResizes && dwell.expandedResized && dwell.smooth

  // --- Phase 2c: the context budget must SURVIVE the fix ---------------------------
  // The budget is now PRESSURE-DRIVEN (the workspace-switch flicker fix): a hidden
  // workspace keeps its contexts WARM while the app-wide count fits the browser cap, so
  // switching back is pure show/hide — no per-pane DOM→WebGL swap wave. Two pins here:
  //  (a) under budget, a dwell past the release debounce keeps every hidden lease;
  //  (b) with the budget forced to 0 (dev override), a hidden workspace still releases
  //      all 8 contexts and re-acquires on switch-back — nobody may "fix" flicker by
  //      deleting the managed leasing outright (MILESTONE phase B's claim).
  m.workspace.switchByIndex(1)
  await sleep(2400) // past the 1.5s release debounce + the job queue
  const warmKept = panes.filter((p) => p.renderer() === 'webgl').length
  window.__moggingGlBudget = 0
  // Re-trip the hide path under pressure: flip back and away so onHide re-arms the
  // (already-spent) release debounce for every pane.
  m.workspace.switchByIndex(0)
  await sleep(300)
  m.workspace.switchByIndex(1)
  let wsReleased = 0
  for (let i = 0; i < 25; i++) {
    wsReleased = panes.filter((p) => p.renderer() === 'dom').length
    if (wsReleased === 8) break
    await sleep(400)
  }
  delete window.__moggingGlBudget
  m.workspace.switchByIndex(0)
  let wsBack = 0
  for (let i = 0; i < 25; i++) {
    wsBack = panes.filter((p) => p.renderer() === 'webgl').length
    if (wsBack === 8) break
    await sleep(500)
  }
  const wsLeasing = {
    pass: warmKept === 8 && wsReleased === 8 && wsBack === 8,
    warmKept,
    released: wsReleased,
    reacquired: wsBack
  }

  // --- Assertions ------------------------------------------------------------------
  const ids = panes.map((p) => p.id)
  const results = panes.map((p, i) => {
    const txt = p.text()
    return {
      id: p.id,
      hasOwn: txt.indexOf('FLICK_' + p.id + '_END') >= 0,
      foreign: ids.filter((o) => o !== p.id && txt.indexOf('FLICK_' + o + '_END') >= 0),
      renderer: p.renderer(),
      // Truncation loses characters; reflow only moves line breaks. The claim
      // ("no buffer loss") is about characters. Line counts stay as diagnostics.
      bufferKept: txt.replace(/\\s+/g, '').indexOf(baseTexts[i]) >= 0,
      lines: [baseLines[i], p.bufferLines()]
    }
  })
  const contentIntact = results.every((r) => r.hasOwn && r.foreign.length === 0)
  const buffersKept = results.every((r) => r.bufferKept)
  const webglBack = results.filter((r) => r.renderer === 'webgl').length
  const smooth = churn.maxGapMs <= B.maxFrameGapMs && zoom.maxGapMs <= B.maxFrameGapMs

  // --- Phase 3: Codex synchronized-output atomicity -------------------------------
  // Codex sends BSU + a frame + ESU as separate PTY chunks in practice. Exercise the
  // literal reported case: a focused pane, its normal blinking cursor visible, and
  // cursor + icon/glyph changes inside the frame. Public Terminal.onRender omits
  // redraw-only cursor paints, so this DEV gate also listens at xterm's internal
  // render-service seam and hands three compositor checkpoints to the main process.
  const syncPane = panes.find((p) => p.term.textarea === document.activeElement) ?? panes[0]
  const syncTerm = syncPane.term
  const writeTerm = (data) => new Promise((resolve) => syncTerm.write(data, resolve))
  const syncSlot = document.querySelector('.layout-slot[data-pane-id="' + syncPane.id + '"]')
  syncSlot?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  syncTerm.focus()
  syncTerm.options.cursorBlink = true // guarantee the same renderer path as a focused working pane
  await oneFrame()
  const focusedElement = document.activeElement === syncTerm.textarea
  const blinkingCursor = syncTerm.options.cursorBlink === true
  const focusedCursor = focusedElement && blinkingCursor
  await writeTerm('\x1b[?1049h\x1b[?25h\x1b[2J\x1b[H\x1b[34m◆ SYNC_BASELINE ›\x1b[0m\x1b[2;3H')
  await twoFrames()
  await sleep(150) // drain the last ordinary render before counting this pane's events
  const blinkManager = syncTerm._core?._renderService?._renderer?.value?._cursorBlinkStateManager?.value
  // Keep the real blinking-cursor manager installed and exercise its resume/redraw
  // path inside BSU, but pin it visible while each screenshot is taken. Otherwise a
  // legitimate 600ms blink between captures makes an exact-pixel atomicity check flaky.
  blinkManager?.pause()
  const cursorPinnedAtBaseline = blinkManager?.isPaused === true && blinkManager?.isCursorVisible === true
  const publicRenderEvents = []
  const actualRenderEvents = []
  const scrollEvents = []
  const publicRenderSub = syncTerm.onRender((e) => publicRenderEvents.push({ start: e.start, end: e.end }))
  const actualRenderSub = syncTerm._core?._renderService?.onRender?.((e) => actualRenderEvents.push({ start: e.start, end: e.end }))
  const scrollSub = syncTerm.onScroll((y) => scrollEvents.push(y))
  const viewportBefore = {
    baseY: syncTerm.buffer.active.baseY,
    viewportY: syncTerm.buffer.active.viewportY
  }
  const screenRect = syncTerm.element?.querySelector('.xterm-screen')?.getBoundingClientRect()
  const bridge = window.__moggingFlickerSync = {
    stage: 'baseline',
    stageAt: performance.now(),
    advance: 0,
    clip: screenRect ? {
      x: Math.floor(screenRect.left),
      y: Math.floor(screenRect.top),
      width: Math.max(1, Math.ceil(screenRect.right) - Math.floor(screenRect.left)),
      height: Math.max(1, Math.ceil(screenRect.bottom) - Math.floor(screenRect.top))
    } : null
  }
  const waitForCapture = async (advance) => {
    for (let i = 0; i < 1000 && bridge.advance < advance; i++) await sleep(10)
    if (bridge.advance < advance) throw new Error('pixel capture timed out at ' + bridge.stage)
  }
  await waitForCapture(1)
  blinkManager?.resume()
  const before = { actual: actualRenderEvents.length, public: publicRenderEvents.length }
  await writeTerm('\x1b[?20') // deliberately split the CSI at an IPC-style chunk boundary
  await writeTerm('26h')
  const heldStart = { actual: actualRenderEvents.length, public: publicRenderEvents.length }
  const activeAtStart = syncTerm.modes.synchronizedOutputMode === true
  await writeTerm('\x1b[2J\x1b[H')
  await writeTerm('\x1b[31m◇ SYNC_FRAME_PENDING •\x1b[0m\x1b[3;11H')
  // One paint opportunity is enough to expose an intermediate frame and stays well
  // inside xterm's 1s synchronized-output safety timeout, even on software renderers.
  await oneFrame()
  blinkManager?.pause()
  const cursorPinnedDuring = blinkManager?.isPaused === true && blinkManager?.isCursorVisible === true
  const viewportDuring = {
    baseY: syncTerm.buffer.active.baseY,
    viewportY: syncTerm.buffer.active.viewportY
  }
  bridge.stage = 'during'
  bridge.stageAt = performance.now()
  await waitForCapture(2)
  const during = { actual: actualRenderEvents.length, public: publicRenderEvents.length }
  const activeDuring = syncTerm.modes.synchronizedOutputMode === true
  await writeTerm('\x1b[?2026l')
  await twoFrames()
  const after = { actual: actualRenderEvents.length, public: publicRenderEvents.length }
  const inactiveAfter = syncTerm.modes.synchronizedOutputMode === false
  bridge.stage = 'after'
  bridge.stageAt = performance.now()
  await waitForCapture(3)
  blinkManager?.resume()
  publicRenderSub.dispose()
  actualRenderSub?.dispose()
  scrollSub.dispose()
  await writeTerm('\x1b[?25h\x1b[?1049l') // restore the shell buffer after the isolated probe
  bridge.stage = 'done'
  delete window.__moggingFlickerSync
  const viewportStable =
    viewportDuring.baseY === viewportBefore.baseY &&
    viewportDuring.viewportY === viewportBefore.viewportY &&
    scrollEvents.length === 0
  const synchronizedOutput = {
    pass:
      focusedCursor &&
      cursorPinnedAtBaseline &&
      cursorPinnedDuring &&
      !!actualRenderSub &&
      activeAtStart &&
      activeDuring &&
      inactiveAfter &&
      during.actual === heldStart.actual &&
      during.public === heldStart.public &&
      after.actual > during.actual &&
      after.public > during.public &&
      viewportStable,
    focusedCursor,
    focusedElement,
    blinkingCursor,
    hasBlinkManager: !!blinkManager,
    cursorPinnedAtBaseline,
    cursorPinnedDuring,
    hasActualRenderProbe: !!actualRenderSub,
    activeAtStart,
    activeDuring,
    inactiveAfter,
    viewportStable,
    viewport: { before: viewportBefore, during: viewportDuring, scrollEvents },
    renderEvents: {
      before,
      heldStart,
      during,
      after,
      actualRanges: actualRenderEvents,
      publicRanges: publicRenderEvents
    }
  }

  // xterm 6 replaced its viewport scrollbar implementation. The app owns a custom
  // pane slider, so prove the new native overlay is hidden, its own UI stays atomic
  // while normal-buffer scroll events escape BSU, and the public viewport model still
  // drives the control after ESU.
  const scrollPane = panes[7].id === syncPane.id ? panes[0] : panes[7]
  const scrollTerm = scrollPane.term
  const writeScroll = (data) => new Promise((resolve) => scrollTerm.write(data, resolve))
  const scrollSlot = document.querySelector('.layout-slot[data-pane-id="' + scrollPane.id + '"]')
  const slider = scrollSlot?.querySelector('.pane-slider')
  const thumb = scrollSlot?.querySelector('.pane-slider-thumb')
  const jump = scrollSlot?.querySelector('.pane-jump')
  const nativeBars = [...(scrollSlot?.querySelectorAll('.xterm-scrollable-element > .scrollbar') ?? [])]
  const sliderUi = () => ({
    idle: slider?.classList.contains('is-idle') ?? null,
    jumpHidden: jump?.hidden ?? null,
    thumbHeight: thumb?.style.height ?? null,
    thumbTransform: thumb?.style.transform ?? null
  })
  // Park the viewport up in history AS A HUMAN WOULD. The pane now follows its newest
  // output and only a human may leave the bottom (pane-anchor.ts): a bare scrollToLine is
  // a stray, non-user scroll, and the anchor correctly undoes it — which would leave this
  // check parked at the bottom with a thumb that has nowhere to move. So it does what the
  // user it stands for does: a wheel, and then the scroll that wheel is worth. The wheel
  // event is what the anchor reads; the delta does not matter, only that a hand is on it.
  const scrollBody = scrollSlot?.querySelector('.pane-body')
  const asUser = (scroll) => {
    scrollBody?.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
    scroll()
  }
  asUser(() => scrollTerm.scrollToLine(Math.floor(scrollTerm.buffer.active.baseY / 2)))
  await twoFrames()
  const deferredBefore = {
    baseY: scrollTerm.buffer.active.baseY,
    viewportY: scrollTerm.buffer.active.viewportY,
    ui: sliderUi()
  }
  const deferredScrollEvents = []
  const deferredScrollSub = scrollTerm.onScroll((y) => deferredScrollEvents.push(y))
  await writeScroll('\x1b[?2026h')
  await writeScroll(Array.from({ length: Math.max(40, scrollTerm.rows * 4) }, (_, i) => 'SYNC_SCROLL_' + i + '\\r\\n').join(''))
  await oneFrame()
  const deferredDuring = {
    active: scrollTerm.modes.synchronizedOutputMode === true,
    baseY: scrollTerm.buffer.active.baseY,
    viewportY: scrollTerm.buffer.active.viewportY,
    ui: sliderUi()
  }
  await writeScroll('\x1b[?2026l')
  await twoFrames()
  const deferredAfter = {
    inactive: scrollTerm.modes.synchronizedOutputMode === false,
    baseY: scrollTerm.buffer.active.baseY,
    viewportY: scrollTerm.buffer.active.viewportY,
    ui: sliderUi()
  }
  deferredScrollSub.dispose()
  const sliderDeferred = {
    pass:
      deferredDuring.active &&
      deferredAfter.inactive &&
      deferredDuring.baseY > deferredBefore.baseY &&
      deferredScrollEvents.length > 0 &&
      JSON.stringify(deferredDuring.ui) === JSON.stringify(deferredBefore.ui) &&
      JSON.stringify(deferredAfter.ui) !== JSON.stringify(deferredDuring.ui),
    scrollEvents: deferredScrollEvents.length,
    before: deferredBefore,
    during: deferredDuring,
    after: deferredAfter
  }
  await twoFrames()
  const hasScrollback = scrollTerm.buffer.active.baseY > 0
  const sliderActive = !!slider && !slider.classList.contains('is-idle')
  const nativeHidden = nativeBars.length > 0 && nativeBars.every((el) => getComputedStyle(el).display === 'none')
  asUser(() => scrollTerm.scrollToTop()) // a human going back through the conversation
  await twoFrames()
  const scrolled = scrollTerm.buffer.active.viewportY < scrollTerm.buffer.active.baseY
  const jumpShown = !!jump && !jump.hidden
  jump?.click()
  await twoFrames()
  const returned = scrollTerm.buffer.active.viewportY === scrollTerm.buffer.active.baseY
  const jumpHidden = !!jump && jump.hidden
  const scrollbar = {
    pass: sliderDeferred.pass && hasScrollback && sliderActive && nativeHidden && scrolled && jumpShown && returned && jumpHidden,
    sliderDeferred,
    hasScrollback,
    sliderActive,
    nativeHidden,
    nativeScrollbarCount: nativeBars.length,
    scrolled,
    jumpShown,
    returned,
    jumpHidden
  }

  const pass = contentIntact && buffersKept && webglBack === 8 && smooth &&
    dwell.pass && wsLeasing.pass && synchronizedOutput.pass && scrollbar.pass
  return { pass, churn, zoom, dwell, wsLeasing, synchronizedOutput, scrollbar, webglBack, contentIntact, buffersKept, results }
})()`

export function runFlickerSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 180000) // safety net (the dwell + leasing phases added ~15s typical, more under software GL)
  // Eight panes at the authored dev-window size. On the 1024-wide CI display the clamped
  // window leaves each pane a handful of rows, and the buffers-kept character check fails
  // on geometry rather than on the reflow behavior it exists to hold. (chromeux precedent:
  // programmatic resize beyond the physical display works on every runner.)
  win.setSize(1200, 800)
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
    let scriptSettled = false
    const scriptResult = wc.executeJavaScript(SCRIPT, true).then(
      (value) => ({ value: value as Record<string, unknown> }),
      (error) => ({ error })
    ).finally(() => {
      scriptSettled = true
    })

    type BridgeState = {
      stage: string
      stageAgeMs: number
      clip: Rectangle | null
    }
    const readBridge = async (): Promise<BridgeState | null> =>
      (await wc.executeJavaScript(`(() => {
        const b = window.__moggingFlickerSync
        return b ? {
          stage: b.stage,
          stageAgeMs: performance.now() - b.stageAt,
          clip: b.clip
        } : null
      })()`, true)) as BridgeState | null
    const waitForStage = async (stage: string): Promise<BridgeState> => {
      // 90s: the FIRST capture (dwell-before) is reached only after setup + both churn
      // phases, which a software-GL CI runner can stretch well past a minute.
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const state = await readBridge()
        if (state?.stage === stage) return state
        if (scriptSettled) throw new Error(`renderer script ended before ${stage} capture`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`timed out waiting for ${stage} capture`)
    }
    const advance = async (value: number): Promise<void> => {
      await wc.executeJavaScript(
        `(() => { const b = window.__moggingFlickerSync; if (b) b.advance = ${value} })()`,
        true
      )
    }
    const capture = async (stage: string, next: number): Promise<{ hash: string; stageAgeMs: number }> => {
      const state = await waitForStage(stage)
      if (!state.clip) throw new Error(`${stage} capture has no terminal clip`)
      // xterm's synchronized-output safety valve flushes after 1s. Bound the only
      // capture made while BSU is active well below that deadline, so a stalled
      // compositor is diagnosed instead of silently turning into an intermediate frame.
      const image = stage === 'during'
        ? await new Promise<Awaited<ReturnType<typeof wc.capturePage>>>((resolve, reject) => {
            const remaining = Math.max(0, 700 - state.stageAgeMs)
            if (remaining === 0) {
              reject(new Error('during capture missed the 700ms synchronized-output deadline'))
              return
            }
            const timer = setTimeout(
              () => reject(new Error('during capture exceeded the 700ms synchronized-output deadline')),
              remaining
            )
            void wc.capturePage(state.clip!).then(
              (captured) => {
                clearTimeout(timer)
                resolve(captured)
              },
              (error) => {
                clearTimeout(timer)
                reject(error)
              }
            )
          })
        : await wc.capturePage(state.clip)
      if (image.isEmpty()) throw new Error(`${stage} capture is empty`)
      const hash = createHash('sha256').update(image.toBitmap()).digest('hex')
      const capturedState = await readBridge()
      try {
        writeFileSync(join(process.cwd(), 'out', `flicker-sync-${stage}.png`), image.toPNG())
      } catch {
        /* diagnostic only */
      }
      await advance(next)
      return { hash, stageAgeMs: capturedState?.stageAgeMs ?? state.stageAgeMs }
    }

    // Phase 2b's pixel clause: hash one covered sibling's screen before the expand and
    // after the restore — equal means the restore left the pane EXACTLY as it was (no
    // buffer loss, no blank canvas, no renderer-swap residue). The content is static by
    // construction (the tick writer stopped in phase 1; the sibling is unfocused, so no
    // blinking cursor), and both captures run OUTSIDE the frame sampler's window.
    let dwellPixels: Record<string, unknown>
    try {
      const before = await capture('dwell-before', 1)
      const after = await capture('dwell-after', 2)
      dwellPixels = {
        pass: before.hash === after.hash,
        hashes: { before: before.hash, after: after.hash },
        stageAgeMs: {
          before: Math.round(before.stageAgeMs * 10) / 10,
          after: Math.round(after.stageAgeMs * 10) / 10
        }
      }
    } catch (e) {
      dwellPixels = { pass: false, error: String(e) }
      try {
        await advance(999) // unblock the renderer script, whatever stage it is parked at
      } catch {
        /* the renderer may already be gone */
      }
    }

    let pixelAtomicity: Record<string, unknown>
    try {
      const baseline = await capture('baseline', 1)
      const during = await capture('during', 2)
      const after = await capture('after', 3)
      pixelAtomicity = {
        pass: baseline.hash === during.hash && after.hash !== during.hash,
        baselineEqualsDuring: baseline.hash === during.hash,
        afterDiffers: after.hash !== during.hash,
        hashes: { baseline: baseline.hash, during: during.hash, after: after.hash },
        stageAgeMs: {
          baseline: Math.round(baseline.stageAgeMs * 10) / 10,
          during: Math.round(during.stageAgeMs * 10) / 10,
          after: Math.round(after.stageAgeMs * 10) / 10
        }
      }
    } catch (e) {
      pixelAtomicity = { pass: false, error: String(e) }
      try {
        await advance(999)
      } catch {
        /* the renderer may already be gone */
      }
    }

    const outcome = await scriptResult
    if ('error' in outcome) {
      result = { pass: false, error: String(outcome.error) }
    } else {
      result = outcome.value
    }
    result.pixelAtomicity = pixelAtomicity
    if (pixelAtomicity.pass !== true) result.pass = false
    result.dwellPixels = dwellPixels
    if (dwellPixels.pass !== true) result.pass = false
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
