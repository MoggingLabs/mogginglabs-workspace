import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlanUsage, UsageAdapter, UsageWindow } from '@contracts'

// Claude usage adapter (Phase-7/01, ADR 0007). Reads the token Claude Code
// ITSELF stored — `.credentials.json` under the config home (win/linux) or
// the CLI's Keychain entry via security(1) on macOS — holds it in memory for
// the ONE request to the usage endpoint the CLI itself polls, and drops it.
// The token variable never leaves `fetchPlan`'s scope; errors carry human
// reasons only. Endpoint + shape dev-verified 2026-07-06 (books, phase-7/01);
// any drift lands as health 'error' with a reason — never a throw upward.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

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

function pctWindow(label: string, w: unknown): UsageWindow | null {
  const o = w as { utilization?: unknown; resets_at?: unknown } | null
  if (!o || typeof o.utilization !== 'number') return null
  const usedPct = Math.max(0, Math.min(100, Math.round(o.utilization)))
  const resetsAt = typeof o.resets_at === 'string' ? o.resets_at : undefined
  return { label, usedPct, resetsAt }
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
      const blob = await readCredentialBlob(home)
      if (!blob) throw new Error('Claude Code is not signed in (credentials missing)')
      let accessToken = ''
      try {
        const parsed = JSON.parse(blob) as { claudeAiOauth?: { accessToken?: string } }
        accessToken = parsed.claudeAiOauth?.accessToken ?? ''
      } catch {
        throw new Error('credential store unreadable — sign in again with the CLI')
      }
      if (!accessToken) throw new Error('no OAuth session — run `claude` and sign in')

      const res = await fetch(USAGE_URL, {
        signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json'
        }
      })
      if (res.status === 401 || res.status === 403) {
        throw new Error('session expired — run `claude` and sign in again')
      }
      if (!res.ok) throw new Error(`usage endpoint answered ${res.status}`)

      const body = (await res.json()) as Record<string, unknown>
      const windows: UsageWindow[] = []
      const session = pctWindow('Session (5h)', body.five_hour)
      const weekly = pctWindow('Weekly', body.seven_day)
      const weeklyOpus = pctWindow('Weekly (Opus)', body.seven_day_opus)
      if (session) windows.push(session)
      if (weekly) windows.push(weekly)
      if (weeklyOpus) windows.push(weeklyOpus)
      if (!windows.length) throw new Error('usage endpoint shape changed — adapter needs a look')

      return [
        {
          providerId: 'claude',
          profileId,
          planLabel: 'Claude',
          windows,
          fetchedAt: Date.now(),
          health: 'fresh'
        }
      ]
    }
    return fetchPlan() // the token lives and dies inside fetchPlan's scope
  }
}
