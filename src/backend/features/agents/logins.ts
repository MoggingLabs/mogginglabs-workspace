import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveHome } from '../usage/homes'
import type { AgentProfile, ProfileLoginState } from '@contracts'

// Login discovery (profiles simplified, part 2): every account a CLI is ALREADY
// signed into must surface as a profile — otherwise there is nothing to launch
// under. This module answers ONE question per known config home: "is somebody
// signed in here, and what is the account's email label?" ADR 0007 rule 3
// applies: KNOWN locations only (the provider's default home + homes existing
// profiles point at) — never a filesystem crawl. ADR 0002 stays the hard line:
// where a store also holds tokens (codex's auth.json), only the EMAIL string
// survives the parse — the blob dies in function scope, is never returned,
// stored, or logged.

export interface DiscoveredLogin {
  provider: string
  /** Resolved absolute config home the login lives in. */
  home: string
  /** The account's email label, when the CLI recorded one. */
  email?: string
  /** Existing profile whose home this is (absent -> this login has no profile yet). */
  profileId?: string
}

/** Case-insensitive on win32 — profile pointers are user-typed paths. */
const normPath = (p: string): string => {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const asEmail = (v: unknown): string | undefined => (typeof v === 'string' && v.includes('@') ? v.trim() : undefined)

/** Claude Code: the state file is `<home>/.claude.json` under a relocated home;
 *  the DEFAULT home keeps it at `~/.claude.json` (a sibling of `~/.claude`). */
function claudeLogin(home: string, isDefaultHome: boolean): { email?: string } | null {
  const stateFiles = [join(home, '.claude.json'), ...(isDefaultHome ? [join(homedir(), '.claude.json')] : [])]
  let email: string | undefined
  for (const f of stateFiles) {
    const state = readJson(f)
    const account = state?.oauthAccount as Record<string, unknown> | undefined
    email = asEmail(account?.emailAddress)
    if (email) break
  }
  const signedIn = existsSync(join(home, '.credentials.json')) || email !== undefined
  return signedIn ? { email } : null
}

/** Codex: `<home>/auth.json` holds tokens; the email rides the id_token's JWT
 *  claims. Only the email leaves this function — the blob dies here (ADR 0002). */
function codexLogin(home: string): { email?: string } | null {
  const auth = readJson(join(home, 'auth.json'))
  if (!auth) return null
  let email: string | undefined
  try {
    const idToken = (auth.tokens as Record<string, unknown> | undefined)?.id_token
    if (typeof idToken === 'string') {
      const seg = idToken.split('.')[1]
      if (seg) {
        const claims = JSON.parse(
          Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
        ) as Record<string, unknown>
        email = asEmail(claims.email)
      }
    }
  } catch {
    /* unreadable claims — the login still counts, just unlabeled */
  }
  return { email }
}

/** Gemini CLI: `<home>/oauth_creds.json` marks the login; the active account's
 *  email sits in `<home>/google_accounts.json`. */
function geminiLogin(home: string): { email?: string } | null {
  const signedIn = existsSync(join(home, 'oauth_creds.json'))
  const accounts = readJson(join(home, 'google_accounts.json'))
  const email = asEmail(accounts?.active)
  if (!signedIn && !email) return null
  return { email }
}

const PROBES: Record<string, (home: string, isDefaultHome: boolean) => { email?: string } | null> = {
  claude: claudeLogin,
  codex: codexLogin,
  gemini: geminiLogin
}

/** Login state at ONE (provider, profile) config home — the `profiles:list`
 *  decorator's and the launch hint's probe. `undefined` = this provider has no
 *  probe (unknowable) or the home was unreadable; a `signedIn` boolean is a
 *  CHECKED fact about that home, never a guess. */
export function probeLogin(provider: string, profile: AgentProfile | null): ProfileLoginState | undefined {
  const probe = PROBES[provider]
  if (!probe) return undefined
  try {
    const home = resolveHome(provider, profile)
    const login = probe(home, normPath(home) === normPath(resolveHome(provider, null)))
    return login ? { signedIn: true, email: login.email } : { signedIn: false }
  } catch {
    return undefined // an unreadable home is UNKNOWN — it must not render as "signed out"
  }
}

/** Every signed-in account across the KNOWN homes: each provider's default home
 *  plus every home an existing profile points at. Pure read — no writes here;
 *  the reconciler (src/main/profiles.ts) decides what becomes a profile row. */
export function discoverLogins(profiles: AgentProfile[]): DiscoveredLogin[] {
  const out: DiscoveredLogin[] = []
  for (const provider of Object.keys(PROBES)) {
    const defaultHome = resolveHome(provider, null)
    const mine = profiles.filter((p) => p.provider === provider)
    // default home first: on a fresh install the machine's login lands order 0.
    const homes = new Map<string, { home: string; profileId?: string }>()
    homes.set(normPath(defaultHome), { home: defaultHome })
    for (const p of mine) {
      const home = resolveHome(provider, p)
      const key = normPath(home)
      if (!homes.has(key)) homes.set(key, { home, profileId: p.id })
      else if (!homes.get(key)!.profileId) homes.get(key)!.profileId = p.id
    }
    for (const { home, profileId } of homes.values()) {
      try {
        const login = PROBES[provider](home, normPath(home) === normPath(defaultHome))
        if (login) out.push({ provider, home, email: login.email, profileId })
      } catch {
        /* a single unreadable home never breaks discovery */
      }
    }
  }
  return out
}
