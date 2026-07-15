// Remote (SSH) hosts (Phase-4/05). A RemoteHost is a connection POINTER — the
// user's ssh config/agent does ALL auth (ADR 0002): we never prompt for, store, or
// forward keys, passphrases, or known_hosts. Host names are user data: local db +
// pane chip only — never telemetry.

import type { RemoteShellDialect } from '../domain/remote'

export interface RemoteHost {
  id: string
  /** Display name (the pane chip). */
  name: string
  /** Hostname or ssh_config alias. */
  host: string
  /**
   * The remote's platform, and the dialect we must speak to it.
   *
   * Two intents met here and both survive. It must be EXPLICITLY CONFIRMED: a legacy row omits
   * it and stays unavailable for launch until the user says which it is — guessing an OS and
   * then typing at it is how you paste a bash-ism into a PowerShell (audit finding 9). And the
   * type stays a union rather than narrowing to 'posix', because `shell` below only means
   * anything if 'windows' is expressible.
   *
   * Note the daemon's remote bootstrap currently ACCEPTS POSIX ONLY and refuses the rest
   * (normalizeRemoteConnection). So 'windows' is representable and confirmable here, and
   * refused at the seam — which is the honest arrangement: the contract does not lie about
   * what a host IS in order to describe what the bootstrap can currently DO with it.
   */
  platform?: 'posix' | 'windows'
  /** Command dialect on the target (the shared union — domain/remote.ts). Undefined on
   *  rows whose platform the user has never confirmed. */
  shell?: RemoteShellDialect
  user?: string
  port?: number
  /** A NOTE about which identity to use (e.g. "work ed25519") — never a key path
   *  we read, never key material. Purely informational. */
  identityHint?: string
}

export interface RemoteRemoveResult {
  ok: boolean
  /** A referenced host is retained; panes never silently become local. */
  reason?: string
  referencedBy?: string[]
}
