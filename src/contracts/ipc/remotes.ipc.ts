// Remote (SSH) hosts (Phase-4/05). A RemoteHost is a connection POINTER — the
// user's ssh config/agent does ALL auth (ADR 0002): we never prompt for, store, or
// forward keys, passphrases, or known_hosts. Host names are user data: local db +
// pane chip only — never telemetry.

export interface RemoteHost {
  id: string
  /** Display name (the pane chip). */
  name: string
  /** Hostname or ssh_config alias. */
  host: string
  user?: string
  port?: number
  /** Command dialect on the target. Defaults to posix/sh for older saved rows. */
  platform?: 'posix' | 'windows'
  shell?: 'sh' | 'bash' | 'zsh' | 'powershell' | 'cmd'
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
