# 18 — Accounts, entitlements & hardening

> **Status: the book of the phase-accounts pack** (2026-07-16). Everything written
> here is SHIPPED and gated; what is not written here does not exist yet. Grounding:
> [ADR 0015](adr/0015-accounts-and-entitlements.md) (the stance) ·
> [ADR 0016](adr/0016-split-node-runtime.md) (the runtime split) · the 2026-07
> research set ([productization](research/2026-07-productization-accounts-subscriptions.md)
> · [hardening](research/2026-07-electron-hardening-and-enforcement.md) ·
> [anti-piracy](research/2026-07-anti-piracy-plan.md)). The composed proof is the
> **PRODMILESTONE** gate (§below) — one run of the whole promise on FAKE services,
> zero network. **Deliberately absent: code signing.** The certificates and the
> signing pipeline are the operator's deferred FINAL step, outside this pack; every
> claim below that leans on a signature says so explicitly.

## The custody stance (ADR 0015 §3, shipped)

Our account credential follows the vault's own law (8/08, ADR 0014), extended:

- the **access token** lives in memory only and is read at exactly one point —
  `accessTokenForEntitlement` in `src/main/account.ts`, the single decrypt-and-use
  site;
- the **refresh token** rests ONLY as `safeStorage` ciphertext (`vault.ts`); no OS
  keychain → no stored session, never plaintext at rest;
- the **DPoP private key** is the hardware device key (§below) — chip-resident,
  non-exportable, never in this process at all; on hardware-less machines it is the
  software fallback, as vault ciphertext, surfaced as custody `software`;
- **no IPC channel returns a token, by construction.** `account:status` carries
  identity + plan CLAIMS only; there is no getter shape to leak through. The ACCOUNT
  gate asserts the surface is closed (exactly status/login/logout/changed) and greps
  the plaintext out of every rest and result.

## The freemium boundary (ADR 0015 §2, shipped)

**The free local core needs no account and works fully offline — forever.** Gating
applies to PAID features only, through ONE port (`Entitlements` —
`src/contracts/entitlements/`): gate points ask `limit('maxPanes')` /
`allows(feature)`; tiers are DATA inside the signed claim, never hard-coded at the
gate. The Free baseline is deliberately generous (`FREE_ENTITLEMENTS`): 16 panes per
workspace (the full WebGL budget), 25 connections, 16 swarm roles per workspace
(the renderer cap and main's backstop share that per-workspace denominator — a
second workspace's roles are counted against its OWN manifest, never a global
tally), 10 saved SSH hosts — today's numbers change nothing an account-less install
could already do. The
scriptable wedge (`mogging list/send/capture`, docs/06) is **ungated in every tier**,
and refusals are one honest sentence naming the plan and the line that was hit.

## The enforcement doctrine (ADR 0015 §5, restated wherever a check lives)

A local check is **UX, not security** — anything on the client is patchable, and no
section of this doc is allowed to imply otherwise. Real enforcement is exactly two
things: **(a) hardware binding** (the device key: a copied install is inert because
the chip does not copy) and **(b) server-authoritative value** (subscription state
lives with the issuer; the client only fetches what the server says). Everything
else — fuses, bytecode, watermark, tamper check — raises floors, attributes leaks,
or makes modification loud; §honest limits prices each one precisely.

## The account engine (`src/main/account.ts`, shipped)

Login is OAuth 2.1 **Authorization Code + PKCE(S256)** in the user's OWN browser
(`shell.openExternal` + an ephemeral `127.0.0.1` loopback, RFC 8252 — the machinery
Connections proved for ADR 0014). The app is a **public client**: no secret in the
bundle. Every token request carries a **DPoP proof (RFC 9449)** signed by the device
key, with the AS nonce dance; entitlement fetches bind the proof to the presented
token (`ath`). Refresh is serialized, and rotation persists the new refresh token on
every renewal. Two laws the composed milestone forced into writing:

- **Unreachable is not rejected — and neither is a struggling AS.** A refresh that
  cannot reach the AS (offline, outage, DNS), or that reaches an AS answering **5xx /
  429** (or a twice-rotated DPoP nonce), yields no token but KEEPS the session — only
  a definitive 4xx OAuth answer (`invalid_grant`-class, RFC 6749 §5.2) ends it. A
  load-balancer 503 during an AS deploy must never sign users out. The same
  distinction holds for the device key: a key store that ERRORS (a TPM after
  sleep/resume) reads as *unavailable — retry later*, never as *no key* — refresh
  keeps the session, and login refuses with a reason instead of silently minting a
  software key on a chip machine.
