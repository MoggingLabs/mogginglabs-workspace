import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '@contracts'

// The per-OS / per-provider config-home table (ADR 0007 rule 3: KNOWN
// locations only, no crawling). A Phase-4 profile relocates a home via its
// pointer env; absent that, the CLI's documented default applies. `~` here is
// the OS home dir on every platform (these CLIs use it on Windows too).

/** The pointer env var that relocates each provider's config home. Exported:
 *  profile saves (src/main/profiles.ts) DERIVE a profile's pointer from it. */
export const HOME_POINTER: Record<string, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  gemini: 'GEMINI_CLI_HOME'
}

const DEFAULT_HOME: Record<string, () => string> = {
  claude: () => join(homedir(), '.claude'),
  codex: () => join(homedir(), '.codex'),
  gemini: () => join(homedir(), '.gemini'),
  // opencode keeps its SQLite store in the XDG DATA dir, not a dotfile home (verified on this
  // machine); aider caches litellm's model catalogue under its own.
  opencode: () => join(homedir(), '.local', 'share', 'opencode'),
  aider: () => join(homedir(), '.aider')
}

/** Expand a leading `~` (profiles store pointer values user-style). */
function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/** Resolve the config home an adapter should READ for (provider, profile).
 *  Profile pointer wins; otherwise the provider's documented default. */
export function resolveHome(providerId: string, profile: AgentProfile | null): string {
  const pointer = HOME_POINTER[providerId]
  const fromProfile = pointer && profile ? profile.env[pointer] : undefined
  if (providerId === 'gemini') {
    const legacy = profile?.env.GEMINI_CONFIG_DIR
    if (legacy) return expandTilde(legacy)
    if (fromProfile) return join(expandTilde(fromProfile), '.gemini')
  } else if (fromProfile) {
    return expandTilde(fromProfile)
  }
  const dflt = DEFAULT_HOME[providerId]
  return dflt ? dflt() : join(homedir(), `.${providerId}`)
}
