import type { Terminal } from '@xterm/xterm'
import { deviceFloorsCells } from '../../core/system/renderer-profile-port'
import { terminalFontsReady } from '../../core/terminal/font-port'

/**
 * The pane's grid derivation — the house replacement for @xterm/addon-fit, retired for
 * the same reason (and in the same spirit) as the native scrollbar it assumed:
 *
 * FitAddon reserves scrollbar width whenever `scrollback !== 0` — hardcoded to
 * `options.overviewRuler?.width || 14` — and there is NO public knob to say "this
 * terminal has no scrollbar" (setting overviewRuler would *activate* a ruler). This app
 * retired xterm's scrollbar wholesale (global.css display:none + the `_onDidScroll`
 * no-op in TerminalPane.retireXtermScrollbar; pane-scrollbar.ts is the single scroll
 * affordance, living in .pane-body's right padding — space the layout already pays).
 * So every pane's grid was computed against a phantom 14px lane: a permanent dead strip
 * at the right edge, on top of the normal sub-cell flooring remainder — the reported
 * "terminal stops a little before the pane's edge".
 *
 * The derivation is otherwise exactly FitAddon's, including its private seam into
 * `_renderService.dimensions`. Guarded like retireXtermScrollbar: if xterm moves the
 * seam, propose() returns null and the pane keeps its grid — degraded, never broken.
 *
 * WHAT A PROPOSAL IS. A proposal is a PUBLISHED measurement: it becomes a pty's size and
 * therefore an agent's render width, and on an app restart it is applied to a session
 * that is already running. So it may only exist when its inputs are FINAL, and this
 * module owns both conditions because there is no other honest place to put them:
 *
 *   FONT — xterm measures its cell at term.open(), against whatever face is resolved in
 *   that instant. Before the terminal faces activate that is a system fallback, and the
 *   grid derived from it is wrong in BOTH axes (measured on a real pane: 71x24 proposed
 *   where the truth was 68x18). xterm exposes no readiness signal — the seam returns a
 *   number as soon as anything has been measured at all — so the gate is terminalFontsReady().
 *
 *   RENDERER — the two renderers disagree about cell width, so the same pane proposed two
 *   different grids depending on which was attached, and every swap put a resize on the
 *   wire. publishableCell() collapses them instead of racing the attach.
 *
 * Both gates live INSIDE proposeGrid rather than at its call sites: one definition of
 * "this pane has a publishable grid", which a fifth caller cannot forget.
 */

/** Grid floors, matching FitAddon's (and attachDims' on the daemon side): below this a
 *  grid is not a terminal, and node-pty throws on non-positive sizes. */
export const MIN_COLS = 2
export const MIN_ROWS = 1

/** The pure math: how many whole cells fit the content box. Null when the box or the
 *  cell is unmeasurable (hidden pane: display:none reports zero cells). */
export function gridFor(
  availableWidth: number,
  availableHeight: number,
  cellWidth: number,
  cellHeight: number
): { cols: number; rows: number } | null {
  if (!(cellWidth > 0) || !(cellHeight > 0)) return null
  if (!Number.isFinite(availableWidth) || !Number.isFinite(availableHeight)) return null
  return {
    cols: Math.max(MIN_COLS, Math.floor(availableWidth / cellWidth)),
    rows: Math.max(MIN_ROWS, Math.floor(availableHeight / cellHeight))
  }
}

interface RendererCell {
  width: number
  height: number
}

/** The active renderer's DEVICE cell size — FitAddon's own seam, kept private-API-guarded.
 *
 *  `device`, not `css`, and the difference is load-bearing for publishableCell below: the
 *  DOM renderer derives its css.cell as `round(deviceCell * cols / dpr) / cols`, a residue
 *  that depends on the CURRENT column count, so flooring it can disagree with the WebGL
 *  cell by one device pixel at a knife edge. The device cells carry no such residue —
 *  WebGL's is already an integer and the DOM's is the raw product — so they collapse
 *  exactly. */
function deviceCell(term: Terminal): RendererCell | null {
  const core = (
    term as unknown as { _core?: { _renderService?: { dimensions?: { device?: { cell?: RendererCell } } } } }
  )._core
  const cell = core?._renderService?.dimensions?.device?.cell
  return cell && typeof cell.width === 'number' && typeof cell.height === 'number' ? cell : null
}