- **The browser page tells the truth, and a failure reaches the app.** The loopback
  page renders AFTER the token exchange (success or failure, whichever happened), a
  grant with no refresh token is refused (a phantom session — access working in
  memory under an anon status — is worse than a clean retry), and a post-consent
  failure pushes ONE transient human sentence over `account:changed`
  (`AccountStatus.reason`, push-only, never stored) that Settings toasts.
- **Identity claims are verified, never just decoded.** The id_token is checked
  against the AS's published JWKS (OIDC Core §3.1.3.7): signature with the alg
  allowlisted to ES256/RS256 and the key TYPE required to match (RFC 8725 — no
  `none`, no key confusion), then `iss`/`aud`/`exp`. The claims are display identity
  only (authorization never derives from them), so reachability follows the
  resilience law: an unreachable JWKS costs the claims, not the login; a
  PRESENT-but-INVALID token is a tamper signal — login refuses outright, refresh
  simply declines to update the stored claims (ending a paying session over an
  ancillary token is the overreaction the 5xx law exists to prevent).
- **Logout returns the machine to anon-Free in one gesture — here AND at the AS.**
  An explicit logout also drops the cached entitlement (the one door that does — a
  session that dies UNDER us leaves the cache in place, because the device-mismatch
  story and its telemetry read it), and best-effort-revokes the forgotten grant at
  the AS (RFC 7009, fire-and-forget by design: logout stays instant and offline-safe;
  rotation + reuse detection remain the backstop when it misses). A fresh LOGIN is
  the mirror image: it bumps the same epochs, so an in-flight refresh or claim-fetch
  from the PREVIOUS session can never re-vault over the new one.

In production neither the IdP nor the issuer is wired yet (`config === null` — the
reserved origins land in `origins.ts` when the operator stands the services up);
login says so honestly, and the FAKE IdP drives every gate. Zero network in any
smoke, ever.

## The entitlement engine (`src/main/entitlements.ts`, shipped)

An entitlement is a **signed claim this process verifies locally** — never a boolean
the UI trusts, never a server answer taken at face value:

- Ed25519 signature against the **public key pinned in
  `src/backend/core/origins.ts`** (an in-code literal; never env, never fetched),
  with **`alg` AND `typ` (`entitle+jwt`) pinned** (RFC 8725 — no other JWT that ever
  shares the key can be replayed as an entitlement); tampered / wrong-key /
  expired-at-fetch tokens are treated as ABSENT (→ Free);
- the verified claim caches as vault ciphertext and is **re-verified on every
  load** — ciphertext at rest does not exempt it;
