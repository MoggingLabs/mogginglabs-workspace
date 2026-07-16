/**
 * The account (ADR 0015). The app's OWN credential to MoggingLabs — for
 * ENTITLEMENTS, never a provider login. ADR 0002 is untouched: Claude/Codex/Gemini
 * still authenticate themselves, and no provider token ever enters this process.
 *
 * The one rule this contract encodes BY CONSTRUCTION: **no channel returns a token.**
 * `status` carries identity + plan CLAIMS only; `login`/`logout` are verbs whose
 * results hold no token. All token material lives only in main (src/main/account.ts),
 * as vault ciphertext or in memory, decrypted at exactly one point of use — the 8/08
 * write-only discipline (ADR 0014 custody), extended to our own tokens. There is no
 * `account:token`, no getter, and the absence is the security property: a renderer
 * bug cannot leak what the surface never hands out.
 */

/** `anon` = no account (the free local core needs none — ADR 0015 §2). `authed` =
 *  a MoggingLabs session is held (refresh token vaulted, DPoP-key bound). */
export type AccountState = 'anon' | 'authed'

/** CLAIMS ONLY — the whole outward shape of "who am I / what plan". A token has no
 *  field here and never will. */
export interface AccountStatus {
  state: AccountState
  /** The signed-in account's email, when the id_token carried one. */
  email?: string
  /** The entitlement plan claim (e.g. 'free' | 'pro'). LOCAL UX ONLY — real teeth
   *  are hardware binding + server-side value (ADR 0015 §5), never this string. */
  plan?: string
  /** One transient human sentence when a sign-in attempt just FAILED — rides the
   *  `changed` push only, never stored, never returned by `status`. Exists because a
   *  post-consent failure (a refused exchange, a vault refusal) otherwise surfaced
   *  nowhere: status never changed, so no push fired and the browser tab was the only
   *  witness. Still a claim about the flow — never a token, never an id. */
  reason?: string
}

export interface AccountLoginResult {
  ok: boolean
  /** A human sentence when a login could not even START (no keychain, not wired). */
  reason?: string
}
