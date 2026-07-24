// The canonical credential (ADR 0020, phase-tools/02) — the ONE shape every raw
// token response is normalized into at the moment of exchange or refresh. No
// downstream code ever reads a raw response field: providers disagree about
// everything (GitHub answers form-encoded without an Accept header and ships
// `refresh_token_expires_in`; others rotate, or omit, or re-spell), and every
// scattered read of a raw field is a provider quirk waiting to strand a grant.
//
// CUSTODY (unchanged, ADR 0014): a credential rests ONLY as OS-keychain
// ciphertext and is decrypted at exactly one point in main. This TYPE is shared
// so the pure suites can bite on the normalization seam — no IPC channel ever
// carries a value of it (the 8/08 discipline).

export interface CanonicalCredential {
  accessToken: string
  /** Epoch ms; absent = the provider issued a non-expiring credential. Already
   *  has the catalog method's `tokenExpirationBuffer` subtracted — downstream
   *  freshness math never re-applies quirks. */
  expiresAt?: number
  refreshToken?: string
  /** Epoch ms; GitHub-style `refresh_token_expires_in`, normalized at the seam. */
  refreshTokenExpiresAt?: number
  /** What the token response echoed (or what we asked for, when it echoed none). */
  scopes?: string[]
  /** Almost always `Bearer`; kept because fal.ai-style servers differ. */
  tokenType: string
  /** When the exchange/refresh happened (epoch ms) — the freshness anchor. */
  obtainedAt: number
  /** Which catalog method produced it (`browser`, `api-key`, …) — provenance for
   *  the card and for the re-connect path, never a secret. */
  method?: string
}

/** Refresh when `expiresAt - REFRESH_MARGIN_MS` has passed, not on expiry —
 *  a call in flight must not expire mid-request. */
export const REFRESH_MARGIN_MS = 60_000

/** A provider that REFUSED a refresh is not asked again for this long: hammering
 *  a refusing token endpoint from every proxy call in a burst is how apps get
 *  rate-limited into a worse state than the one they were retrying out of. */
export const REFRESH_FAILURE_COOLDOWN_MS = 5 * 60_000

/** Is this credential fresh enough to use as-is at `now`? */
export const credentialFresh = (c: { expiresAt?: number }, now: number): boolean =>
  !c.expiresAt || c.expiresAt - now > REFRESH_MARGIN_MS