/**
 * The cell a grid may be PUBLISHED at: the renderer-independent one, in CSS pixels.
 *
 * The WebGL renderer floors char width at device pixels and the DOM renderer does not, so
 * until now a pane's proposal changed with whichever renderer happened to be attached — a
 * property that flips on GPU events the user never caused (the context cap, hidden-pane
 * eviction, a driver reset). Flooring the DEVICE cell collapses the two: WebGL's is
 * already floored, so floor is idempotent on it, and the DOM's raw product lands on the
 * same integer. Heights need no help — both renderers already compute the identical
 * `floor(ceil(charH * dpr) * lineHeight)`, so a renderer swap was only ever a cols event.
 *
 * This is what PaneWebglManager's transient-loss suppression (`release(!retrying)`) was
 * hand-tuning around: with the floor, a loss/recover cycle proposes the SAME grid at both
 * ends, applyGrid dedupes it, and the pty sees nothing. The suppression stays — it is
 * still correct — but it is no longer what stands between a GPU blip and a resize thrash.
 *
 * The one machine where flooring is wrong is one that can never paint with WebGL, where
 * the DOM renderer's raw cell IS the truth rather than a transient; renderer-profile-port
 * answers that, once, at boot.
 */
export function publishableCell(cell: RendererCell, dpr: number): RendererCell {
  if (!(dpr > 0)) return cell
  if (!deviceFloorsCells()) return { width: cell.width / dpr, height: cell.height / dpr }
  return { width: Math.floor(cell.width) / dpr, height: Math.floor(cell.height) / dpr }
}

/** Warned once per session: the cell-metrics seam is private API, and its silent failure
 *  mode is the WORST one — every pane frozen at xterm's 80×24 default forever, with no
 *  resize ever sent (the pane "keeps its grid" claim below is only survivable if someone
 *  can see it happened). */
let warnedCellSeam = false

/** Propose the grid for the terminal's current container, or null when unmeasurable
 *  (not yet opened, hidden, or xterm moved its internals). */
export function proposeGrid(term: Terminal): { cols: number; rows: number } | null {
  // FIRST, before anything is measured: a grid measured against a fallback face is not a
  // measurement, and publishing one is how a wrong size reaches a running agent. Null here
  // is a supported, designed state all the way down — spawn omits its dims, attachDims
  // leaves an existing session alone, and the daemon defers a typed launch until a client
  // confirms the grid (LAUNCH_DIMS_GRACE_MS). Nothing invents a size on our behalf.
  if (!terminalFontsReady()) return null
  const parent = term.element?.parentElement
  if (!parent) return null
  const cell = deviceCell(term)
  if (!cell) {
    // Distinguish "hidden" from "the seam broke": a hidden pane's PARENT is unmeasurable
    // too (display:none computes width 'auto'), while a broken seam leaves a measurable
    // parent with no cell. Only the latter is a defect worth shouting about.
    if (!warnedCellSeam && Number.isFinite(parseFloat(window.getComputedStyle(parent).width))) {
      warnedCellSeam = true
      console.warn(
        'pane-fit: xterm renderer cell metrics unavailable (_renderService seam moved?) — panes cannot fit their container'
      )
    }
    return null
  }
  // getComputedStyle width/height resolve to the CONTENT box — .pane-body's padding
  // (the slide-bar lane) is already excluded, which is what makes the lane real and
  // the rest of the box the terminal's to fill completely.
  const parentStyle = window.getComputedStyle(parent)
  const parentWidth = parseFloat(parentStyle.width)
  const parentHeight = parseFloat(parentStyle.height)
  const elementStyle = window.getComputedStyle(term.element as HTMLElement)
  const padX =
    parseFloat(elementStyle.paddingLeft) + parseFloat(elementStyle.paddingRight)
  const padY = parseFloat(elementStyle.paddingTop) + parseFloat(elementStyle.paddingBottom)
  const published = publishableCell(cell, window.devicePixelRatio || 1)
  return gridFor(parentWidth - padX, parentHeight - padY, published.width, published.height)
}

/** Apply a proposed grid (render-clear + resize, exactly what FitAddon.fit did).
 *  Returns true when the terminal's grid actually changed. */
export function applyGrid(term: Terminal, dims: { cols: number; rows: number }): boolean {
  if (term.cols === dims.cols && term.rows === dims.rows) return false
  const core = (term as unknown as { _core?: { _renderService?: { clear?: () => void } } })._core
  core?._renderService?.clear?.()
  term.resize(dims.cols, dims.rows)
  return true
}
