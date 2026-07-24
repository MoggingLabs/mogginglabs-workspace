// The tool card (ADR 0020, phase-tools/05): one TOOL = one card, whichever route
// holds its credential — and every sentence the card speaks is written HERE, so no
// surface can word the same fact two ways. The TOOLCARDS gate bites the merge and
// the chooser directly (both carry TEST-ONLY mutation knobs it proves live).

import type { Connection } from './connections'
import type { McpServerEntry } from './registry'
import type { McpConnState, McpStatusSnapshot } from './status'
import type { ProviderEntry, ProviderMethod, ProviderMethodKind } from './provider-catalog'

// ── The status tag: exactly four (ADR 0020 Appendix A) ───────────────────────

export type ToolStatusKind = 'connected' | 'attention' | 'off' | 'connecting'
export interface ToolStatusTag {
  kind: ToolStatusKind
  text: string
}

/** The connection-route tag. `verifiedAt` (phase-tools/03) makes "Connected" a
 *  sentence about THIS quarter-hour — the continuous re-verify differentiator. */
export function connectionStatusTag(c: Pick<Connection, 'state' | 'verifiedAt'>, now: number = Date.now()): ToolStatusTag {
  switch (c.state) {
    case 'connected': {
      if (!c.verifiedAt) return { kind: 'connected', text: '✓ Connected' }
      const mins = Math.max(0, Math.round((now - c.verifiedAt) / 60_000))
      return { kind: 'connected', text: `✓ Connected · verified ${mins}m ago` }
    }
    case 'connecting':
      return { kind: 'connecting', text: 'Connecting…' }
    case 'expired':
    case 'error':
      return { kind: 'attention', text: 'Needs attention' }
    default:
      return { kind: 'off', text: 'Not connected' }
  }
}

// ── The merge: one tool = one card, whichever route holds its credential ─────

export interface ToolCardRow {
  /** The merge key: the catalog service id (a registry row shares it). */
  id: string
  label: string
  /** The app-held route (ADR 0014), when this service has a connection card. */
  connection?: Connection
  /** The CLI-owned route: a registry row that is NOT the app's own bridge fanout
   *  (a bridge row is the connection wearing its server clothes — same tool). */
  server?: McpServerEntry
  /** Claude Code's own read of the CLI route (phase-8/11 status), when applied. */
  cliState?: McpConnState
}

const isBridgeRow = (s: McpServerEntry): boolean => Array.isArray(s.args) && s.args[0] === '--connection'

/**
 * Merge the two routes into one row per service id. A service connected through
 * the app AND applied on a CLI is ONE tool with two facts, never two cards.
 * `_testBreakMergeKey` is TEST-ONLY (the TOOLCARDS mutation-red): it keys by
 * route as well, which is exactly the two-cards-for-one-tool regression.
 */
export function mergeToolCards(
  connections: readonly Connection[],
  servers: readonly McpServerEntry[],
  snapshot: McpStatusSnapshot | null,
  o: { _testBreakMergeKey?: boolean } = {}
): ToolCardRow[] {
  const rows = new Map<string, ToolCardRow>()
  const keyOf = (id: string, route: string): string => (o._testBreakMergeKey ? `${id}:${route}` : id)
  for (const c of connections) {
    rows.set(keyOf(c.id, 'conn'), { id: c.id, label: c.label, connection: c })
  }
  for (const s of servers) {
    if (s.builtIn) continue // the house server is not a tool card
    const key = keyOf(s.id, 'cli')
    const row = rows.get(key) ?? { id: s.id, label: s.label }
    if (!isBridgeRow(s)) {
      row.server = s
      const cli = snapshot?.statuses.find((x) => x.serverId === s.id && x.cli === 'claude-code')
      if (cli && cli.state !== 'off') row.cliState = cli.state
    }
    rows.set(key, row)
  }
  return [...rows.values()]
}

/** The row's ONE status tag: the app-held route's truth wins (it is verified by
 *  our own engine); the CLI route's read stands in only when that is all there is. */