- the claim is **sender-constrained to this machine**: the issuer binds `deviceId`
  (the device key's RFC 7638 thumbprint, attested by the DPoP proof at issuance)
  and the engine honors a claim only when it matches THIS device; the fetch itself
  runs the **RS-side DPoP nonce dance** (RFC 9449 §8.2 — one 401 + `DPoP-Nonce`
  challenge, one retry), so an issuer that requires nonces cannot strand clients;
- paid FEATURES are **additive over the Free baseline** (set union); paid LIMITS
  replace per name, and "a plan can only widen" (ADR 0015 §2) is the **issuer's
  contract** — deliberately not clamped client-side, so fixture claims can carry
  numbers small enough for the gates to visibly bite;
- every degradation **names its cause**: the snapshot's `reason`
  (`grace_expired · device_mismatch · revoked · tampered`, a closed claims-only
  enum) is what the account panel's one quiet line renders — no second source of
  truth, nothing that could carry a path or an id.

Refresh has **three triggers**: the renderer's first snapshot pull (mount), a
successful **login** (the plan a user just signed in for lands now, not at the next
launch — an epoch bump also drops any in-flight fetch from the previous session), and
a **6-hour cadence** (the updater's own pattern) that re-derives the snapshot — so a
grace boundary crossed by pure time still pushes — and refetches when the claim is
stale-ish. An app that stays open for weeks on an online machine keeps its plan.

## The offline-grace law (ADR 0015 §4, shipped)

A cached entitlement is honored for a grace window past its **last successful
fetch** — the shipped figure is **14 days** (the ADR fixes the final number inside
7–30 when the service ships) — then the app **degrades to Free; it never bricks**.
Grace is CACHE aging, not an issuer state: pull the network and the math carries on.
The anchor is believed only within a day of skew: a fetch stamp from the **future**
(a wound-back clock — the engine only ever writes `fetchedAt = now`) reads as
expired rather than extending grace without bound, and heals by itself when the
clock (or the next successful fetch) does.
Degradation is quiet (one honest line in Settings › Account, no nag ladder, no
countdown), and past the window the entire free core keeps working. There is no kill
switch and no launch blocked on a server; server-side revocation is honored on the
next refresh (`revoked` claim → Free) — **no remote detonation of a running app**.

## The merchant-of-record boundary (shipped as the FAKE contract)

Subscription state is **server value** (§doctrine): nobody is Pro until the MoR's
webhook tells the issuer so. The FAKE MoR
(`src/backend/features/account/fake-entitle.ts` § `/mor/webhook`) pins the contract
the operator's real pair must keep, in the full Stripe shape and in this order:
**timestamped HMAC over the raw body** (`mor-signature: t=<unixSec>,v1=<hex
hmac-sha256 over "<t>.<rawBody>">`) verified BEFORE any state change, then a
**±5-minute timestamp tolerance** (a captured delivery replayed later dies here),
then **event-id idempotency** (redeliveries — the MoR retries for days — ack 200
and flip NOTHING, so an old `activated` can never resurrect a canceled
subscription), and only then the state change. A forged delivery is refused and
flips nothing — faking the webhook is exactly the crack the signature exists to
stop; PRODMILESTONE proves the forged, replayed, and genuine cases each behave. The
real IdP, MoR and entitlement issuer are the **operator's later wiring**; nothing in
this repo names them, and ORIGINPIN keeps their future origins out of the
environment's reach.

## Settings › Account (`src/ui/features/settings/account.ts`, shipped)

The one surface that says who is signed in and what plan this install actually
runs — claims only, live over `account:changed` / `entitlements:changed`. The plan
badge states the ENGINE's answer (an IdP plan claim is marketing until a signed
claim backs it). At most ONE quiet line ever explains a degraded plan, keyed off
the snapshot's `reason`; the free core is never described as at risk, because it
never is. Sign-in runs in the user's own browser and the button copy says so. I7:
the panel is CONSTRUCTED at boot with the settings shell but fires **no IPC there** —
it paints the anon/Free default synchronously and pulls live status only when
Settings is entered (or a push arrives), so nothing new touches the boot path.

## The composed proof — PRODMILESTONE (shipped 2026-07-16)

`MOGGING_PRODMILESTONE` (verdict `out/prodmilestone-result.json`) is **the
authority on "phase-accounts done"**: ONE run, on FAKE services only (loopback
in-process IdP + MoR/issuer + fixture integrity manifest — zero network, zero
vendor CLIs), proving in journey order: the anon FREE app opens offline and the
`mogging` wedge works → PKCE login (authed ≠ paid) → a signed MoR webhook (forged
one refused) activates the subscription server-side → a device-bound, watermarked
Pro claim lands and a previously-capped feature unlocks → network pulled: Pro holds
through grace (and the session survives the outage), then degrades to Free, never
bricking → the same vault as a DIFFERENT device reads Free and cannot re-license →
a tampered build withholds Pro while the free app runs → logout returns to
anon-free with the wedge untouched — with **both budgets measured on the composed
surface** (16 panes + the account/entitlement machinery live). The Settings ›
Account panel is asserted along the way so the renderer's story cannot drift from
the engine's.

## Renderer lockdown (shipped 2026-07-15)

The window's CSP is tightened and main-window navigation is denied outright (the
missing deny the audit flagged) — the browser dock's `<webview>` keeps its own
partition and is unaffected. The **LOCKDOWN** gate (`out/lockdown-result.json`)
asserts the header, the nav guard, and that the dock still works.

## The hardware device key (shipped 2026-07-15)

