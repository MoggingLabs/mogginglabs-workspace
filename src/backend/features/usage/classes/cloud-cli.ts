import { execFile } from 'node:child_process'
import type { PlanUsage } from '@contracts'

// The `cloud-cli` class (Phase-7/05): ambient cloud credentials via the
// VENDOR's own CLI, read at request time — execFile with a hard timeout,
// token/output in memory for the one use, never stored (ADR 0007). No CLI /
// logged-out -> labeled states with the human fix. Neither gcloud nor aws is
// installed on the dev machine (2026-07-06), so the mechanics + labeled
// degradation are what's live-verified here; a machine with a real login
// upgrades a row to verifiedAt when it proves out (the 7/04 discipline).

// 'absent' must be deterministic on every OS, so presence is probed FIRST
// (`where`/`which`) — under a shell a missing command exits 1 and would
// mislabel as 'failed', and Node 18+ refuses shell-less .cmd spawns (EINVAL),
// so neither path alone is reliable on Windows. After a positive probe, .cmd
// shims (gcloud on win) run under a shell — these arg lists carry no spaces
// or quotes except bedrock's JSON filter, which plain-exe aws never shells.
function runOnce(bin: string, args: string[], timeoutMs: number, useShell = false): Promise<{ ok: boolean; stdout: string; code: 'absent' | 'failed' | 'ok' }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true, shell: useShell }, (err, stdout) => {
      if (!err) return resolve({ ok: true, stdout: String(stdout), code: 'ok' })
      const anyErr = err as NodeJS.ErrnoException
      resolve({ ok: false, stdout: '', code: anyErr.code === 'ENOENT' ? 'absent' : 'failed' })
    })
  })
}
async function run(bin: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; stdout: string; code: 'absent' | 'failed' | 'ok' }> {
  const probe = process.platform === 'win32' ? await runOnce('where', [bin], 4000) : await runOnce('which', [bin], 4000)
  if (!probe.ok) return { ok: false, stdout: '', code: 'absent' }
  const isShim = process.platform === 'win32' && /\.(cmd|bat)\s*$/im.test(probe.stdout)
  return runOnce(bin, args, timeoutMs, isShim)
}

const labeled = (id: string, profileId: string, health: PlanUsage['health'], reason: string): PlanUsage => ({
  providerId: id,
  profileId,
  planLabel: '—',
  windows: [],
  fetchedAt: Date.now(),
  health,
  reason
})

/** Vertex AI: prove the ambient gcloud session is live (the token is obtained
 *  and immediately discarded — presence IS the signal; Vertex has no simple
 *  quota endpoint, so v1 reports session health; spend lands with 7/07). */
export async function fetchVertex(profileId: string, bin = 'gcloud'): Promise<PlanUsage> {
  // `bin` is injectable so the smoke can force the absent-CLI ladder
  // deterministically on ANY machine (CI images ship cloud CLIs).
  const r = await run(bin, ['auth', 'print-access-token', '--quiet'])
  if (r.code === 'absent') return labeled('vertex', profileId, 'unconfigured', 'gcloud is not installed — install the Google Cloud CLI and run `gcloud auth login`')
  if (!r.ok || !r.stdout.trim()) return labeled('vertex', profileId, 'error', 'gcloud is installed but not logged in — run `gcloud auth login`')
  // Token verified present and DROPPED — never parsed further, never stored.
  return {
    providerId: 'vertex',
    profileId,
    planLabel: 'Vertex AI',
    windows: [{ label: 'Session', usedPct: 0, windowMs: 0, raw: 'gcloud session active — spend detail lands with the cost scan (7/07)' }],
    fetchedAt: Date.now(),
    health: 'fresh'
  }
}

/** AWS Bedrock: month-to-date Bedrock spend via Cost Explorer through the
 *  user's own `aws` CLI session (profile/SSO/assume-role all ride the CLI). */
export async function fetchBedrock(profileId: string, bin = 'aws'): Promise<PlanUsage> {
  const now = new Date()
  const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
  const end = now.toISOString().slice(0, 10)
  const r = await run(bin, [
    'ce',
    'get-cost-and-usage',
    '--time-period',
    `Start=${start},End=${end}`,
    '--granularity',
    'MONTHLY',
    '--metrics',
    'UnblendedCost',
    '--filter',
    '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Bedrock"]}}',
    '--output',
    'json'
  ])
  if (r.code === 'absent') return labeled('bedrock', profileId, 'unconfigured', 'aws CLI is not installed — install it and configure a profile/SSO')
  if (!r.ok) return labeled('bedrock', profileId, 'error', 'aws CLI failed — check `aws sts get-caller-identity` (login/SSO expired?)')
  try {
    const parsed = JSON.parse(r.stdout) as { ResultsByTime?: { Total?: { UnblendedCost?: { Amount?: string; Unit?: string } } }[] }
    const total = parsed.ResultsByTime?.[0]?.Total?.UnblendedCost
    const amount = total?.Amount ? Number(total.Amount) : NaN
    if (!Number.isFinite(amount)) throw new Error('shape')
    return {
      providerId: 'bedrock',
      profileId,
      planLabel: 'AWS Bedrock',
      windows: [{ label: 'Spend', usedPct: 0, windowMs: 30 * 86_400_000, raw: `${amount.toFixed(2)} ${total?.Unit ?? 'USD'} month-to-date` }],
      fetchedAt: Date.now(),
      health: 'fresh'
    }
  } catch {
    return labeled('bedrock', profileId, 'error', 'Cost Explorer answer shape changed — adapter needs a look')
  }
}