export function toolCardTag(row: ToolCardRow, now: number = Date.now()): ToolStatusTag {
  if (row.connection && row.connection.state !== 'disconnected') return connectionStatusTag(row.connection, now)
  if (row.cliState === 'connected') return { kind: 'connected', text: '✓ Connected' }
  if (row.cliState === 'needs-auth' || row.cliState === 'error' || row.cliState === 'drift') {
    return { kind: 'attention', text: 'Needs attention' }
  }
  if (row.connection) return connectionStatusTag(row.connection, now)
  return { kind: 'off', text: 'Not connected' }
}

// ── The chooser (ADR 0020 Appendix A, verbatim) ──────────────────────────────

export const CHOOSER_LABELS: Readonly<Record<ProviderMethodKind, string>> = {
  oauth: 'Sign in with your browser',
  apiKey: 'Paste an API key',
  cliOwned: 'Let Claude Code sign in itself (advanced)',
  none: 'Connect'
}

/** The one-line custody subtitles — fine print, where mechanism words are legal. */
export const CUSTODY_SUBTITLES: Readonly<Record<ProviderMethodKind, string>> = {
  oauth: 'Held by this app, encrypted by your OS keychain — never written into any CLI config.',
  apiKey: 'Pasted once, encrypted by your OS keychain, referenced as ${NAME}.',
  cliOwned: 'Claude Code holds its own credential; the app brokers nothing on this route.',
  none: 'No account needed — connecting makes it available to your agents.'
}

export interface ChooserRow {
  key: string
  kind: ProviderMethodKind
  label: string
  subtitle: string
  method: ProviderMethod
}

/**
 * The catalog's methods in rank order, worded by the ADR table. `_testBreakRank`
 * is TEST-ONLY (the TOOLCARDS mutation-red): it reverses the order, which is
 * exactly the wrong-method-first regression the gate must catch.
 */
export function chooserMethods(entry: ProviderEntry, o: { _testBreakRank?: boolean } = {}): ChooserRow[] {
  const ranked = [...entry.methods].sort((a, b) => (o._testBreakRank ? b.rank - a.rank : a.rank - b.rank))
  return ranked.map((m) => ({
    key: m.key,
    kind: m.kind,
    label: CHOOSER_LABELS[m.kind],
    subtitle: CUSTODY_SUBTITLES[m.kind],
    method: m
  }))
}

// ── The silent reconciler's sentences (ADR 0020 Appendix A, phase-tools/06) ──
// Drift/apply/adopt is MACHINERY vocabulary; the user sees a tool whose Claude
// Code config needs fixing, and a Fix button. One sentence, one primary verb, one
// quiet secondary — written here so no surface can word them twice.

export type CliFixFlavor = 'edited' | 'missing'

export const FIX_SENTENCES: Readonly<Record<CliFixFlavor, { sentence: string; secondary: string }>> = {
  edited: {
    sentence: 'Claude Code’s config for this tool was edited by hand.',
    secondary: 'Keep my edit'
  },
  missing: {
    sentence: 'Claude Code’s config for this tool was removed outside the app.',
    secondary: 'Forget this tool on Claude Code'
  }
}

/** The diff preview keeps its trust-artifact role under a plain title. */
export const FIX_PREVIEW_TITLE = 'What Fix will change'

/** The backups line, plainly worded. */
export const backupsLine = (latest: string): string => `We keep backups — latest: ${latest}`

// ── Humanized scopes (Metorial): titles rendered, raw kept, nothing hidden ───

export interface HumanScope {
  scope: string
  title: string
  /** False when the catalog knew this scope — true for a granted-but-uncataloged
   *  scope, which renders as its raw string rather than being hidden. */
  fallback: boolean
}

export function humanizeScopes(entry: ProviderEntry | undefined, granted: readonly string[]): HumanScope[] {
  const titles = new Map<string, string>()
  for (const m of entry?.methods ?? []) {
    for (const s of m.scopes ?? []) if (s.title?.trim()) titles.set(s.scope, s.title.trim())
  }
  return granted.map((scope) => {
    const title = titles.get(scope)
    return title ? { scope, title, fallback: false } : { scope, title: scope, fallback: true }
  })
}
