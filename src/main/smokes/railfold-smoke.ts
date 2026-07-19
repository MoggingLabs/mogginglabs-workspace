import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Env-gated rail fold/unfold smoke (MOGGING_RAILFOLD, 2026-07-18). The rail's width
// TRANSITIONS (--dur-rail) but its collapsed end-state is a discrete re-layout — and
// before the `rail-anim` choreography, that re-layout landed at t=0 of the animation:
// on expand the pane count appeared at full opacity inside a still-narrow rail, painted
// on top of the workspace icon. The contract this gate holds:
//   in flight, the rail clips to its animating edge (`overflow: clip`) and keeps the
//   EXPANDED layout at full width — so every element is revealed/hidden by the fold
//   itself, at its resting position, and the count can never overlap the icon;
//   the collapsed end-state (display:none et al.) lands only after the fold finishes.
// Samples geometry through a collapse and an expand via the real Ctrl+Shift+B path,
// polled from the main process (occlusion-proof — see `snapshot` below).
// Bites: a dropped `rail-anim` stamp (app-shell), a lost
// `:not(.rail-anim)` guard or the clip/min-width in-flight rules (global.css), and
// any regression that lays the count out beside the icon mid-fold.

export function runRailfoldSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 60000)
  const wc = win.webContents
  // The ES poll below is occlusion-proof, but each executeJavaScript round-trip still rides
  // the renderer's task queue — and an unfocused CI window's throttled queue stretches one
  // round-trip past the whole 400ms rail-anim window (the sampler then sees ≤1 in-flight
  // frame and a healthy fold reads widthAnimated:false). Same law as MILESTONE's sampler:
  // the measurement is of OUR choreography, not the compositor's backgrounding policy.
  wc.setBackgroundThrottling(false)
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'railfold-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  type Frame = {
    railW: number
    anim: boolean
    overflowX: string
    countDisplay: string
    icon: [number, number] | null
    count: [number, number] | null
    overlap: boolean
  }

  // Sampled from the MAIN process, not a renderer rAF loop: an occluded window's rAF is
  // throttled to ZERO (the CDP memory's "forced frames" trap), which starved a rAF sampler
  // to an empty frame list. getComputedStyle/getBoundingClientRect resolve the transition's
  // CURRENT value on demand — no painted frame needed — so an ES poll is occlusion-proof.
  const snapshot = (): Promise<Frame> =>
    ES<Frame>(`(() => {
      const appEl = document.getElementById('app')
      const rail = document.getElementById('rail')
      const tab = document.querySelector('.workspace-tab')
      const icon = tab ? tab.querySelector('.ws-icon') : null
      const count = tab ? tab.querySelector('.ws-count') : null
      const ir = icon ? icon.getBoundingClientRect() : null
      const cr = count ? count.getBoundingClientRect() : null
      const cs = count ? getComputedStyle(count) : null
      const shown = !!(cs && cs.display !== 'none')
      return {
        railW: rail.getBoundingClientRect().width,
        anim: appEl.classList.contains('rail-anim'),
        overflowX: getComputedStyle(rail).overflowX,
        countDisplay: cs ? cs.display : 'gone',
        icon: ir ? [ir.left, ir.right] : null,
        count: cr ? [cr.left, cr.right] : null,
        overlap: !!(ir && cr && shown && cr.left < ir.right - 0.5 && cr.right > ir.left + 0.5)
      }
    })()`)
  // ~50 samples at a ≥10ms cadence ≈ 700ms+ — past the 260ms fold, then well into rest.
  const sampleThrough = async (): Promise<Frame[]> => {
    const frames: Frame[] = []
    for (let i = 0; i < 50; i++) {
      frames.push(await snapshot())
      await sleep(10)
    }
    return frames
  }
  const toggle = (): Promise<unknown> =>
    ES(`(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, shiftKey: true })), 1)`)

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      await ES(`window.__mogging.workspace.create({ name: 'Fold', paneCount: 3 })`)
      await sleep(1500)

      const restW = await ES<number>(`document.getElementById('rail').getBoundingClientRect().width`)
      const restCountLeft = await ES<number>(
        `document.querySelector('.workspace-tab .ws-count').getBoundingClientRect().left`
      )

      // ── Collapse: the count must ride the fold out, holding its resting x, never
      // squeezed toward the icon.
      await toggle()
      const foldFrames = await sampleThrough()

      // ── Expand: the reverse — the count is uncovered at its final x, never mid-rail.
      await toggle()
      const unfoldFrames = await sampleThrough()

      const animOf = (fs: Frame[]): Frame[] => fs.filter((f) => f.anim)
      const foldAnim = animOf(foldFrames)
      const unfoldAnim = animOf(unfoldFrames)
      const endOfFold = foldFrames[foldFrames.length - 1]
      const endOfUnfold = unfoldFrames[unfoldFrames.length - 1]

      const widthAnimated =
        foldAnim.length >= 2 &&
        unfoldAnim.length >= 2 &&
        foldAnim[foldAnim.length - 1].railW < foldAnim[0].railW &&
        unfoldAnim[unfoldAnim.length - 1].railW > unfoldAnim[0].railW
      const clippedInFlight = [...foldAnim, ...unfoldAnim].every((f) => f.overflowX === 'clip')
      const neverOverlapped = [...foldFrames, ...unfoldFrames].every((f) => !f.overlap)
      // In flight, a displayed count holds its RESTING x (±2px): revealed/hidden in place,
      // never laid out squeezed beside the icon inside the narrow rail.
      const heldItsPosition = [...foldAnim, ...unfoldAnim].every(
        (f) => f.countDisplay === 'none' || (f.count !== null && Math.abs(f.count[0] - restCountLeft) < 2)
      )
      const foldLandedHidden =
        !endOfFold.anim && endOfFold.countDisplay === 'none' && endOfFold.railW < restW - 100
      const unfoldLandedShown =
        !endOfUnfold.anim &&
        endOfUnfold.countDisplay !== 'none' &&
        Math.abs(endOfUnfold.railW - restW) < 2 &&
        !endOfUnfold.overlap

      const pass =
        widthAnimated && clippedInFlight && neverOverlapped && heldItsPosition &&
        foldLandedHidden && unfoldLandedShown
      result = {
        pass,
        widthAnimated,
        clippedInFlight,
        neverOverlapped,
        heldItsPosition,
        foldLandedHidden,
        unfoldLandedShown,
        restW,
        restCountLeft,
        foldAnimFrames: foldAnim,
        unfoldAnimFrames: unfoldAnim,
        endOfFold,
        endOfUnfold
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    emit(result)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 2500))
  else setTimeout(() => void run(), 2500)
}
