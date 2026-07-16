# ADR 0015 — Accounts & entitlements: the stance before the feature

- **Status:** Accepted (2026-07-15)
- **Amends:** one sentence of [ADR 0014](0014-app-held-service-connections.md) ("What
  this does not change") — see §Amendment below. Nothing else of 0014 moves.
- **Does NOT touch:** [ADR 0002](0002-never-broker-provider-auth.md). It stands
  **verbatim, entirely and without qualification** — it is the first thing a reader
  will worry about here, so it is restated first, below.

## Context

The product is going paid (the 2026-07 research set:
[productization](../research/2026-07-productization-accounts-subscriptions.md),
[anti-piracy](../research/2026-07-anti-piracy-plan.md),
[hardening](../research/2026-07-electron-hardening-and-enforcement.md)). That means a
MoggingLabs account, a MoggingLabs server, and an entitlement check will exist — three
things every positioning sentence to date said would never exist.

Writing the login button first would be building on sand. What has to exist first is
the **doctrine**: which lines the paid tier may never cross, stated as law while there
is still zero account code to argue with. And one **prerequisite bug**: the audit
flagged that `MOGGING_REGISTRY_BASE` (an environment variable) could repoint where a
shipped, signed build fetched the integrations registry. For a community feed that is
harmless. As a *pattern* it is fatal — `MOGGING_ENTITLE_BASE=https://attacker/always-pro`
is a licensing bypass on the day an entitlement endpoint exists. The door closes now,
before there is anything valuable behind it.

## Decision

### 1. Our account is OUR credential — never a brokered provider login

ADR 0002 stands verbatim. Claude, Codex and Gemini still authenticate **themselves**,
against the user's own accounts, and no provider token ever enters this process. A
MoggingLabs account authenticates the user **to MoggingLabs** — for entitlements,
nothing else. It is a first-party credential in the exact sense a Sentry grant
(ADR 0014) is a third-party one: ours to hold, never a pass-through. The two worlds
never mix: no provider credential is ever handled, observed, or proxied because an
account exists.

### 2. The freemium boundary

**The free local core needs no account and works fully offline — forever.** Gating
applies to PAID features only. Wedge pillar (b)
([docs/00](../00-vision-and-positioning.md)) is not softened by the paid tier; it is
*scoped* by it: everything that made the product worth using without paying stays
usable without paying, without logging in, and without a network. An account
requirement on the free path is **forbidden** — not discouraged, forbidden, the way
0002 forbids brokering.

### 3. Custody

Our tokens follow the discipline the vault already follows (8/08, extended by
ADR 0014): they rest **only** as `safeStorage` ciphertext or in memory, they are
decrypted at exactly one point — the moment one is attached to an outbound request —
and **no IPC channel returns a token**, by construction (the write-only discipline).
A token *getter* on any channel is forbidden. No keychain → no stored session, rather
than plaintext at rest.

### 4. The offline-grace law

A cached entitlement is honored for a grace window of **7–30 days past its last
successful fetch** (the exact figure inside that range is fixed when the entitlement
service ships), then the app **degrades to Free — it never bricks**. A paying user on
a plane, behind a proxy, or during our outage keeps what they paid for through the
window and keeps the entire free core after it. There is no kill switch, no
phone-home-or-die, no launch blocked on a server. Degradation is also **quiet**: one
honest line, not a nag ladder.

### 5. Enforcement honesty

Local checks are **UX, not security**. A cracked build can flip any local boolean;
pretending otherwise buys obfuscation snake-oil and angry-legitimate-user bugs. The
real teeth are (a) **hardware binding** of the entitlement to the machine and (b)
**server-side value** — things a copy of the binary simply does not have. We build
local checks to be honest and cheap, and we spend the effort where it works.

### 6. Origin pinning (the prerequisite, landed with this ADR)

Every remote origin a shipped build talks to is an **in-code constant** in
`src/backend/core/origins.ts` — a single `Object.freeze`d table, decided at build
time. **No environment variable may repoint one.** `MOGGING_REGISTRY_BASE` is removed
from the codebase; the reserved names `MOGGING_ENTITLE_BASE`, `MOGGING_IDP_BASE` and
`MOGGING_UPDATE_BASE` are banned from the production artifact *before they ever
exist*, on the same banlist that keeps the test harness out of the shipped bundle
(`scripts/check-prod-artifact.mjs`). A test that needs a fixture server injects a
`baseUrl` parameter at the call site; nothing reads the environment. The **ORIGINPIN**
static gate (`scripts/check-originpin.mjs`) holds all of this in place.

### 7. Tamper evidence: the Electron fuse wall (landed 2026-07-15)

A packaged build ships with the four SAFE fuses flipped and ASAR integrity embedded
(`electronFuses` in `electron-builder.yml`; asserted on the artifact by the **FUSES**
gate, `scripts/check-fuses.mjs`): cookie encryption ON, `NODE_OPTIONS` /
`NODE_EXTRA_CA_CERTS` ignored, `--inspect` refused, a hand-edited `app.asar` refuses
to load, and `app.asar` is the only place code loads from. `runAsNode` stays **ON** —
it is load-bearing (the detached PTY daemon, the house MCP server, and the `mogging`
CLI shims all re-run our binary as Node) and step 09's runtime split earns that flip.

**The asarUnpack caveat, stated plainly:** the unpacked set — `node-pty`,
`better-sqlite3`, and `bin/**` (the CLI shims and the MCP/connection bridges) — lives
*outside* `app.asar` and is **NOT covered by the integrity fuse**. Those files are
covered only by the bundle code **signature**, which is the operator's later, deferred
step. "ASAR integrity on" must never be read as "the shims are hashed"; until signing
lands, the unpacked files are the honest gap. Also honest: Electron enforces ASAR
integrity on macOS and Windows only — on Linux the fuse is set but inert.

## Explicitly forbidden

Stated as a list because each is the kind of "small exception" that arrives politely:

- **Any account requirement on the free path.** No login wall, no account-gated core
  feature, no offline degradation below Free.
- **Any provider-credential handling.** No provider token, cookie, or session ever
  enters this process — an account changes nothing about ADR 0002.
- **A token getter on any IPC channel.** Write-only custody is the contract; a
  "just for debugging" reader is the breach.
- **An env-readable origin.** The catalog, entitlement, IdP and update origins live in
  `origins.ts` or they do not ship.

## Rationale

- **Stance-first, code-second.** Every ADR in this repo that guards a boundary
  (0002, 0008, 0014) was cheapest to enforce when written *before* the tempting code
  existed. The paid tier's temptations — "just check the license at launch", "just
  proxy the provider for Pro users", "just let support read the token" — are all
  pre-refused here, in writing, with gates.
- **The grace window is where trust is won or lost.** Products that brick offline
  users convert their most loyal customers into crack-seekers. Degrading to a fully
  working Free tier makes piracy pointless for the core and keeps the paid pitch
  about *value*, not hostage-taking.
- **Honesty about enforcement is a feature.** The wording gate exists because false
  security claims cost more trust than they buy (finding 27). The same law applies to
  DRM theater.

## What this does not change

- **ADR 0002, verbatim.** We never store, proxy, pool, resell, or meter a provider
  login or provider usage. The CLIs authenticate themselves. "Your keys, your CLIs"
  stays true in every tier, free or paid.
- **ADR 0014's design.** App-held *service* connections are unrelated to our account
  and keep working accountless, in the free tier.
- **The daemon and its protocol** (v9), the IPC surface, and the per-CLI route — no
  account code, no UI, and no new dependency ships with this ADR. This document plus
  the origin pin *is* the deliverable.

## Amendment to ADR 0014

ADR 0014's closing paragraph of "What this does not change" made an unconditional
claim — true when accepted — that this ADR makes conditional: that MoggingLabs runs no
server and takes no money. That sentence is rewritten in place with a pointer here.
The durable half ("your keys, your CLIs") survives untouched; the absolute half
retires, because the positioning copy it anchored is exactly the kind of remembered
sentence that gets re-typed after it stops being true (the ADR 0014 lesson, §wording
gate).

## Consequences

- **Copy retires the absolutes.** The README tagline, docs/00's one-line positioning
  and non-goals row, `package.json`'s description, and Settings § About drop the
  claims a paid tier falsifies. "Your keys, your CLIs" stays.
- **The wording gate grew four patterns** (`scripts/check-credential-wording.mjs`):
  the retired tagline's absolute half, ADR 0002's rationale shape, the
  no-first-party-server claim, and docs/00's non-goals shape — with pinned, reasoned
  exceptions for the two dated records that legitimately keep the words (ADR 0002
  itself, and the research doc that inventoried the claims in order to retire them).
- **The prod-artifact banlist grew four names** — one real (`MOGGING_REGISTRY_BASE`,
  now gone) and three reserved. A reintroduction fails the build.
- **ORIGINPIN joins the sweep** as a static gate: no `process.env.MOGGING_*_BASE`
  read anywhere in `src/`, `origins.ts` frozen and sole origin source, and a
  sabotage-and-revert proof that the banlist and the wording gate still bite.
- **FUSES joins the sweep** (§7): the exact fuse wall read off a packaged artifact,
  plus the tampered-asar refusal proof; the same gate runs against the packaged
  byproducts in CI (`linux-boot`, `signing-dryrun`) and blocks a drifted release
  before upload (`release.yml`). See [docs/18](../18-accounts.md).
- **When the account ships**, its ADR must cite this one and satisfy every stance
  above — this document is the checklist its review runs against.
