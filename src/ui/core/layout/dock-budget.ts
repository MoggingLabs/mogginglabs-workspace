import { EXPLORER_MIN_WIDTH } from '@contracts'

export const BROWSER_DOCK_MIN = 320
export const BROWSER_OVERLAY_MIN = 240
export const DOCK_CONTENT_FLOOR = 480
export const COMPACT_CONTENT_FLOOR = 280

export interface DockLayoutBudget {
  railWidth: number
  contentFloor: number
  browserOverlay: boolean
  explorerOverlay: boolean
  browserMin: number
  browserMax: number
  explorerMax: number
}

type Listener = () => void
const listeners = new Set<Listener>()
let initialized = false
let queued = false

const visible = (selector: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`${selector}:not([hidden])`)

/** One responsive budget for rail + content + both right docks. */
export function dockLayoutBudget(): DockLayoutBudget {
  const app = document.getElementById('app')
  const browser = visible('.browser-dock')
  const explorer = visible('.explorer-dock')
  const contentFloor = window.innerWidth < 800 ? COMPACT_CONTENT_FLOOR : DOCK_CONTENT_FLOOR
  const expandedNeed =
    288 + contentFloor + (browser ? BROWSER_DOCK_MIN : 0) + (explorer ? EXPLORER_MIN_WIDTH : 0)
  app?.classList.toggle('rail-auto-collapsed', window.innerWidth < expandedNeed)

  const railWidth = document.getElementById('rail')?.getBoundingClientRect().width ?? 0
  const available = Math.max(0, window.innerWidth - railWidth)
  const explorerOverlay = !!explorer && available - EXPLORER_MIN_WIDTH < contentFloor
  const explorerReservation = explorer && !explorerOverlay ? EXPLORER_MIN_WIDTH : 0
  const browserOverlay =
    !!browser && available - explorerReservation - BROWSER_DOCK_MIN < contentFloor
  const browserReservation = browser && !browserOverlay ? BROWSER_DOCK_MIN : 0
  const explorerMax = Math.max(
    EXPLORER_MIN_WIDTH,
    available - browserReservation - (explorerOverlay ? 0 : contentFloor)
  )
  // Even an overlaid Explorer occupies the right edge. Browser must stack to
  // its left instead of hiding underneath it when both docks overlay at 600px.
  const predictedExplorerWidth = explorer
    ? Math.min(explorerMax, Math.max(EXPLORER_MIN_WIDTH, explorer.getBoundingClientRect().width || EXPLORER_MIN_WIDTH))
    : 0
  const browserMin = browserOverlay ? BROWSER_OVERLAY_MIN : BROWSER_DOCK_MIN
  const browserMax = Math.max(
    browserMin,
    available - predictedExplorerWidth - (browserOverlay ? 0 : contentFloor)
  )

  app?.classList.toggle('browser-budget-overlay', browserOverlay)
  app?.classList.toggle('explorer-budget-overlay', explorerOverlay)
  app?.style.setProperty('--explorer-budget-width', `${predictedExplorerWidth}px`)
  return { railWidth, contentFloor, browserOverlay, explorerOverlay, browserMin, browserMax, explorerMax }
}

export function requestDockLayout(): void {
  if (queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    dockLayoutBudget()
    for (const listener of listeners) listener()
  })
}

export function onDockLayoutChange(listener: Listener): () => void {
  listeners.add(listener)
  if (!initialized) {
    initialized = true
    window.addEventListener('resize', requestDockLayout)
    const main = document.getElementById('main')
    if (main) {
      new MutationObserver(requestDockLayout).observe(main, {
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden']
      })
    }
  }
  requestDockLayout()
  return () => listeners.delete(listener)
}
