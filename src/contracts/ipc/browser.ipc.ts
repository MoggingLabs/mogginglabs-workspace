/**
 * Browser dock (Phase-6/05): a toggleable right dock previewing what the
 * agents build. MAIN owns the WebContentsView; the renderer owns the dock
 * chrome and reports the rect the view must cover. The dock brokers NOTHING
 * (ADR 0002): these channels carry urls, rects, and nav verbs — never
 * cookies, sessions, or credentials.
 */

export interface BrowserDockInit {
  open: boolean
  width: number
}

export interface BrowserDockBounds {
  x: number
  y: number
  width: number
  height: number
  /** The dock's OUTER width (drag handle position) — persisted, distinct from the view rect. */
  dockWidth: number
  visible: boolean
}

export interface BrowserDockState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export type BrowserNavAction = 'back' | 'forward' | 'reload'
