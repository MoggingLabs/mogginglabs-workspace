import { createHash } from 'node:crypto'

// Forensic activation watermark (ADR 0016 §leak-attribution, phase-accounts/07). The
// software analog of per-recipient forensic watermarking: at activation the operator's
// issuer binds a per-ACCOUNT fingerprint into the signed entitlement, so a leaked
// activation record points back to the account it was issued to. This module is the
// PURE codec both sides share — the issuer (embed) and the operator's trace tool
// (extract). It holds no crypto secret and touches no network; anti-forgery is the
// entitlement JWT's own Ed25519 signature (a carrier edited to frame another account
// invalidates the whole claim → the engine treats it as absent → Free).
//
// INVARIANT I6 — ID ONLY. A watermark carries the ACCOUNT ID and nothing else: never a
// token, never a credential, never terminal content. The id is a stable opaque handle
// (the IdP `sub`), not a secret.
//
// The mark is spread across two INDEPENDENT benign carriers so one surviving copy is
// enough to attribute — a leaker who strips the obvious field still ships the other:
//   · `wm`  — the PRIMARY carrier: a recoverable, checksummed encoding of the account
//             id in a single signed manifest field. Extraction reads the exact id here.
//   · `wmk` — the REDUNDANT carrier: a fixed vocabulary of benign tokens whose stable
//             ORDER (its Lehmer/factorial-base index) encodes a compact fingerprint of
//             the account id. It cannot reconstruct an arbitrary id alone, but against a
//             known-account set it ATTRIBUTES — and it corroborates `wm` when both ride.
//
// Honest limit (docs/19-accounts.md): a fork that KNOWS the scheme can strip both
// carriers, so this is leak EVIDENCE + a revocation trigger, not leak prevention.

/** The redundant carrier's vocabulary. Eight benign tokens → 8! = 40320 orderings, so
 *  the ordering encodes ~15.3 bits of fingerprint. Fixed and non-semantic: the ORDER is
 *  the signal, never the values. */
const CARRIER_TOKENS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
const PERMUTATIONS = 40320 // 8!

export interface WatermarkCarriers {
  /** Primary: `w1.<b64url(accountId)>.<b64url(sha256(accountId)[0..6])>`. */
  wm: string
  /** Redundant: a permutation of CARRIER_TOKENS whose Lehmer index === fingerprint. */
  wmk: string[]
}

export interface WatermarkTrace {
  /** The exact account id — from `wm` when it is present and its checksum verifies;
   *  otherwise from `wmk` matched against a supplied known-account set; else null. */
  accountId: string | null
  /** How attribution was reached. */
  attributedBy: 'primary' | 'order' | 'none'
  /** The fingerprint recovered from `wm` (null when the primary carrier is absent). */
  fingerprint: number | null
  /** The fingerprint recovered from the `wmk` ordering (null when it is absent/garbled). */
  orderFingerprint: number | null
  /** Both carriers present AND their fingerprints match — the corroborated case. */
  carriersAgree: boolean
}

const b64url = (buf: Buffer | string): string =>
  (typeof buf === 'string' ? Buffer.from(buf) : buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlToUtf8 = (s: string): string => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

const factorial = (n: number): number => {
  let f = 1
  for (let i = 2; i <= n; i++) f *= i
  return f
}

/** The stable per-account fingerprint the redundant carrier encodes. Deterministic,
 *  0 ≤ fp < 40320 — a hash of the id, never the id itself. */
export function fingerprint(accountId: string): number {
  return createHash('sha256').update(accountId).digest().readUInt32BE(0) % PERMUTATIONS
}

/** Lehmer/factorial-base: map an index in [0, n!) to a permutation of `items`. */
function permuteByIndex<T>(items: readonly T[], index: number): T[] {
  const pool = items.slice()
  const out: T[] = []
  let rem = index % factorial(pool.length)
  for (let i = 0; i < items.length; i++) {
    const f = factorial(pool.length - 1)
    const at = Math.floor(rem / f)
    rem %= f
    out.push(pool.splice(at, 1)[0])
  }
  return out
}

/** The inverse: recover the Lehmer index of a permutation, or null if `perm` is not a
 *  permutation of the vocabulary (a stripped or garbled ordering). */
function indexOfPermutation<T>(items: readonly T[], perm: readonly T[]): number | null {
  if (perm.length !== items.length) return null
  const pool = items.slice()
  let index = 0
  for (let i = 0; i < perm.length; i++) {
    const at = pool.indexOf(perm[i])
    if (at < 0) return null
    index += at * factorial(pool.length - 1)
    pool.splice(at, 1)
  }
  return index
}

/** Embed (issuer side): derive the two carriers for an account id. Deterministic — the
 *  same id always yields the same mark, so a re-activation is not a new fingerprint. */
export function deriveWatermark(accountId: string): WatermarkCarriers {
  const digest = createHash('sha256').update(accountId).digest()
  return {
    wm: `w1.${b64url(accountId)}.${b64url(digest.subarray(0, 6))}`,
    wmk: permuteByIndex(CARRIER_TOKENS, fingerprint(accountId))
  }
}

/** Extract (operator side): recover the account id from whichever carrier survived.
 *  `knownAccounts` lets the redundant carrier attribute when the primary is gone. */
export function traceWatermark(carriers: Partial<WatermarkCarriers>, knownAccounts: readonly string[] = []): WatermarkTrace {
  let accountId: string | null = null
  let fp: number | null = null
  let attributedBy: WatermarkTrace['attributedBy'] = 'none'

  const m = typeof carriers.wm === 'string' ? /^w1\.([^.]+)\.([^.]+)$/.exec(carriers.wm) : null
  if (m) {
    try {
      const id = b64urlToUtf8(m[1])
      const chk = b64url(createHash('sha256').update(id).digest().subarray(0, 6))
      if (chk === m[2]) {
        accountId = id
        fp = fingerprint(id)
        attributedBy = 'primary'
      }
    } catch {
      /* a corrupt primary carrier falls through to the redundant one */
    }
  }

  const orderFingerprint = Array.isArray(carriers.wmk) ? indexOfPermutation(CARRIER_TOKENS, carriers.wmk) : null

  if (accountId === null && orderFingerprint !== null) {
    const hit = knownAccounts.find((a) => fingerprint(a) === orderFingerprint)
    if (hit !== undefined) {
      accountId = hit
      fp = orderFingerprint
      attributedBy = 'order'
    }
  }

  return {
    accountId,
    attributedBy,
    fingerprint: fp,
    orderFingerprint,
    carriersAgree: fp !== null && orderFingerprint !== null && fp === orderFingerprint
  }
}
