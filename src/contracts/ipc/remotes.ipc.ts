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
  /** Explicitly confirmed remote shell platform. Legacy rows omit this and remain
   *  unavailable for launch until the user confirms them in Settings. */
  platform?: 'posix'
  user?: string
  port?: number
  /** A NOTE about which identity to use (e.g. "work ed25519") — never a key path
   *  we read, never key material. Purely informational. */
  identityHint?: string
}
