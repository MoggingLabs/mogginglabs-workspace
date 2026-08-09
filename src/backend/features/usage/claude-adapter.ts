import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlanUsage, UsageAdapter } from '@contracts'
import { attemptClaudeRefresh } from './claude-refresh'
// Lane parsing lives in claude-lanes.ts (pure, unit-testable — this file
// cannot be imported by a test: claude-refresh pulls in node-pty at module
// scope). What a "lane" IS decides what can fire a usage alert, so it belongs
// where tests can reach it.
import { parseExtraUsage, parseLanes, planLabelFor } from './claude-lanes'

// Claude usage adapter (Phase-7/01, ADR 0007; hardened in the phase-11
// rebuild). Reads the token Claude Code ITSELF stored — `.credentials.json`
// under the config home (win/linux) or the CLI's Keychain entry via
// security(1) on macOS — holds it in memory for the ONE request to the usage
// endpoint the CLI itself polls, and drops it. The token variable never
// leaves `fetchPlan`'s scope; errors carry human reasons only.
//
// Phase-11 hardening (each from the reference implementation, steipete/
// CodexBar): an EXPIRED token triggers the delegated CLI refresh instead of
// permanent silence; the request carries the CLI's own User-Agent; a 429
// honors Retry-After behind a gate so Anthropic is never hammered; the newer
// `limits[]` shape is a full fallback (session + weekly_all + scoped), not
// just the scoped-weekly extras; and the plan label tells the user which
// plan the numbers belong to.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
/** UA fallback when the CLI version cannot be detected. */
const FALLBACK_CLI_VERSION = '2.1.0'
/** Refresh ahead of expiry so a poll never lands on a dead token. */
const EXPIRY_SOON_MS = 15 * 60_000
/** How long one fetch will wait for the delegated refresh before speaking. */
const REFRESH_WAIT_MS = 6_000

function readKeychain(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err ? null : stdout.trim())
    )
  })
}

/** The credential BLOB as the CLI stores it (both stores share the shape). */
async function readCredentialBlob(home: string): Promise<string | null> {
  if (process.platform === 'darwin') {
    const fromKeychain = await readKeychain()
    if (fromKeychain) return fromKeychain
    // Older installs / CLAUDE_CONFIG_DIR relocations fall back to the file.
  }
  const file = join(home, '.credentials.json')
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

interface ClaudeCreds {
  accessToken: string
  /** Epoch ms, when the CLI recorded one. The refresh token stays UNREAD —
   *  rotation belongs to the CLI (see claude-refresh.ts). */
  expiresAt?: number
  subscriptionType?: string
}

function parseCreds(blob: string): ClaudeCreds {
  const parsed = JSON.parse(blob) as {
    claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string }
  }
  const o = parsed.claudeAiOauth
  return {
    accessToken: o?.accessToken ?? '',
    ...(typeof o?.expiresAt === 'number' ? { expiresAt: o.expiresAt } : {}),
    ...(typeof o?.subscriptionType === 'string' ? { subscriptionType: o.subscriptionType } : {})
  }
}

// ── The CLI's own User-Agent, detected once an hour. The usage endpoint is
// the CLI's; we introduce ourselves as it does (the reference does exactly
// this, fallback version included).
let uaCache: { at: number; ua: string } | null = null
function claudeUserAgent(): Promise<string> {
  if (uaCache && Date.now() - uaCache.at < 3_600_000) return Promise.resolve(uaCache.ua)
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['--version'],
      { timeout: 4000, windowsHide: true, shell: process.platform === 'win32' },
      (err, stdout) => {
        const token = err ? null : String(stdout).trim().split(/\s+/)[0]
        const version = token && /^\d/.test(token) ? token : FALLBACK_CLI_VERSION
        uaCache = { at: Date.now(), ua: `claude-code/${version}` }
        resolve(uaCache.ua)
      }
    )
  })
}

// ── 429 gate: Anthropic rate-limits this endpoint; hammering it earns longer
// blocks. Honor Retry-After (seconds or HTTP-date), default a minute.
let blockedUntil = 0
function retryAfterMs(res: Response): number {
  const raw = res.headers.get('retry-after')?.trim()
  if (raw) {
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000
    const at = Date.parse(raw)
    if (Number.isFinite(at) && at > Date.now()) return at - Date.now()
  }
  return 60_000
}

export const claudeAdapter: UsageAdapter = {
  id: 'claude',

  detect: async (home) => {
    if (process.platform === 'darwin') {
      if ((await readKeychain()) !== null) return { ok: true }
    }
    if (existsSync(join(home, '.credentials.json'))) return { ok: true }
    return { ok: false, reason: 'Claude Code is not signed in on this machine (no credentials found)' }
  },

  fetch: async (home, profileId, signal) => {
    const fetchPlan = async (): Promise<PlanUsage[]> => {
      if (Date.now() < blockedUntil) {
        throw new Error('Anthropic rate-limited the usage check — backing off, not hammering')
      }
      let blob = await readCredentialBlob(home)
      if (!blob) throw new Error('Claude Code is not signed in (credentials missing)')
      let creds: ClaudeCreds
      try {
        creds = parseCreds(blob)
      } catch {
        throw new Error('credential store unreadable — sign in again with the CLI')
      }
      if (!creds.accessToken) throw new Error('no OAuth session — run `claude` and sign in')

      // Token lifecycle (delegated to the CLI — see claude-refresh.ts):
      // expired -> refresh now and wait briefly; merely expiring soon ->
      // refresh in the background, this poll rides the still-valid token.
      if (creds.expiresAt && creds.expiresAt <= Date.now() + 60_000) {
        await Promise.race([attemptClaudeRefresh(home), new Promise((r) => setTimeout(r, REFRESH_WAIT_MS))])
        blob = await readCredentialBlob(home)
        if (blob) {
          try {
            creds = parseCreds(blob)
          } catch {
            /* keep the previous parse; the throw below speaks */
          }
        }
        if (creds.expiresAt && creds.expiresAt <= Date.now()) {
          throw new Error('Claude session expired — auto-refresh via the CLI has not landed yet; run `claude` once if this persists')
        }
      } else if (creds.expiresAt && creds.expiresAt - Date.now() < EXPIRY_SOON_MS) {
        void attemptClaudeRefresh(home)
      }

      const res = await fetch(USAGE_URL, {
        signal,
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
          'User-Agent': await claudeUserAgent()
        }
      })
      if (res.status === 401 || res.status === 403) {
        // The stored token is dead. Kick the delegated refresh for the NEXT
        // poll and say honestly what this one saw.
        void attemptClaudeRefresh(home)
        throw new Error('session expired — refreshing via the Claude CLI; run `claude` if this persists')
      }
      if (res.status === 429) {
        blockedUntil = Date.now() + retryAfterMs(res)
        throw new Error('Anthropic rate-limited the usage check — backing off, not hammering')
      }
      if (!res.ok) throw new Error(`usage endpoint answered ${res.status}`)

      const body = (await res.json()) as Record<string, unknown>
      const windows = parseLanes(body)
      if (!windows.length) throw new Error('usage endpoint shape changed — adapter needs a look')
      const spend = parseExtraUsage(body)

      return [
        {
          providerId: 'claude',
          profileId,
          planLabel: planLabelFor(body, creds.subscriptionType),
          windows,
          ...(spend ? { spend } : {}),
          fetchedAt: Date.now(),
          health: 'fresh'
        }
      ]
    }
    return fetchPlan() // the token lives and dies inside fetchPlan's scope
  }
}
