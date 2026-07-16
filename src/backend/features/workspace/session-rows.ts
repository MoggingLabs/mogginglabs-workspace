import { normalizeRemoteConnection, type PersistedPane } from '@contracts'

// The PURE half of session persistence: PersistedPane <-> the panes-table row shape,
// sqlite-free so the unit tier can bite on the mapping (the workspace-rows.ts lesson:
// a field the mapping forgets round-trips as undefined for years). Both directions are
// used by BOTH write paths (the full savePanes and the dirty-pane upsert), so the two
// can never drift into disagreeing about what a row holds.

/** The persisted shell dialects a remote row may carry (PersistedPane.remote.shell). */
const REMOTE_SHELLS = new Set(['sh', 'bash', 'zsh', 'powershell', 'cmd'])
type PersistedRemoteShell = NonNullable<NonNullable<PersistedPane['remote']>['shell']>
const asRemoteShell = (value: string | null): PersistedRemoteShell | undefined =>
  value !== null && REMOTE_SHELLS.has(value) ? (value as PersistedRemoteShell) : undefined

/** The persisted scrollback tail, in UTF-16 code units. HALF the live ring
 *  (terminal/pane-shared.ts SCROLLBACK_CHARS) on purpose: the store is rewritten on a
 *  coalesced timer while the ring lives in memory, and a restore repaints plenty with
 *  100k — the halving bounds steady-state write amplification, it is not an accident. */
export const PERSISTED_SCROLLBACK_CHARS = 100_000

/** One pane row as the panes table stores it. */
export interface PaneRowCells {
  id: string
  workspaceId: string
  cwd: string
  reportedCwd: string | null
  reportedCwdAt: number | null
  remoteName: string | null
  remoteHost: string | null
  remoteUser: string | null
  remotePort: number | null
  remoteCwd: string | null
  remotePlatform: string | null
  remoteShell: string | null
  command: string | null
  scrollback: string
  updatedAt: number
}

export function paneToRow(p: PersistedPane): PaneRowCells {
  return {
    id: p.id,
    workspaceId: p.workspaceId ?? 'default',
    cwd: p.cwd,
    reportedCwd: p.reportedCwd ?? null,
    reportedCwdAt: p.reportedCwdAt ?? null,
    remoteName: p.remote?.name ?? null,
    remoteHost: p.remote?.host ?? null,
    remoteUser: p.remote?.user ?? null,
    remotePort: p.remote?.port ?? null,
    remoteCwd: p.remote?.cwd ?? null,
    remotePlatform: p.remote?.platform ?? null,
    remoteShell: p.remote?.shell ?? null,
    command: p.command ?? null,
    scrollback: p.scrollback.slice(-PERSISTED_SCROLLBACK_CHARS),
    updatedAt: p.updatedAt
  }
}

/** Row -> pane, or null for a row that must not restore. A partial/corrupt/unsupported
 *  REMOTE row fails CLOSED here rather than restoring as a local shell — restoring an
 *  SSH pane's launch command into a local shell is the failure this guard exists for. */
export function rowToPane(r: PaneRowCells): PersistedPane | null {
  const hasRemoteFields =
    r.remoteName !== null ||
    r.remoteHost !== null ||
    r.remoteUser !== null ||
    r.remotePort !== null ||
    r.remoteCwd !== null ||
    r.remotePlatform !== null
  const remote = hasRemoteFields
    ? normalizeRemoteConnection({
        name: r.remoteName,
        host: r.remoteHost,
        user: r.remoteUser ?? undefined,
        port: r.remotePort ?? undefined,
        platform: r.remotePlatform
      })
    : null
  if (hasRemoteFields && !remote) return null
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    cwd: r.cwd,
    reportedCwd: r.reportedCwd ?? undefined,
    reportedCwdAt: r.reportedCwdAt ?? undefined,
    // `shell` restores alongside the connection pointer: the contract's promise is
    // that a restored pane comes back speaking the dialect it went away in.
    remote: remote ? { ...remote, cwd: r.remoteCwd ?? undefined, shell: asRemoteShell(r.remoteShell) } : undefined,
    command: r.command ?? undefined,
    scrollback: r.scrollback,
    updatedAt: r.updatedAt
  }
}
