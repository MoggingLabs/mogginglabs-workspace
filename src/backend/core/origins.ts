// The origin pin (ADR 0016). Every remote origin a SHIPPED build talks to lives in
// this one frozen table, as an in-code literal decided at build time.
//
// It exists because of the bypass it closes: the REGISTRY `_BASE` env override let an
// environment variable repoint the integrations catalog's registry fetch inside a
// real, signed install. Harmless for a community feed — fatal as a PATTERN, because
// the same shape (`…_ENTITLE_BASE=https://attacker/always-pro`) is a licensing
// bypass the moment an entitlement endpoint exists. So the rule is absolute and
// pre-emptive: no environment read may choose where the app reaches a pinned
// origin (ORIGINPIN scans for the literal, comments included — hence the phrasing).
// A test that needs a fixture server injects a baseUrl PARAMETER at the
// call site (the mcpcat smoke's fixture registry does exactly this); nothing reads
// the environment.
//
// Enforced twice: scripts/check-originpin.mjs (this file is the only origin source,
// frozen, env-free) and scripts/check-prod-artifact.mjs (the real and reserved names
// are on its banlist, so the override pattern cannot come back one import at a time).
export const ORIGINS = Object.freeze({
  /** The official MCP registry — search + update FEED, never a trust source (8/07). */
  registry: 'https://registry.modelcontextprotocol.io',
  /** The package registries the brain reads library READMEs from (docs/20 organ 2).
   *  These sat in libfetch.ts as an environment read falling back to a literal — the
   *  exact bypass this table exists to forbid, and invisible to the gate because its
   *  pattern only caught names ending `_BASE` while those ended `_NPM` and `_PY`.
   *  Fetched README text is distilled into the brain and served to agents as context,
   *  so whoever picks the origin picks what the agents read. The smoke now injects a
   *  baseUrl PARAMETER through brainDebug(), which is the seam described above. */
  npmRegistry: 'https://registry.npmjs.org',
  pypi: 'https://pypi.org'
  // Reserved rows (ADR 0016): `entitlements`, `idp`, `updates` land HERE when those
  // services exist — as literals in this table, never behind an env read. Their
  // would-be override names (the ENTITLE / IDP / UPDATE `_BASE` variants) are already
  // banned from the shipped artifact by scripts/check-prod-artifact.mjs.
} as const)

// The entitlement TRUST ANCHOR (phase-accounts/05), pinned under the same law as the
// origin table: an in-code literal, decided at build time, never read from the
// environment and never fetched. A shipped build verifies entitlement JWTs against
// THIS Ed25519 public key and nothing else — so no config, env var, or downloaded
// document can point verification at an attacker's signer.
//
// The private half of this pair was generated once (2026-07-15) and DISCARDED: until
// the real MoggingLabs entitlement service exists (its signer replaces this constant
// at build time, the operator's step), no valid production entitlement CAN exist —
// which is correct, because production also has no issuer origin wired. Tests never
// touch this pin: the smoke injects its OWN fixture key as a call-site parameter,
// the same rule the fixture-registry baseUrl follows.
export const ENTITLEMENT_VERIFY_PUBKEY = Object.freeze({
  /** SPKI PEM, Ed25519. */
  ed25519Pem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAveVrhhghenYDUC1J1ESNZZx0/Mqm0VVfmpricjrUFCk=\n-----END PUBLIC KEY-----\n'
} as const)
