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
