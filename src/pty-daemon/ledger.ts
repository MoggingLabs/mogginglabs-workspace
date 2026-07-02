// Exclusive file-ownership ledger (Phase-4/02). IN-MEMORY referee for the swarm:
// a pane claims repo-relative globs before editing; overlapping claims are DENIED
// with the owner named; a pane's claims die with its session. The ledger ADVISES —
// it never blocks PTY writes or file I/O (the reviewer gate catches strays), and
// claim patterns are paths: they stay in this process + authed socket replies only
// (never telemetry, never logs — ADR 0005).
//
// Scope: claims contest ownership PER WORKSPACE ORDINAL (floor(paneId/100)) — panes
// of one repo wall referee each other; unrelated workspaces never collide.
import { claimsOverlap, normalizeClaimPattern, type Claim, type SwarmRole } from '@contracts'

export type ClaimResult =
  | { ok: true; id: number }
  | { ok: false; reason: 'badpattern' }
  | { ok: false; reason: 'denied'; ownerPaneId: string; pattern: string }

const groupOf = (paneId: string): string => {
  const n = Number(paneId)
  return Number.isFinite(n) ? String(Math.floor(n / 100)) : '0'
}

export class Ledger {
  private nextId = 1
  private claims: Claim[] = []
  /** Set by the transport so changes push a fresh `owners` to every client. */
  onChange?: () => void

  claim(paneId: string, pattern: string, role?: SwarmRole): ClaimResult {
    const clean = normalizeClaimPattern(pattern)
    if (!clean) return { ok: false, reason: 'badpattern' }
    const group = groupOf(paneId)
    for (const c of this.claims) {
      if (c.paneId === paneId) continue // extending your own territory is fine
      if (groupOf(c.paneId) !== group) continue // other workspaces never collide
      if (claimsOverlap(clean, c.pattern)) {
        return { ok: false, reason: 'denied', ownerPaneId: c.paneId, pattern: c.pattern }
      }
    }
    const claim: Claim = { id: this.nextId++, paneId, role, pattern: clean, ts: Date.now() }
    this.claims.push(claim)
    this.onChange?.()
    return { ok: true, id: claim.id }
  }

  /** Release by exact pattern, or everything a pane holds. Returns how many. */
  release(paneId: string, pattern?: string, all = false): number {
    const clean = pattern ? normalizeClaimPattern(pattern) : null
    const before = this.claims.length
    this.claims = this.claims.filter((c) => {
      if (c.paneId !== paneId) return true
      if (all) return false
      return clean == null || c.pattern !== clean
    })
    const count = before - this.claims.length
    if (count > 0) this.onChange?.()
    return count
  }

  owners(): Claim[] {
    return this.claims.slice()
  }

  /** A pane's session ended — its territory frees immediately. */
  clearPane(paneId: string): void {
    this.release(paneId, undefined, true)
  }
}
