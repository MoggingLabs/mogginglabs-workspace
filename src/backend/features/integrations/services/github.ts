import { execFile } from 'node:child_process'
import type { LinkStatus, ServiceAdapter, ServiceChecksState, ServiceLink, ServiceLinkState, ServiceReviewDecision } from '@contracts'
import { refParts } from './parse'

// The GitHub adapter (Phase-8/12). Rides the session the user's own `gh`
// already owns — we call `gh` and let IT authenticate; the token NEVER enters
// this process (stronger than the letter of 0008.d, which allowed `gh auth
// token`). Read-only: one bounded `gh pr/issue view --json` per refresh, never
// a mutation. Errors are LABELED, never thrown into the UI; the ladder is
// no-gh -> unconfigured, logged-out -> error, rate-limited -> (engine) stale.

const GH = 'gh'

function gh(args: string[], signal: AbortSignal): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(GH, args, { timeout: 8000, windowsHide: true, signal, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const mapState = (s: string, isDraft: boolean): ServiceLinkState =>
  s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : isDraft ? 'draft' : 'open'

const mapReview = (r: string): ServiceReviewDecision | undefined =>
  r === 'APPROVED' ? 'approved' : r === 'CHANGES_REQUESTED' ? 'changes-requested' : r === 'REVIEW_REQUIRED' ? 'review-required' : undefined

// gh's own verdict, mirrored (cli: success passes, skipped/neutral count for
// nothing, every other COMPLETED conclusion fails). ACTION_REQUIRED, STALE and
// STARTUP_FAILURE used to match neither list and fell through to green — a PR
// whose checks all ask for a human is not passing.
const CHECK_FAILING = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE'])
const CHECK_SKIPPED = new Set(['SKIPPED', 'NEUTRAL'])

function mapChecks(rollup: unknown): ServiceChecksState {
  const arr = Array.isArray(rollup) ? rollup : []
  if (!arr.length) return 'none'
  let pending = false
  let passed = false
  for (const c of arr as { state?: string; conclusion?: string; status?: string }[]) {
    const v = String(c.conclusion || c.state || c.status || '').toUpperCase()
    if (CHECK_FAILING.has(v)) return 'failing'
    if (v === 'SUCCESS') passed = true
    else if (!CHECK_SKIPPED.has(v)) pending = true // queued/in-progress/expected — or a word we don't know yet
  }
  if (pending) return 'pending'
  // Nothing failed, nothing ran: an all-skipped rollup is 'none' (the chip's
  // neutral), never the green that says the checks passed.
  return passed ? 'passing' : 'none'
}

export function createGitHubAdapter(): ServiceAdapter {
  return {
    id: 'github',
    async detect() {
      // gh on PATH is enough to TRY; logged-out is an `error` at fetch, not
      // `unconfigured` — a distinct, repairable state (run `gh auth login`).
      const r = await new Promise<boolean>((resolve) => {
        execFile(GH, ['--version'], { timeout: 4000, windowsHide: true }, (err) => resolve(!err))
      })
      return r ? { ok: true } : { ok: false, reason: 'GitHub CLI (gh) not found on PATH' }
    },
    async fetch(link: ServiceLink, signal: AbortSignal): Promise<LinkStatus> {
      const parts = refParts(link.ref)
      if (!parts) throw new Error('unreadable ref')
      const repo = `${parts.owner}/${parts.repo}`
      const now = Date.now()
      const asIssue = async (repaired = false): Promise<LinkStatus> => {
        const r = await gh(['issue', 'view', String(parts.number), '--repo', repo, '--json', 'state,title'], signal)
        if (!r.ok) throw new Error(ghReason(r.stderr))
        const j = JSON.parse(r.stdout) as { state: string; title: string }
        return {
          linkId: link.id,
          health: 'fresh',
          fetchedAt: now,
          state: j.state === 'CLOSED' ? 'closed' : 'open',
          title: j.title,
          ...(repaired ? { repairedKind: 'issue' as const } : {})
        }
      }
      if (link.kind === 'issue') return asIssue()
      const r = await gh(['pr', 'view', String(parts.number), '--repo', repo, '--json', 'state,isDraft,reviewDecision,statusCheckRollup,title'], signal)
      if (!r.ok) {
        // THE correction parse.ts promises: `owner/repo#123` guessed pr, and a
        // number that isn't a PR is very often an ISSUE. Retry once — and if it
        // IS one, say so on the STATUS (repairedKind) so the engine applies and
        // persists the correction; the link argument itself is never mutated.
        if (/could not resolve|not found|no such/i.test(r.stderr)) {
          const corrected = await asIssue(true).catch(() => null)
          if (corrected) return corrected
        }
        throw new Error(ghReason(r.stderr)) // a genuinely missing ref keeps its honest reason
      }
      const j = JSON.parse(r.stdout) as { state: string; isDraft: boolean; reviewDecision: string; statusCheckRollup: unknown; title: string }
      return {
        linkId: link.id,
        health: 'fresh',
        fetchedAt: now,
        state: mapState(j.state, j.isDraft),
        reviewDecision: mapReview(j.reviewDecision),
        checks: mapChecks(j.statusCheckRollup),
        title: j.title
      }
    }
  }
}

/** A human reason from gh's stderr — never a token (gh never prints it). */
function ghReason(stderr: string): string {
  const s = stderr.toLowerCase()
  if (/not logged|authentication|gh auth login/.test(s)) return 'gh is logged out — run: gh auth login'
  if (/rate limit|api rate/.test(s)) return 'GitHub rate limit — showing last good'
  if (/could not resolve|not found|no such/.test(s)) return 'not found — check the ref'
  return stderr.trim().slice(0, 100) || 'gh request failed'
}
