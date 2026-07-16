// Settings deep-linking (Phase-8): each Settings tab is its own page, so a
// caller that wants to land on a SPECIFIC tab (the usage gear, a "browser
// settings" link) records the tab here, then navigates to the settings view.
// The settings feature reads the pending tab on entry and shows it. Kept as a
// tiny one-shot port so nothing imports the settings feature directly.

let pending: string | null = null

/** Ask the settings page to open on this tab the next time it's shown. */
export function requestSettingsTab(id: string): void {
  pending = id
}

/** The settings feature consumes the request (one-shot) on view entry. */
export function takeRequestedSettingsTab(): string | null {
  const id = pending
  pending = null
  return id
}

// ── Direct navigation (F-10 / S5) ────────────────────────────────────────────
// The one-shot request above is consumed only on a view CHANGE into settings —
// a cross-link clicked while ALREADY on the settings page would strand its token
// to fire on some future entry (the stale-focus-token bug, relearned). The
// settings feature registers a live navigator at mount; callers use goto and
// never need to know which state they are in.

type TabNav = (id: string) => void
let navigate: TabNav | null = null

/** Registered once by the settings feature at mount. */
export function registerSettingsTabNav(fn: TabNav): void {
  navigate = fn
}

/** Jump to a settings tab NOW if the page is mounted; else record the request. */
export function gotoSettingsTab(id: string): void {
  if (navigate) {
    navigate(id)
    return
  }
  pending = id
}