The account's DPoP key (RFC 9449 — the key every token request must prove
possession of, and the key entitlements are sender-constrained to) is a
NON-EXPORTABLE key in the platform key store. The private half never exists in
our process: the app hands the chip a digest and gets a signature back
(`src/backend/platform/device-key/`, an in-repo N-API addon;
`dpop-key.ts` wraps it behind the same `DpopKey` interface the software key
used). At entitlement issuance the DPoP proof carries the device public key in
its header; the issuer binds `deviceId` (the key's RFC 7638 thumbprint) into
the signed claim, and `src/main/entitlements.ts` honors a claim only when that
`deviceId` matches THIS machine's key. The consequence — proven by the
**DEVICEKEY** gate (`out/devicekey-result.json`) — is that a copied install is
inert: the vault rides along (even plaintext-extracted by whoever is
redistributing it), the chip does not, so its refresh proofs sign with the
wrong key, the AS refuses them, no new entitlement can be issued to it, and the
cached one reads as Free on the foreign device.

Per-OS reality (`custody.backend`, surfaced on the key and in the gate verdict
— the claim is only ever as strong as this row says):

| OS | Backend | What it actually is |
|---|---|---|
| Windows, TPM present | `tpm` | CNG **Platform Crypto Provider** — the key is TPM-resident; `NCryptExportKey` on the private half is refused by the provider (the key is finalized without the export flag). |
| Windows, no TPM | `cng` | The Microsoft **software** KSP: still non-exportable by provider policy and DPAPI-protected at rest, but NOT hardware — machine-bound in practice, not chip-bound. |
| macOS | `secure-enclave` | `kSecAttrTokenIDSecureEnclave` — enclave-resident; `SecKeyCopyExternalRepresentation` on the private key always fails. Requires a signed build with a usable data-protection keychain; an unsigned dev run or a SEP-less VM falls through to `software`, and says so. |
| Linux (and any hardware-less fall-through) | `software` | The step-05 software key, persisted as `safeStorage` ciphertext. **Honest downgrade** (the vault's own `basic_text` precedent): the key IS extractable by anything that can read the vault, so device binding here is only as strong as the OS keyring. TPM 2.0 support (tpm2-tss) is future work, deliberately not faked in the meantime. |

The addon joins node-pty/better-sqlite3 in `src/main/native-preflight.ts` (a
missing/broken build refuses to boot, with the fix named) and in the rebuild
set (`npm run rebuild:native`; postinstall builds it too). It is pure Node-API,
so Electron ABI bumps do not stale it. Packaged builds carry it as an
`extraResources` file — like the asarUnpack set, it sits outside `app.asar`
and is covered by the bundle signature, not the integrity fuse. All key
operations are async end to end and run only post-boot, on demand (invariant
I7): the chip can take hundreds of milliseconds and never blocks the main
thread or the boot path.

## The Electron fuse wall (shipped 2026-07-15)

Fuses are booleans burned into the packaged Electron binary at pack time
(`electronFuses` in `electron-builder.yml`). Dev (`npm run dev`) is untouched —
the wall exists only in the artifact. The **FUSES** gate
(`scripts/check-fuses.mjs`) reads the wall off the packaged binary and fails on
any drift; it also proves the integrity fuse bites by flipping one byte of
`app.asar` and requiring the launch to die on the integrity fatal
(sabotage-and-revert). It runs in the local sweep (packages itself), in CI after
the `linux-boot` and `signing-dryrun` packaging steps, and in `release.yml`
before anything uploads. Verdict: `out/fuses-result.json`.

| Fuse | State | Why |
|---|---|---|
| `runAsNode` | **OFF (the runtime split's prize)** | The signed binary can no longer be run as a generic Node interpreter — the macOS keychain-theft vector and the cracker's bundled-Node lever are gone. The three consumers that made this load-bearing (the detached PTY daemon, the house MCP server, every `mogging` shim) now run on the standalone helper (ADR 0016, §below); SURVIVE + CONTROL + RUNTIMESPLIT prove them on that host, and re-enabling the fuse is the drift `check-fuses.mjs` refuses. |
| `enableCookieEncryption` | ON | Cookie store encrypted with OS crypto instead of plaintext sqlite. One-way. |
| `enableNodeOptionsEnvironmentVariable` | OFF | The packaged binary ignores `NODE_OPTIONS` / `NODE_EXTRA_CA_CERTS` — the classic code-injection lever into a signed process. No production path reads either (the agent-settings catalog's `NODE_EXTRA_CA_CERTS` entry configures the *CLIs'* own child processes, which are separate node binaries these fuses do not govern). |
| `enableNodeCliInspectArguments` | OFF | `--inspect` / `--inspect-brk` / `SIGUSR1` refused — no debugger attaches to a shipped process. |
| `enableEmbeddedAsarIntegrityValidation` | ON | A hand-edited `app.asar` refuses to load: electron-builder embeds the asar header hash into the executable and Electron validates it at boot, before one line of app code runs. Measured bite: FATAL exit in ~170 ms. |
| `onlyLoadAppFromAsar` | ON | `app.asar` is the *only* code-load path, so the validated archive cannot be bypassed by dropping an `app/` directory beside it. |

## V8 bytecode for the main process (shipped 2026-07-15)

The shipped main process is V8 bytecode, not readable JavaScript: `build.bytecode`
in `electron.vite.config.ts` (main block only) compiles the `index` chunk to
`out/main/index.jsc` at `npm run build`, leaving `index.js` as a three-line loader
stub so no downstream path (`package.json` `main`, the electron-builder globs)
moves. **The daemon is the deliberate exception since the runtime split**
(`chunkAlias: ['index']`, ADR 0016): `.jsc` is bound to the exact V8 that compiled
it — Electron's — and the daemon now runs on the standalone helper's Node, so
`daemon.js` and the chunks it requires ship as plain JS, asserted in both
directions by the BYTECODE gate. Dev is untouched — the plugin is inert under
`serve`, so every sweep gate runs the same plain-JS graph it always did. What
this buys, said precisely: the cost of READING the *index* code rises from "open
an editor" to "reverse V8 bytecode." **Friction, not a wall** — never describe
it as security.

Because bytecode hides logic but NOT strings (V8 keeps string literals readable
in the constant pool), the pinned entitlement verify key and the origin table are
additionally rewritten to `String.fromCharCode` (`protectedStrings`, values
imported straight from `src/backend/core/origins.ts` so the list cannot drift).
That makes them harder to *locate*, not secret.

Bytecode is bound to the exact V8 version **and CPU arch** that compiled it, so
each build-matrix row (win-x64, mac-arm64, linux-x64) compiles its own `.jsc`
with its own local Electron; one arch's `out/` must never be packaged into
another arch's artifact. The **BYTECODE** gate (`scripts/check-bytecode.mjs`;
verdict `out/bytecode-result.json`) builds itself and asserts all three
promises: `out/main` ships bytecode that this Electron's V8 actually accepts
(loader accept-path validation plus an executed risky-constructs fixture), the
preload ships as readable source with `sandbox: true` intact — preload bytecode
would force `sandbox: false`, a real hardening win we refuse to trade for a
deterrent — and the pinned constants grep nowhere in the shipped main bundle.
It runs in the local sweep, on every CI build-matrix row, and in `release.yml`
between the build and electron-builder, so what packages is what was verified.

## Forensic activation watermark (shipped 2026-07-16)

The software analog of per-recipient forensic watermarking, for LEAK ATTRIBUTION.
At activation the operator's entitlement issuer binds a per-ACCOUNT fingerprint
into the signed entitlement claim, so a leaked activation record points back to
the account it was issued to (`src/backend/features/account/watermark.ts` is the
pure codec both the issuer and the operator trace tool share). The mark rides
**two independent benign carriers** so one surviving copy is enough to attribute:

| Carrier | What it is | On its own |
|---|---|---|
| `wm` (primary) | a recoverable, checksummed encoding of the account id in a single signed field | yields the EXACT account id |
| `wmk` (redundant) | a fixed vocabulary of benign tokens whose stable ORDER (its Lehmer index) encodes a ~15-bit fingerprint of the account id | ATTRIBUTES against a known-account set; corroborates `wm` |

The account id is the subject and the ONLY payload — **ID only, never a
credential, never terminal content** (invariant I6, ADR 0002/0005). Anti-forgery
is the entitlement JWT's own Ed25519 signature: a carrier edited to frame another
account invalidates the whole claim, so `src/main/entitlements.ts` treats it as
absent (→ Free). The operator recovers the account with
`node scripts/trace-watermark.mjs <record.json> [--accounts a,b,c]`. The
**WATERMARK** gate (`out/watermark-result.json`) proves the round-trip: a
watermarked activation traces to its exact account through the real trace tool
(primary carrier, and the redundant carrier when the primary is stripped), and
the tool refuses to attribute to an account it was never given.

## The runtime tamper self-check (shipped 2026-07-16)

Post-paint (never the boot critical path — invariant I7), the app verifies its
own integrity signal and the unpacked `bin/` shims against a SIGNED manifest
(`src/main/native-preflight.ts`). On a mismatch it sets an entitlements
`tampered` flag that makes `entitlements.allows()` withhold PAID features — while
the **FREE app keeps running fully** (invariant I2: never a brick, the free tier
is never withheld). Fixing the build clears the flag on the next check; it is a
revocation trigger, not a one-way kill. The manifest + verify key are the
operator's wiring (like the entitlement issuer): production ships them, the gate
injects fixtures as parameters (never the environment — ORIGINPIN). Until wired,
the check is inert (no manifest → no-op → zero boot cost).

A modified build (and the copied-install `device_mismatch` case) emits a
**boolean** piracy signal through the opt-in Telemetry port (`build.modified`,
`entitlement.device_mismatch`) so piracy RATE is measurable and abused licenses
can be revoked server-side. No path, no filename, no id beyond the account the
authed session already knows (ADR 0005). Server-side revocation is honored on the
next entitlement refresh — a `revoked` claim degrades to Free; there is **no
remote detonation of a running app**, revocation latency is the entitlement TTL
(step 05).

## The runtime split (shipped 2026-07-16)

Everything that used to re-run the Electron binary as Node
(`ELECTRON_RUN_AS_NODE=1`) — the detached PTY daemon (ADR 0006), the house MCP
server, every `mogging`/`mogging-connection` shim — now runs on a **bundled
standalone Node helper**: a pinned official Node binary + its own
helper-ABI `node-pty`/`better-sqlite3` at `resources/node-helper/`
(`scripts/build-node-helper.mjs`; ADR 0016 has the full design). That is what
earned flipping `runAsNode` OFF above. Proven live, not assumed: **SURVIVE**
(pane survives an app quit/relaunch *and* the daemon pid's OS process image is
the helper), **CONTROL** (the whole `mogging` control API through the helper),
and **RUNTIMESPLIT** (`out/runtimesplit-result.json`: helper present, daemon on
it, house MCP answers a real initialize under it, shims env-free, the flip
declared) — release.yml runs exactly these three on every OS row and blocks on
any red. Residual, stated plainly: the helper is still a Node interpreter — but
a GUI-less, no-Keychain-entitlement, no-app-identity one; running script under
it grants nothing a stock Node download doesn't.

## The standards profile (what this lane conforms to, and where)

| Standard | Where it lives | Notes |
|---|---|---|
| OAuth 2.1 (draft) / RFC 6749 | `src/main/account.ts` | Authorization Code only — no implicit, no ROPC; public client (no secret in the bundle); §5.2 error semantics drive the transient/definitive session law (5xx/429 keep the session, only a 4xx OAuth answer ends it). |
| RFC 7636 PKCE | `createPkce` (integrations/oauth.ts) | S256 only; 32-byte verifier (256-bit entropy, the spec's 43-char shape); the FAKE AS refuses non-S256, so a downgrade cannot pass a gate. |
| RFC 8252 native apps | `login()` | Consent in the SYSTEM browser (`shell.openExternal`, never an embedded view); ephemeral `127.0.0.1` loopback redirect; `state` = 128-bit CSRF nonce. |
| RFC 8707 resource indicators | authorize + token + refresh requests | The token is bound to the entitlement API audience — minted for us, replayable nowhere else. |
| RFC 9449 DPoP | dpop-key.ts + account.ts + entitlements.ts | Proofs on every token request (§8 AS nonce dance) AND on the entitlement fetch (`ath` binding, §8.2 RS nonce dance); both dances ENFORCED by the FAKEs so the retry paths stay live under every gate. |
| RFC 7638 JWK thumbprint | `jktOfPublicJwk` | The `deviceId` the issuer binds and the engine enforces — the hardware-binding pivot. |
| RFC 7009 revocation | `logout()` | Best-effort, fire-and-forget (logout stays instant + offline-safe); the ACCOUNT gate asserts the AS actually saw it. |
| OIDC Core §3.1.3.7 | `verifyIdToken` (account.ts) | id_token claims believed only after JWKS signature + `iss`/`aud`/`exp`; verified-or-absent for reachability, invalid refuses the login (the gate proves it bites). |
| RFC 7519/7515/8037 (JWT/JWS/EdDSA) | entitlements.ts verifier | Ed25519 against the PINNED key (never fetched, never env); closed, typed claim shape; expiry judged by the grace law. |
| RFC 8725 JWT BCP | both verifiers | Explicit alg allowlists, `typ` pinning (`entitle+jwt`), key-type/alg match on JWKS keys, no `none`, no unverified decode anywhere in the lane. |
| Webhook signing (the Stripe contract) | fake-entitle `/mor/webhook` | `t=,v1=` HMAC-SHA256 over `<t>.<rawBody>`, ±5-min tolerance, event-id idempotency, timing-safe compare — verified before any state change. |
| RFC 8032 / FIPS 186-4 crypto | device-key addon + signers | Ed25519 (entitlement signatures), ECDSA P-256 (DPoP — TPM / Secure-Enclave resident where the machine has one). |

Deliberately the operator's wiring, recorded so nothing is silently skipped: **RFC
8414** discovery of the real IdP (config is injected today; discover-then-pin when it
exists), **`iss`/`aud` inside the entitlement JWT** (pinnable only once the real
issuer's identifiers exist — the verifier tolerates the extra claims already),
**RS-side DPoP `jti` replay tracking** (a server-side concern the real issuer owns),
and **RFC 9207** (`iss` on the authorization response — a mix-up defense that matters
only if a second AS ever exists; the client is single-AS by construction today).

## Honest limits (read before claiming anything)

- **The asarUnpack set is NOT hashed.** `node-pty`, `better-sqlite3`,
  `bin/**` (the CLI shims and the MCP/connection bridges), the daemon graph
  (`out/main/daemon.js` + chunks — plain node reads no asar), and the
  `node-helper/` resources live outside `app.asar` (`electron-builder.yml`
  `asarUnpack`/`extraResources`) because they must load / spawn from real files.
  The integrity fuse does not cover them. They are covered only
  by the bundle code **signature** — the operator's later, deferred step (on
  macOS the helper must be signed as nested code). Until
  signing lands, the unpacked files are the honest gap; do not let "ASAR
  integrity on" imply otherwise.
- **Linux does not enforce ASAR integrity.** The fuse is set (the wall reads
  identically on all three OSes) but Electron enforces it on macOS and Windows
  only. The FUSES gate's tamper proof self-skips on Linux and says so.
- **Fuses are tamper *evidence*, not tamper *proofing*.** A cracked copy can
  re-flip fuses with the same public tooling. The wall raises the floor
  (no env/flag injection into legitimate installs, integrity + signature
  mismatches become loud); real teeth are the ADR 0015 §5 kind — hardware
  binding and server-side value.
- **Bytecode is a speed bump, and string obfuscation is a game of
  hide-and-seek.** Public tooling decompiles V8 bytecode back to rough
  pseudo-JS; do not oversell this internally as anything past deterrence.
  The `protectedStrings` rewrite covers exact string *literals* only:
  object-literal **keys** (the Free limits table's `maxPanes:` etc.) stay
  readable in the `.jsc` constant pool, and the renderer bundle keeps its own
  plain-text copies of everything in `@contracts`. The BYTECODE gate therefore
  asserts non-greppability only for the verify key and the origin table — the
  two values whose *location* is worth hiding — never for the limit names.
- **Main-process crash symbolication changed shape.** Bytecode frames report
  `index.jsc` positions (they map to the pre-compile `out/main/index.js` text);
  the Sentry sourcemap upload is keyed to `index.js`, so main stacks may need
  that one-step manual mapping until the upload learns the `.jsc` alias.
- **The watermark AND the tamper check are evidence, not prevention.** A fork
  that KNOWS the watermark scheme can strip both carriers; a patched build can
  strip the very self-check that sets `tampered`. Neither stops a determined
  cracker — they make a leak ATTRIBUTABLE and a modified build
  SELF-INCRIMINATING (a boolean telemetry signal + a server-side revocation
  trigger), which is a different and honest goal. Real teeth remain the ADR 0015
  §5 kind: hardware binding and server-side value. Do not oversell either as a
  wall.
- **The tamper check's redundant watermark carrier attributes, it does not
  reconstruct.** The `wmk` ordering encodes a ~15-bit fingerprint, so on its own
  it can only match an account out of a KNOWN set (a hash collision across a very
  large tenant base is possible in principle) — it is corroboration and a
  fallback, not a second full copy of the id. Exact extraction is the primary
  `wm` carrier's job.
