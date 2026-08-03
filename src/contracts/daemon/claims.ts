// The file-claim referee: which patterns may be held at once.
//
// Lifted OUT of protocol.ts deliberately. check-protocol-version.mjs fingerprints that file to
// catch wire-shape changes, but it hashes every declaration in it — so a pure behaviour fix to
// `claimsOverlap` tripped a gate whose own header says it "covers the WIRE SHAPE and nothing
// else". These predicates never cross the socket; only the strings they judge do. Same move as
// src/contracts/daemon/gen.ts.

import { CLAIM_PATTERN_MAX } from './protocol'

export function normalizeClaimPattern(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const p = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!p || p.length > CLAIM_PATTERN_MAX) return null
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null // absolute / drive root
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return null
  return p
}

/** Conservative glob-vs-glob overlap: only a PURE-LITERAL segment mismatch proves
 *  the branches diverge — `**`, `*`, partial wildcards, prefix containment all count
 *  as overlap. When in doubt, DENY (the ledger is a referee, not an oracle). */
/**
 * A segment with NO glob metacharacter — the only kind that can prove divergence.
 *
 * The check was `!x.includes('*')`, which treats `?` and `[…]` as literal text. So
 * `router?.ts` and `router1.ts` "diverged", and two agents claiming what may be the same file
 * were both granted — the exact opposite of the conservative-deny rule stated above.
 */
const isLiteral = (segment: string): boolean => !/[*?[\]]/.test(segment)

export function claimsOverlap(a: string, b: string): boolean {
  const sa = a.split('/')
  const sb = b.split('/')
  for (let i = 0; ; i++) {
    const x = sa[i]
    const y = sb[i]
    if (x === undefined || y === undefined) return true // equal or prefix-contained
    if (x === '**' || y === '**') return true
    // Only a pure-literal mismatch proves divergence. A wildcard segment on either
    // side may or may not match — the walk continues as if it did, so a later
    // literal-vs-literal mismatch can still separate the branches; anything else
    // reaches the end and denies (the conservative default).
    if (isLiteral(x) && isLiteral(y) && x !== y) return false // proven divergence
  }
}
