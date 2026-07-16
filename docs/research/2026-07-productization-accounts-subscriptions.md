# Productization research — accounts, subscriptions, entitlements, and Electron's limits

**Date:** 2026-07-15 · **Status:** research report, no code changed · **Scope:** what it takes
to sell MoggingLabs Workspace as a subscription product with accounts, plan-limited features,
and auth threaded through every component — plus an honest assessment of Electron as the
platform for that product.

> **Companion:** the deep hardening + anti-extraction + enforcement plan (how far we can push
> Electron's security, and the load-bearing `runAsNode` constraint) lives in
> [`2026-07-electron-hardening-and-enforcement.md`](2026-07-electron-hardening-and-enforcement.md).
> Read it alongside §5–6 here.

---

## 0. Executive summary

- **The good news is structural.** This codebase already contains ~80% of the security
  primitives a subscription product needs: a hardened renderer, an allowlisted typed IPC
  bridge, a token-authed local control plane, OS-keychain-only secret custody, and a
  production-grade OAuth 2.1 + PKCE flow (built for Connections) that is *exactly* the
  industry-standard login flow for a desktop app's own account system. The account work is
  mostly reuse, not invention.
- **The blocker is strategic, not technical.** "Free / local / **no account**" is pillar (b)
  of the documented wedge (docs/00-vision-and-positioning.md:35-37), the README tagline, and a
  stated non-goal ("No hosted/cloud backend, no credits, no account system", docs/00:56). The
  industry answer — and the recommendation here — is **freemium**: the local core stays free
  and account-free (the wedge survives, aimed straight at BridgeSpace's forced account +
  $16–80/mo), and an *optional* account unlocks paid tiers. Raycast and Warp both ship this
  shape.
- **Client-side gating is UX, not security.** An Electron asar is trivially extractable and
  patchable; every local entitlement check can be bypassed by a determined user. The industry
  consensus (Keygen's own guidance, and every indie desktop subscription) is to accept this
  for local features and put *real* enforcement only behind server-backed features. Plan
  accordingly: the durable moat is the paid features that need our server (team sync, shared
  policies), not the lock on local ones.
- **Before taking a single dollar:** code-signing certificates (config is already
  dry-run-READY; this is a secrets-only change), a real EULA (the current LICENSE grants *no
  right to use at all*), ToS + privacy policy, and closing the `MOGGING_REGISTRY_BASE` env
  override the audit flagged — that class of bug is fatal once an entitlement endpoint exists.
- **Rough budget:** ~$220/yr fixed (Apple $99 + Azure Trusted Signing ~$120) + a
  merchant-of-record's ~4–5% of revenue + $0–25/mo backend. Auth providers are free at launch
  scale (25k–50k users free on every major provider).
- **Rough timeline:** ~2–3 months of focused work to first paid signup, phased in §9.

---

## 1. The strategic conflict to resolve first

The pivot contradicts written commitments. These are the exact lines:

| Commitment | Where |
|---|---|
| "Free / open / local / no account" is wedge pillar (b) | docs/00-vision-and-positioning.md:35-37 |
| "Your keys, your CLIs — **no subscription to us**" | README.md:8, docs/00:44-45 |
| "No hosted/cloud backend, no credits, no account system" (non-goals) | docs/00:56 |
| "there is no MoggingLabs server, no account" | docs/adr/0014:141-142 |
| Phase 15 sandboxes must work "**without an account**" | docs/02-mvp-and-roadmap.md:397-403 |
| Monetization "must come from the app/experience, not from being an AI middleman" | docs/adr/0002:34-35 |

Two important clarifications:

1. **A MoggingLabs account does NOT violate ADR 0002.** That ADR is about *AI provider*
   credentials (Claude/Codex/Gemini). Our own account/billing token is our credential, not a
   brokered provider login. ADR 0014 already demonstrates the org can hold this distinction
   precisely. ADR 0002 even anticipates monetization "from the app/experience" — which is what
   a subscription is.
2. **The conflict is with pillar (b) and the non-goals, and it is resolvable** the way the
   category leaders resolved it:

   - **Raycast** — free tier is genuinely useful (not a trial); Pro at ~$8/mo unlocks
     unlimited AI + cloud sync; account via email magic link, required only when you opt into
     Pro-shaped features.
   - **Warp** — free + Pro/Business tiers; account model; the account requirement is its most
     common criticism, which is exactly the stick we currently beat BridgeSpace with.
   - **BridgeSpace (the competitor)** — account *required*, $16–80/mo. Its forced account is
     our marketing.

   **Recommendation: freemium.** Local core stays free and account-free forever (say so
   loudly — it *strengthens* the wedge). The account exists only for people who choose to pay.
   The alternative — account-required-for-everything — erases pillar (b), hands the wedge back
   to BridgeSpace, and requires rewriting the README, vision doc, and marketing site. That is
   a founder decision, but the evidence is one-sided.

**Docs that must change when this lands:** docs/00 non-goals, README tagline nuance ("the
core is free, local, account-free; Pro is optional"), a new **ADR 0016 — accounts &
entitlements** stating scope and custody rules, and `scripts/check-credential-wording.mjs`
grows patterns so old "no account, no server" absolutes don't creep back into copy that is no
longer unconditionally true (the gate already exists for exactly this failure mode,
docs/adr/0014:166-173).

---

## 2. What already exists (asset inventory)

The security foundation is unusually strong for a pre-revenue app. Verified in source:

| Asset | Evidence | Reuse for accounts |
|---|---|---|
| Hardened renderer: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, webview guests isolated | src/main/window.ts:45-57 | prerequisite, done |
| Single generic preload bridge, **allowlisted to typed contracts**; renderer can never reach arbitrary IPC | src/preload/index.ts:8-24 | new account channels auto-permit by adding to `AllChannels` — zero preload edits |
| ~207 IPC channels across 24 typed contract files | src/contracts/ipc/ | `account.ipc.ts` slots in beside them |
| Local control plane authed: 0600 endpoint file + random per-daemon token, `hello {v, token}` within ~3s or dropped; named pipe / unix socket, nothing on TCP | docs/06-control-api.md:44-59 | model for any new local surface |
| MCP writes behind per-workspace grants, default `'none'` | docs/06:83-93, src/main/tool-plan.ts | pattern for per-plan tool gating |
| **Vault**: safeStorage ciphertext only; Linux `basic_text` treated as *unavailable* → refuse; decrypt only at point of use; **no getter over any IPC channel** | src/main/vault.ts:13-52 | account tokens go here, same rules |
| **OAuth 2.1 + PKCE(S256) via system browser + ephemeral 127.0.0.1 loopback (RFC 8252), dynamic client registration (RFC 7591), serialized refresh-token rotation** | docs/adr/0014:36-49, 100-109; src/main/connections.ts | **this IS the login flow an account system needs** — the machinery exists and is battle-tested against 8 vendors |
| Deep-link scheme `mogging://` (+ `mogging-dev://`), validated payloads | src/main/deep-link.ts | optional auth-callback route (loopback is better; keep loopback) |
| Telemetry opt-in end-to-end, defaults OFF, DO_NOT_TRACK honored, anonymous `installId` exists | src/main/telemetry.ts:16-23, 64-80 | signup funnel + account identify (post-consent) |
| Auto-update: electron-updater on GitHub Releases, differential, feed-integrity CI step, lifecycle UX | electron-builder.yml:36-39, docs/10:84-129 | ship entitlement-aware builds fast |
| Signing/notarization **config-complete, secrets-pending** (`signing-dryrun` proves it) | docs/10:17-23, scripts/verify-signing-readiness.mjs | flip = buy certs, add secrets |
| winget + homebrew manifests staged, validation-green | packaging/, docs/10:131-155 | distribution day one |
| Audit culture: 42 findings remediated, 122+ gates, `npm audit` 0 vulns | AUDIT_REMEDIATION_REPORT_2026-07-13.md | entitlement gates get the same treatment |

**Gaps** (everything in §5.3): no account system, no backend of any kind, no entitlement
mechanism, unsigned builds (certs pending), no Electron fuses flipped, one open audit item
(`MOGGING_REGISTRY_BASE`), LICENSE grants no usage rights.

---

## 3. The industry-standard architecture (reference design)

### 3.1 Identity: OAuth 2.0/2.1 Authorization Code + PKCE in the system browser

The standard for native/desktop apps is settled (RFC 8252): open the **system browser** to
the IdP's hosted page, redirect back to an ephemeral `http://127.0.0.1:{port}` loopback
listener, exchange the code with PKCE (the app is a *public client* — no secret in the
bundle; ADR 0014 already internalized this). Store a device-bound **refresh token** (rotated
on each use) in the OS keychain; hold short-lived **access tokens** (15–60 min) in memory
only. This is byte-for-byte what `src/main/connections.ts` already does for third-party
services — pointed at our own IdP instead.

Provider options (verified July 2026):

| Provider | Free tier | Then | Notes |
|---|---|---|---|
| **Clerk** | 50,000 MRU (expanded Feb 2026) | ~$0.02/MAU | best DX; "retained users" metric is friendlier than MAU |
| **Auth0** | 25,000 MAU | ~$0.07/MAU | enterprise SSO story; priciest at scale |
| **Supabase Auth** | 50,000 MAU | ~$0.00325/MAU | cheapest; pairs with using Supabase as the whole backend (§3.4) |
| **WorkOS** | AuthKit free to 1M users | per-enterprise-connection pricing | aimed at SSO/enterprise; overkill at launch, right at Team tier |
| Self-rolled (email magic link + JWTs) | $0 | your time | viable — Raycast ships magic links — but you own resets, abuse, deliverability |

At our launch scale every option is effectively **free**; choose on DX + how much backend we
want to own. If the backend is Supabase anyway, Supabase Auth wins on integration; if we want
a polished hosted account portal with zero UI work, Clerk.

### 3.2 Billing: Merchant of Record vs. raw Stripe

Selling a desktop app worldwide means global sales tax/VAT/GST. Two shapes:

- **Merchant of Record (MoR)** — they are the seller of record, they handle *all* tax
  registration/remittance, refunds, fraud. You integrate a checkout link + webhooks.
- **Stripe Billing direct** — ~2.9% + 30¢ + Stripe Tax; **you** are the merchant and own tax
  registration in every jurisdiction that crosses thresholds. Wrong answer for a small team
  selling a $10/mo dev tool globally.

MoR landscape (verified July 2026):

| MoR | Fees | Notes |
|---|---|---|
| **Paddle** | 5% + $0.50 | most mature tax coverage (US states, EU/UK VAT, AU GST, parts of Asia); vets sellers |
| **Lemon Squeezy** | 5% + $0.50 | acquired by Stripe (2024); reports of slower shipping/support since; long-term direction unclear |
| **Polar.sh** | 4% + $0.40 | open-source, developer-first, Stripe rails underneath; newest — several 2026 indie roundups now default to it |
| **Creem** | 3.9% + $0.40 | newer still, indie-focused |

**Recommendation:** Polar or Paddle. Polar for fees + dev ergonomics + license-key/checkout
primitives aimed exactly at this use case; Paddle if maximum tax-jurisdiction maturity
matters more. Avoid betting on Lemon Squeezy mid-acquisition.

### 3.3 Entitlements: the standard loop

```
checkout (MoR-hosted page, opened in system browser)
   └─ webhook ──► backend: entitlements DB (account ⇄ plan ⇄ devices)
app login (PKCE) ──► access token
   └─ GET /entitlement ──► short-lived SIGNED entitlement JWT (Ed25519)
        claims: plan, features[], limits{}, deviceId, exp (24–72h)
app: verify signature LOCALLY with embedded PUBLIC key (no network on the hot path)
   ├─ cache ciphertext in vault (safeStorage)
   ├─ refresh opportunistically in background
   └─ offline grace: honor cached entitlement up to 7–30 days past fetch,
      then degrade to Free (never brick the local core)
```

Standard parameters across the industry: **offline grace 7–30 days** (Keygen and 10Duke both
document this pattern; cutting off exactly at `exp` punishes laptops on planes), **device
records** with a per-plan cap (3–5 typical; enforced server-side at issuance — the only place
it can be), **kill switch = refusal to re-issue** at next refresh, not a remote detonation.
Revocation latency equals entitlement TTL — that's the knob.

Build vs buy: **Keygen.sh** (fair-source, self-hostable, has Electron activation examples)
does licenses/activations/entitlements as a service. But since a webhook consumer + one
table + one signing endpoint is ~300 lines on any backend, and we need the backend anyway
for the account, **build it into the same small backend** and keep the dependency count at
zero-new-vendors beyond IdP + MoR.

### 3.4 The minimal backend

One boring service (Supabase project, or a small Fly/Railway app):

1. IdP callback/config (or Supabase Auth built in)
2. MoR webhook consumer (subscription created/updated/canceled → entitlements table)
3. `GET /entitlement` (authn: access token; returns signed entitlement JWT; registers/checks device)
4. Public JWKS (or pin the Ed25519 public key in the app; rotate via app update)

Nothing else. No proxying of AI traffic (ADR 0002 untouched), no terminal data ever
server-side (that's the privacy story AND the cost story).

---

## 4. Threading auth through every component of THIS app

The layer map (README:162-185, ADR 0004) makes this clean — the composition root pattern
means auth lands in few places and features consume a port:

| Component | What changes |
|---|---|
| **src/main/account.ts** (new) | The only holder of tokens. PKCE login via `shell.openExternal` + loopback (lift from connections.ts), refresh serialized via the same promise-map pattern (ADR 0014:100-109), tokens as vault ciphertext, decrypt at point of use, logout = delete ciphertext + best-effort server revoke. |
| **src/main/entitlements.ts** (new) | Fetches/caches/verifies the entitlement JWT (Ed25519 verify with pinned public key), owns offline-grace clock, exposes a typed snapshot: `{plan, features, limits, graceState}`. |
| **src/contracts/ipc/account.ipc.ts** (new) | `account:status`, `account:login`, `account:logout`, `entitlements:snapshot`, `entitlements:changed` event. **Claims cross IPC; tokens never do** — extends the existing 8/08 write-only discipline (vault.ts:55-56, ADR 0014:47-49). |
| **src/preload/** | **Zero changes.** New channels enter `AllChannels` and auto-permit (src/preload/index.ts:4-8). The seam pays off. |
| **@backend features** | An `Entitlements` port injected like the `Telemetry` port (src/main/telemetry.ts pattern): features call `entitlements.allows('feature')` / `entitlements.limit('maxX')`. No feature imports vendor SDKs or reads tokens. |
| **Renderer/UI** | Account section in Settings, plan badge, locked-state components + upgrade CTA. UX only — the renderer is **never** a security boundary. |
| **PTY daemon** | **Stays dumb, protocol stays v3.** Entitlement checks live in the app at the daemon-client/command boundary. The daemon deliberately outlives the app (ADR 0006) and must keep restoring sessions for Free users; putting plan state in it would fork the protocol for nothing a local patch couldn't bypass anyway. |
| **`mogging` CLI / MCP server** | Verbs ride the already-authed socket; any plan-gated verb is refused app-side with the existing refusal grammar (exit 4 family). Decide deliberately which verbs are Pro — scriptability is wedge pillar (d); gating `send/capture` would cut the wedge. |
| **Connections / integrations** | Natural Pro dial: count of live connections (e.g. Free = 2, Pro = unlimited). The grant machinery itself is unchanged. |
| **Telemetry** | Post-consent `identify(installId → accountId)`; signup-funnel events. Consent model (opt-in, DNT) unchanged. Privacy policy must name the new processors (IdP, MoR). |
| **Auto-update** | Keep the feed public and ungated (industry standard: gate features, not updates — private feeds on electron-updater/GitHub are fragile and punish lapsed users into insecure old builds). |

**Candidate gate points** (mechanism identical everywhere; which tier gets what is a product
decision, see §8): panes-per-workspace cap (`MAX_PANES`), swarm roles/mailbox scale
(features/agents), SSH remote panes (src/main/remotes.ts), connections count
(src/main/connections.ts), board/orchestration automation depth (board.ts, worktrees.ts),
usage dashboards (features/usage), per-workspace MCP tool plans (tool-plan.ts).

---

## 5. Security requirements — tokens, encryption, hardening

### 5.1 Custody rules (already the house style — extend, don't invent)

Ciphertext-only at rest via safeStorage; refuse to store when the OS vault is unavailable
(including Linux `basic_text`, vault.ts:13-25); decrypt at the single point of use; **no IPC
channel can return a secret, by construction**. Account tokens follow the identical rules.
Access tokens: memory only. Refresh token: vault. Entitlement JWT: vault (it's
integrity-protected by signature; encrypting it at rest additionally hides plan metadata).

### 5.2 safeStorage's honest limits (verified against Electron docs + current research)

- **Windows (DPAPI):** protects against *other users*, not other processes of the *same
  user* — any same-user malware can call `CryptUnprotectData`. No app-identity binding.
- **macOS Keychain:** injected code/child processes count as the app; a poisoned dependency
  can decrypt after launch without an OS prompt.
- **Linux:** kwallet/libsecret when present; `basic_text` is a hardcoded-password sham — the
  vault already refuses it. Correct; keep.
- **Consequence:** never treat the vault as absolute. Keep access tokens short-lived, rotate
  refresh tokens (IdP-side), bind devices server-side, make revocation server-side. A stolen
  vault should be worth minutes-to-hours, not months.

### 5.3 Hardening to close BEFORE charging money

1. **Code signing** — Windows: Azure Trusted Signing (~$10/mo — the repo's own research at
   docs/10:24-37 already reached this conclusion); macOS: Apple Developer Program ($99/yr).
   Config is dry-run-READY; this is a purchase + CI secrets, and it also unlocks macOS
   auto-update (Squirrel.Mac refuses unsigned updates, docs/10:14).
2. **Electron fuses** (currently none are flipped — verified, no `@electron/fuses` anywhere):
   enable `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` (tamper-evidence
   for the shipped JS; cross-platform since Electron 30) and `EnableCookieEncryption`.
   **Constraint found:** the `RunAsNode` fuse **cannot be disabled** today — the PTY daemon
   *is* Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`, src/pty-daemon/index.ts:1-3), and
   installer.nsh:57 + the mac `allow-dyld-environment-variables` entitlement exist to serve
   it. Document the residual risk (any local process can run our binary as a Node
   interpreter); revisit by giving the daemon its own runtime if it ever matters.
3. **Close `MOGGING_REGISTRY_BASE`** (open audit item, catalog.ts:145): an env var can
   repoint a *shipped* build's catalog origin. Fine yesterday, fatal tomorrow: the same
   pattern against an entitlement endpoint is a one-line licensing bypass and a phishing
   vector. Also pin/allowlist the entitlement + IdP origins in code, not env.
4. **Renderer CSP** — add a strict `Content-Security-Policy` meta if not present; the
   renderer is local-file, keep `connect-src` at none/self (telemetry and all network live in
   main).
5. **Supply chain** — `npm audit` is 0 today; add lockfile-lint/provenance checks to CI. A
   poisoned dependency defeats every custody rule above (§5.2 macOS note).

### 5.4 The uncomfortable truth about client-side enforcement

`asar extract` is one command; the app's JS is then plaintext and patchable (fuses make
tampering *evident*, not impossible — a re-signed fork by a determined pirate remains
possible). **Every local entitlement check is bypassable.** Industry consensus, stated
plainly by licensing vendors themselves: client checks are honest-user UX; determined pirates
are not addressable client-side and are not worth distorting the product for. What actually
holds: (a) server-side enforcement for server-backed features, (b) signed builds +
auto-update cadence making patched forks stale and sketchy, (c) support/updates/cloud value
only accounts get. Optional speed bump: electron-vite's V8-bytecode source protection for the
entitlement module — cheap, not security, fine.

---

## 6. Electron limitations — the full, honest list

Ordered by how much each actually threatens this product:

1. **Total source disclosure.** Anything in the bundle is readable: no API secrets ever
   (already internalized — DCR exists because "no client secret shipped in a bundle every
   user can read", ADR 0014:43-44), all gates bypassable (§5.4), competitors can read the
   code. Mitigations: server-side value, fuses, bytecode, signing. *Accept and design for it.*
2. **safeStorage same-user boundary** (§5.2). Not Electron-specific — native apps using DPAPI
   share it — but worth stating in the threat model.
3. **The Chromium CVE treadmill.** Electron supports the latest 3 majors (~8-week cadence);
   paying customers turn "should update Electron" into an obligation. Each major bump means
   native-ABI rebuilds of node-pty/better-sqlite3 — a pain this repo already documents in
   detail (README:146-158, the MSB8040/Spectre saga, the 59-minute CI runner hang,
   docs/10:61-68). Budget recurring maintenance: ~1–2 days per major, 4–6×/yr.
4. **Size + memory floor.** ~125MB installer (electron-builder.yml:80-82), Chromium's RAM
   footprint per instance. The app's perf engineering (142.8 avg fps under 16 agents + a
   write torrent, heap 20MB, README:66-68) proves UX is fine; the *footprint* is simply the
   price of the one-engine-everywhere bet. Not a sales blocker for a dev tool (VS Code,
   Slack, Discord, 1Password all ship it).
5. **Signing/notarization friction per platform.** Gatekeeper hard-refuses unsigned apps
   since Sequoia; SmartScreen scares Windows users until reputation accrues; both documented
   with the fix priced (docs/10:70-79). Solved with money + CI secrets.
6. **App stores are (mostly) not for us.** Mac App Store sandbox cannot host an app whose
   whole point is spawning arbitrary PTY subprocesses, watching the filesystem, and running a
   detached daemon — MAS is off the table (Developer ID direct-distribution is the lane,
   which is what's built). Microsoft Store *does* allow full-trust Win32 and could carry the
   NSIS build later. Linux: no gatekeeping, but safeStorage depends on the desktop's secret
   service (already handled by refusal).
7. **Auto-update infrastructure is on you.** Already built and hardened (feed-verification CI
   step after the v0.3–0.10 404 incident, docs/10:105-124); macOS auto-update stays inert
   until signing lands.
8. **`RunAsNode` fuse conflict** — the daemon architecture pins one hardening lever open
   (§5.3.2). Unique-to-us finding, low severity, document it.
9. **Battery/startup vs native** — real but engineered-around here; the perception budgets
   and gates exist precisely for this.
10. **The alternative was already litigated.** ADR 0001 chose Electron over Tauri for
    one-Chromium-everywhere terminal fidelity — and BridgeSpace's Tauri rendering bugs are
    the competitive exhibit. The limitations above are the price of that correct call.
    **Verdict: Electron does not block productization.** The constraint that matters is #1 —
    it dictates *where enforcement can live*, which shapes pricing (§8).

---

## 7. Business/compliance checklist before revenue

- [ ] **Legal entity + bank** (MoR remits to a business).
- [ ] **EULA — currently you cannot even take free users:** LICENSE:3-5 grants *no license to
  use, copy, or distribute*. Ship a real EULA (free tier) + subscription terms (paid). The
  non-AGPL/source-available question (LICENSE:7-11) can be decided separately; don't block on it.
- [ ] **Privacy policy + GDPR/CCPA basics:** data map is small today (installId, opt-in
  telemetry) and grows to: account email, subscription status, device records. Name the
  subprocessors: Sentry, PostHog, IdP, MoR. DSR path = email at first.
- [ ] **Refunds/chargebacks/tax** — the MoR's job (that's what the 4–5% buys).
- [ ] **Support channel** (email + GitHub issues day one) and an SLA sentence for Pro.
- [ ] **security.txt + disclosure policy** — you hold OAuth grants for users' Sentry/Notion/
  Vercel; a researcher needs a door to knock on.
- [ ] **Website with checkout** (MoR-hosted checkout keeps PCI entirely off us) + account
  portal (IdP-hosted or MoR-hosted; build nothing).
- [ ] SOC 2 — only when Team-tier buyers demand it; not now.

---

## 8. Pricing & packaging recommendation

Anchor: BridgeSpace at $16–80/mo *with* a forced account. Undercut and out-position:

| Tier | Price | Contents | Enforcement reality |
|---|---|---|---|
| **Free** | $0, no account, forever | the whole local organizer core: multi-pane terminals, workspaces, persistence, agent awareness, files, git decorations, a sane number of panes/connections | none needed |
| **Pro** | **$8–12/mo** (14-day trial, no card) | power orchestration: 16-pane fleets, swarm roles at scale, SSH remotes, unlimited connections, board automation depth, priority support | client-gated (UX-grade) until server-backed features exist |
| **Team** (later) | ~$15–20/user/mo | shared workspace/policy sync, roster/roles, centralized MCP tool plans, SSO (WorkOS) | **server-backed = actually enforceable** — and the real moat |

Principles: never gate the wedge (rendering reliability, neutrality, scriptability basics,
local-first) — that's the funnel; gate *scale and glue*. The first server-backed Team feature
is where enforcement stops being honor-system, so build toward it.

**Getting users to sign up** (the funnel, given what exists): signed installers → submit the
staged winget + homebrew manifests (docs/10:157-170 playbooks are written) → landing page
with the 16-agent demo as proof (the wedge is *demoable*) → in-app: the existing first-run
checklist gains one final card ("Pro exists — trial") + locked-state CTAs at gate points →
PostHog funnel events (post-consent) to see where signups die → launch beta cohort from the
GitHub audience → Show HN / dev-tool directories. Conversion norms for dev-tool freemium are
low single digits; the free tier is the top of the funnel, which is one more reason not to
shrink it.

---

## 9. Roadmap to first paid user

| Phase | Work | Est. |
|---|---|---|
| **A — Legal & signing** | buy certs, flip CI secrets (signing-dryrun → Release), EULA/ToS/privacy, close `MOGGING_REGISTRY_BASE`, flip ASAR-integrity fuses, ADR 0016 + wording-gate update, rewrite positioning copy | 1–2 wks |
| **B — Accounts** | pick IdP + MoR (the two decisions), backend skeleton (§3.4), `account.ts` login via lifted connections PKCE machinery, vault custody, `account.ipc.ts`, Settings UI, telemetry identify | 2–4 wks |
| **C — Billing & entitlements** | MoR product/checkout, webhook consumer, entitlement JWT issue/verify/cache/grace, `Entitlements` port, first 2–3 gates + locked-state UX, device registry, **gates for the gates** (ENTITLE smoke: expired/offline/tampered/downgrade paths) | 2–4 wks |
| **D — Launch** | landing + checkout page, winget/homebrew submission, funnel events, beta cohort, pricing page, Show HN | 2–3 wks |
| **E — Server-backed Pro/Team** (post-launch) | team sync/policies — real enforcement + the moat | ongoing |

Total: **~2–3 months** at this repo's demonstrated pace. Decision points needing the founder:
(1) freemium vs account-required (§1 — recommendation: freemium), (2) MoR pick (§3.2 —
Polar or Paddle), (3) IdP pick (§3.1 — Supabase Auth or Clerk), (4) the Free/Pro line (§8).

---

## 10. Cost summary

| Item | Cost |
|---|---|
| Apple Developer Program | $99/yr |
| Azure Trusted Signing | ~$120/yr |
| IdP (Clerk/Auth0/Supabase free tiers) | $0 to 25k–50k users |
| MoR | 4–5% + ~$0.40–0.50 per transaction |
| Backend (Supabase/Fly small) | $0–25/mo |
| Sentry + PostHog free tiers | $0 at launch scale |
| **Fixed total** | **~$220–520/yr** + % of revenue |

---

## 11. Sources

Codebase: files cited inline above (README, docs/00, 02, 06, 10, 14, ADRs 0001/0002/0006/0014,
AUDIT_REMEDIATION_REPORT_2026-07-13.md, src/main/{window,vault,telemetry,deep-link,connections}.ts,
src/preload/index.ts, src/pty-daemon/index.ts, electron-builder.yml, build/installer.nsh, LICENSE).

Web (July 2026):

- MoR comparisons: [buildmvpfast — Lemon Squeezy vs Polar vs Paddle 2026](https://www.buildmvpfast.com/blog/lemon-squeezy-vs-polar-paddle-merchant-of-record-2026) · [fintechspecs — Stripe vs Paddle vs LS vs Polar](https://fintechspecs.com/blog/stripe-vs-paddle-vs-lemon-squeezy-vs-polar-merchant-of-record-b2b-saas/) · [goilerplate — Polar vs Stripe vs LS](https://goilerplate.com/blog/polar-vs-stripe-vs-lemonsqueezy) · [devtoolpicks — Polar vs LS vs Creem](https://devtoolpicks.com/blog/polar-vs-lemon-squeezy-vs-creem-2026)
- Native-app OAuth: [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252) · [Google — OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app) · [Auth0 — OAuth best practices for native apps](https://auth0.com/blog/oauth-2-best-practices-for-native-apps/)
- Auth pricing: [buildmvpfast — auth providers 2026](https://www.buildmvpfast.com/blog/best-auth-providers-2026-clerk-supabase-comparison) · [buildmvpfast — auth pricing table (June 2026)](https://www.buildmvpfast.com/api-costs/authentication) · [merginit — free auth providers compared](https://merginit.com/blog/13062026-free-auth-identity-providers-comparison)
- Licensing/entitlements: [Keygen — how to license and distribute an Electron app](https://keygen.sh/blog/how-to-license-and-distribute-an-electron-app/) · [Keygen — Electron activation example](https://github.com/keygen-sh/example-electron-license-activation) · [Keyforge — offline license validation with JWTs](https://keyforge.dev/blog/offline-license-validation) · [10Duke — offline licensing guide](https://www.10duke.com/learn/software-licensing/offline-licensing/)
- Electron security: [Electron — safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) · [Electron — ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity) · [electron#42318 — safeStorage limitations](https://github.com/electron/electron/issues/42318) · [chenguangliang.com — safeStorage internals](https://chenguangliang.com/en/posts/blog169_electron-credential-storage-security/) · [deepstrike — pentesting Electron apps](https://deepstrike.io/blog/penetration-testing-of-electron-based-applications) · [electron-vite — source protection](https://electron-vite.org/guide/source-code-protection)
- Category precedents: [Raycast/Warp comparisons 2026](https://aiproductivity.ai/vs/raycast-vs-warp/) · [devtoolpicks — Raycast 2.0 beta](https://devtoolpicks.com/blog/raycast-2-public-beta-windows-indie-hackers-2026)
