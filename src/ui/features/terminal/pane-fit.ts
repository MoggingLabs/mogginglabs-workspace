import type { Terminal } from '@xterm/xterm'

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
 * The derivation is otherwise exactly FitAddon's, including its private seam: cell
 * metrics come from the ACTIVE renderer's `_renderService.dimensions.css.cell` (the
 * WebGL renderer floors cells at device pixels, the DOM renderer does not — so the
 * renderer that will paint is the only honest source; see PaneWebglManager, whose
 * attach/release now refits through this same derivation). Guarded like
 * retireXtermScrollbar: if xterm moves the seam, propose() returns null and the pane
 * keeps its grid — degraded, never broken.
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

/** The active renderer's CSS cell size — FitAddon's own seam, kept private-API-guarded. */
function activeCell(term: Terminal): RendererCell | null {
  const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: RendererCell } } } } })
    ._core
  const cell = core?._renderService?.dimensions?.css?.cell
  return cell && typeof cell.width === 'number' && typeof cell.height === 'number' ? cell : null
}

/** Propose the grid for the terminal's current container, or null when unmeasurable
 *  (not yet opened, hidden, or xterm moved its internals). */
export function proposeGrid(term: Terminal): { cols: number; rows: number } | null {
  const parent = term.element?.parentElement
  if (!parent) return null
  const cell = activeCell(term)
  if (!cell) return null
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
  return gridFor(parentWidth - padX, parentHeight - padY, cell.width, cell.height)
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
