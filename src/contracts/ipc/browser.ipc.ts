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

/** The dock's two session profiles (Phase-8/04, ADR 0008.e — FINDINGS Branch
 *  C): `preview` = the 6/05 empty-partition preview, byte-for-byte; `agent-web`
 *  = the dedicated signed-in profile the user logs into ON PURPOSE. Separate
 *  partitions; sign-ins live ONLY in agent-web; the system browser's sessions
 *  are NEVER read (Branch B stays parked behind its own ADR). */
export type BrowserProfile = 'preview' | 'agent-web'

export interface BrowserDockState {
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
  /** screenshot: PNG as a data URL (never logged — returned to the caller only). */
  png?: string
  /** console / network_failures: recent lines (tail). */
  lines?: string[]
  /** eval: JSON-stringified return value (best effort). */
  value?: string
}

/** Possession state + verb trail pushed to the dock chrome. Carries verb NAMES
 *  and target refs ONLY — never page content, typed text, or eval bodies. */
export interface BrowserAgentActivity {
  driving: boolean
  allowed: boolean
  trail: { verb: BrowserAgentVerbName; target?: string; at: number }[]
  /** 8/04: an ORIGIN awaiting the human's session-scoped "allow acting" click
   *  (the banner confirm). Origins only — never page content. */
  pendingConfirm?: string
}
