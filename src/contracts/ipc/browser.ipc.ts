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
  /** False on a vault-less machine — agent-web logins last only until the dock
   *  closes (the chrome renders the honest copy). Machine-global (ADR 0008.h),
   *  so both sides derive per-workspace partition names from it. */
  agentWebPersists: boolean
  /** The omnibox search-engine template (`%s` = query). Machine-global setting,
   *  defaults to DEFAULT_SEARCH_TEMPLATE. */
  searchTemplate: string
}

/** Per-workspace browser partitions (8/07b): every workspace has its OWN
 *  browser — its own page state AND its own cookie jar/session, so you can be
 *  signed into different accounts per workspace. Both main and the renderer
 *  compute these identically so a guest and its driver agree. */
export function browserPreviewPartition(workspaceId: string): string {
  return `persist:bdock.${String(workspaceId).replace(/[^a-zA-Z0-9_-]/g, '')}`
}
export function browserAgentWebPartition(workspaceId: string, persists: boolean): string {
  const id = String(workspaceId).replace(/[^a-zA-Z0-9_-]/g, '')
  // No `persist:` prefix on a vault-less machine -> in-memory (never weakly-
  // protected cookies at rest, ADR 0008.h).
  return persists ? `persist:aweb.${id}` : `aweb-mem.${id}`
}

/** The dock's two session profiles (Phase-8/04, ADR 0008.e — FINDINGS Branch
 *  C): `preview` = the 6/05 empty-partition preview, byte-for-byte; `agent-web`
 *  = the dedicated signed-in profile the user logs into ON PURPOSE. Separate
 *  partitions; sign-ins live ONLY in agent-web; the system browser's sessions
 *  are NEVER read (Branch B stays parked behind its own ADR). */
export type BrowserProfile = 'preview' | 'agent-web'

export interface BrowserDockState {
  /** Workspace whose guest produced this state; renderer drops late foreign replies. */
  workspaceId: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** Which profile the dock is showing (8/04). */
  profile: BrowserProfile
  /** False on a vault-less machine (ADR 0008.h): agent-web runs a NON-persist
   *  partition there — logins last until the dock closes, never plaintext at
   *  rest. The chrome renders the honest copy from this flag. */
  agentWebPersists: boolean
}

/** One signed-in site in the agent-web partition (OUR own partition — never
 *  the system browser's): host + how many cookies it holds. */
export interface BrowserSignedInSite {
  host: string
  cookies: number
}

export type BrowserNavAction = 'back' | 'forward' | 'reload'

/** One tab within a (workspace, profile) — its stable id + what to show on the strip.
 *  url/title only (favicon is fetched renderer-side), never page content. */
export interface BrowserTab {
  id: string
  url: string
  title: string
}

/** The renderer's tab list for a (workspace, profile), cached main-side so the agent's
 *  `browser_tab_list` can answer and `browser_tab_select` can resolve an index → id. */
export interface BrowserTabsState {
  workspaceId: string
  profile: BrowserProfile
  tabs: BrowserTab[]
  activeId: string
}

/** A right-click inside a guest page, forwarded from MAIN (the guest's context-menu
 *  is a main-side webContents event) so the renderer draws the HOUSE menu. Coordinates
 *  are guest-viewport px; the renderer offsets them by the view host. Carries only what
 *  the menu needs — link/media targets + any selected text — never the page's DOM. */
export interface BrowserContextMenuParams {
  workspaceId: string
  x: number
  y: number
  linkURL: string
  srcURL: string
  selectionText: string
  isEditable: boolean
}

/** An app keyboard shortcut pressed while the GUEST page holds focus (F12). The guest
 *  is a separate process, so main intercepts it (before-input-event) and relays the
 *  normalized chord for the renderer's own handlers to run — no shortcut logic in main. */
export interface BrowserGuestChord {
  workspaceId: string
  code: string
  key: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

// ── Agent control (Phase-6/05b): agents drive the ONE visible dock ───────────
// These verbs are the driver seam the phase-8 MCP server exposes as tools; the
// smoke drives them directly. ADR 0002 holds at full throttle: no cookie /
// storage / credential verbs exist here — the wheel, not the vault.

export type BrowserAgentVerbName =
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'snapshot'
  | 'screenshot'
  | 'click'
  | 'type'
  | 'scroll'
  | 'select'
  | 'eval'
  | 'console'
  | 'network_failures'
  | 'wait_for'
  // Tabs (F4): an agent can hold a doc and the dev server open at once.
  | 'tab_list'
  | 'tab_new'
  | 'tab_select'

export interface BrowserAgentVerb {
  verb: BrowserAgentVerbName
  /** url (navigate) · ref/selector (click/type/select) · js (eval) · selector (wait_for). */
  target?: string
  /** typed text (type), option value (select). */
  value?: string
  /** wait_for / navigate timeout; console/network tail count. */
  n?: number
  /** scroll delta in px (scroll), or absolute y when `to === 'y'`. */
  dy?: number
  /** scroll only: 'y' makes `dy` an absolute document offset instead of a delta. */
  to?: 'y'
}

/** A snapshot node — the agent's eyes. `ref` is a stable data-attribute the
 *  driver stamps so a later click/type targets the same element. */
export interface BrowserSnapshotNode {
  ref: string
  role: string
  name: string
}

export interface BrowserAgentResult {
  ok: boolean
  /** Present on refusal: 'disabled' (no consent), 'noview', 'badtarget', 'timeout'. */
  reason?: string
  url?: string
  title?: string
  /** snapshot: interactive/labelled nodes + a visible-text digest. */
  nodes?: BrowserSnapshotNode[]
  text?: string
  /** snapshot: true when the node list hit its cap — the page has more. */
  truncated?: boolean
  /** screenshot: PNG as a data URL (never logged — returned to the caller only). */
  png?: string
  /** console / network_failures: recent lines (tail). */
  lines?: string[]
  /** eval: JSON-stringified return value (best effort). */
  value?: string
  /** tab_list / tab_new / tab_select: the tabs after the call + which is active. */
  tabs?: BrowserTab[]
  activeTabId?: string
}

/** Possession state + verb trail pushed to the dock chrome. Carries verb NAMES
 *  and target refs ONLY — never page content, typed text, or eval bodies. */
export interface BrowserAgentActivity {
  /** Workspace whose possession this describes. */
  workspaceId: string
  driving: boolean
  allowed: boolean
  trail: { verb: BrowserAgentVerbName; target?: string; at: number }[]
  /** 8/04: an ORIGIN awaiting the human's session-scoped "allow acting" click
   *  (the banner confirm). Origins only — never page content. */
  pendingConfirm?: string
  /** WHICH agent holds the wheel — its pane id (the renderer resolves it to a
   *  provider name + pane number for "Claude is browsing"). Absent for a
   *  human/IPC-driven act. Pane id only, never anything the pane contains. */
  pane?: string
  /** The verb currently in flight — the dock's live "Clicking…/Reading…" line. */
  lastVerb?: BrowserAgentVerbName
}

/** Cross-workspace possession: which workspaces have an agent attached to /
 *  driving their browser, and the pane driving each — so every workspace's tab can
 *  name its driver, not just the one in the foreground. */
export interface BrowserPossession {
  attached: string[]
  driving: string[]
  /** workspaceId -> the pane driving it (identity for the tab indicator). */
  drivers: Record<string, string>
}
