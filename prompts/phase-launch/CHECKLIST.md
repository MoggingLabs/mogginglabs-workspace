# Phase Launch — the v1.0.0 checklist

The living state of the whole phase. Each step's `/goal` checks its boxes
as it lands; at any moment this file says what's done and what's left. One
sentence per box. **`[ ]`** = to do · **`[x]`** = done · **`[~]`** =
PENDING-operator (needs the founder's account/deploy/money — never a code
step). The ONLY money item is **code signing** — the domain, hosting
(Vercel/Cloudflare), Neon, Stripe, GSC, and Loops are ALREADY set up;
everything this pack builds is $0.

> **Precondition — MET (2026-07-19)**
> - [x] Phase 12 (the Brain) is merged to `main` and its gates are green.
> - [x] `check-gate-count.mjs` clean on `main`: **v0.15.0, 182 gates (159 app-boot + 23 static)** — the live baseline (derive, never hard-code).

---

## Part I — Prove the product is correct and clean

### 01 · Audit method & coverage
- [ ] `INVENTORY.md` lists every feature + subsystem, one row each, with entry point + doc + covering gate.
- [ ] `RUBRIC.md` defines the six lenses (correctness, smell, spaghetti, duplication, inefficiency, refactor-debt) with in-repo examples and a B floor.
- [ ] `FINDINGS.md` routing ledger exists (id · area · lens · file:line · severity · verdict · rationale · resolved-in).
- [ ] `LAUNCHAUDIT` gate written, wired into `qa-smokes.sh`, and bite-proven (an ungraded row reds it).

### 02 · Correctness — runtime & UI core
- [ ] Edge cases enumerated for terminal/PTY/daemon/scroll/layout/panes/updater-UX/first-run/Settings/themes.
- [ ] Each guarantee verified against `file:line` and asserted in the owning gate or a unit.
- [ ] Every S1/S2 fixed with a regression assertion red on pre-fix bytes; S3 deferred with rationale.
- [ ] Scoped rows graded ≥ B; MILESTONE + PERCEPTION unmoved.

### 03 · Correctness — orchestration & swarm
- [ ] Concurrency/failure edges enumerated for board/worktrees/review-merge/swarm/control-API/loops.
- [ ] Ownership + redaction + merge + queue invariants each carry a live assertion.
- [ ] Every S1/S2 fixed + bite-proven; rows graded ≥ B; both budgets green with the swarm up.

### 04 · Correctness — money paths & reach
- [ ] Adversarial/boundary edges enumerated for account/entitlements/hardening/updater-feed/connections/usage/browser/files/brain/MCP.
- [ ] Money invariants asserted: no token over IPC, copied→Free, tampered→Free-only, forged-webhook→no-op, unreachable≠rejected, grace-then-Free-never-brick.
- [ ] Licensing/custody/redaction defects treated S1; all S1/S2 fixed + adversarially asserted; PRODMILESTONE + budgets green.

### 05 · Quality — dedup, dead code, refactor
- [ ] Duplicated helpers/parallel implementations consolidated to one home, callers rerouted, bytes-identical.
- [ ] Dead exports/branches/affordances deleted (not hidden) and proven unreferenced.
- [ ] Oversized/spaghetti modules decomposed along real seams with no new dependency.
- [ ] `MAINT` gate written, wired, and bite-proven; SPACING `--max 0` still frozen.

### 06 · Efficiency & perf
- [ ] Every poller/timer/watcher censused and proven zero-cost when idle/hidden.
- [ ] Algorithmic/allocation waste routed with measurements; LRU caps confirmed bounded.
- [ ] Both budgets re-measured on the merged surface (Brain + accounts live) and recorded; a forced re-index under 16 panes holds the ceiling.

### 07 · Environment & failure
- [ ] Cross-OS parity confirmed (win local + mac/linux sweeps) with honest per-OS custody rows.
- [ ] Offline + flaky-network paths proven (free core works, transient law holds, missing-feed boot crash stays fixed).
- [ ] First-run + old→new migration proven loss-free against a seeded old userData; downgrade refuses safely.
- [ ] Low-resource + error-injection paths each surface an honest sentence, never a silent wrong state.

---

## Part II — Enable the launch (all $0)

### 08 · Provider decisions (ADR 0019)
- [ ] The authN/authZ split ratified as binding (IdP = identity only; our backend mints DPoP-bound tokens).
- [ ] IdP = Auth.js/Clerk on the Neon stack chosen (WorkOS AuthKit named as the Enterprise-tier SSO swap); Supabase Auth noted as still viable.
- [ ] Billing = Stripe ratified (already the deployed rail); Stripe-Tax-now + optional-later Polar/Paddle MoR wrapper recorded with the tax tradeoff.
- [ ] Backend location = new routes on the website's Neon/Vercel stack (NOT a greenfield `server/`); pricing = Free/Pro/Team/Enterprise (Team per-seat, 2+; Free = 2 workspaces x 4 panes + all integrations).
- [ ] FAKE→real mapping (incl. the EXISTING Stripe webhook extended) written; deferrals + operator-account items listed (no gate depends on them).

### 09 · Backend foundation
- [ ] The backend (Next.js routes on the website's Neon stack) boots on loopback with health + per-env config (secrets from ENV, absent-honest locally).
- [ ] Schema + forward-only Neon migrations for accounts/subscriptions/entitlements/devices/events (validate-schema clean).
- [ ] Idempotency + append-only audit log + rate-limit + typed refusals exist and are unit-tested (reusing the site's harness).
- [ ] Local-run + test harness green; the site's `server-ci`-equivalent green; app sweep untouched.

### 10 · Backend billing
- [ ] The EXISTING Stripe webhook is EXTENDED to derive entitlements, keeping its signature-before-state + idempotency + 400/200/503 contract (forged/replayed flip nothing).
- [ ] Full lifecycle mapped (created/updated/canceled/refunded/dunning) with period-end reverts and immutable audit rows.
- [ ] Reconciliation cron heals a dropped webhook; billing tests green offline.

### 11 · Backend issuance
- [ ] `GET /entitlement` mints a device-bound, watermarked `entitle+jwt` Ed25519 claim under the DPoP RS-nonce dance.
- [ ] Device registry + per-plan cap enforced at issuance; a foreign device cannot be licensed.
- [ ] Server-side revocation degrades on next refresh (no detonation); JWKS published.
- [ ] The app, bound to the local backend offline, completes issue→Pro→revoke→Free (smoke green); `entitlements.ts` verifies with zero code change.

### 12 · Real IdP wiring
- [ ] Real IdP adapter (Auth.js/Clerk per ADR 0019) added behind the FAKE's interface (discovery/JWKS/PKCE, id_token verified-or-absent).
- [ ] Post-login token exchange mints our DPoP-bound access token (shipped DPoP dance unchanged, no token over IPC).
- [ ] Real IdP/backend/issuer origins pinned in `origins.ts` (ORIGINPIN); "not wired" honest until config set.
- [ ] `IDPPARITY` gate green (real stub ≡ FAKE, offline); credential-wording gate passes.

### 13 · Operator secrets
- [ ] Entitlement + tamper-manifest + watermark keypairs generated offline; private halves gitignored, never committed.
- [ ] Custody + rotation runbook (`docs/22`) with a dual-verify window and a complete secret INVENTORY.
- [ ] Real public halves pinned in `origins.ts` (protectedStrings); real issuer `iss`/`aud` pinnable.
- [ ] Tamper manifest signs under the real key; `OPSECRETS` gate green + bite-proven (a stray private key reds it).

### 14 · Security & anti-piracy uplift
- [ ] Threat model (`docs/23`) maps each attacker to the control that stops/slows it, residual stated.
- [ ] Cheap residuals closed (no env origin override, TTL/grace tuned, device cap, feed integrity, key rotation exercised).
- [ ] Attribution + revocation teeth documented (piracy telemetry → revoke workflow; watermark trace runbook).
- [ ] `PIRACYAUDIT` gate green + bite-proven; honesty pass finds/fixes any overclaim.

### 15 · Business, compliance & distribution
- [ ] Legal set drafted (`legal/`): EULA (free-use grant), subscription terms, privacy (subprocessors named), security.txt.
- [ ] Launch-ops runbook (`docs/24`): Stripe products/prices + Stripe Tax, refunds/chargebacks, support, the optional-later MoR wrapper + its tax tradeoff — all costed.
- [ ] Positioning copy reconciled to the freemium truth; credential-wording gate extended and passing.
- [ ] Distribution playbooks ready (winget/homebrew/landing/checkout/funnel), signing-gated ones marked PENDING-operator.
- [ ] `COMPLIANCE` gate green (docs present + well-formed).

### 16 · Product v1 milestone (Part II close)
- [ ] `V1MILESTONE` green on the local real stack offline; both budgets held on the composed surface.
- [ ] Parts I–II of this CHECKLIST walked; every non-money box checked or PENDING-operator with reason.
- [ ] `docs/25-going-live.md`: the product-flip section written (ordered + costed); signing dry-run prints READY.

---

## Part III — Revamp the EXISTING site `mogginglabs.com` (Next.js/Vercel/Neon; all $0; in `../MoggingLabs-Website`)

### 17 · Web revamp inventory & laws (no build)
- [ ] `WEB-INVENTORY.md` lists every public route + SEO gate + the analytics collector, each with a `file:line` + freshness.
- [ ] `WEB-FINDINGS.md` routes every stale claim (product version, missing Brain/accounts, pricing) to its true replacement.
- [ ] The site's laws (Lighthouse 100, zero third-party, no em-dash, no competitor names, truth-over-keywords) restated as binding.

### 18 · Content freshness & completeness
- [ ] Home/learn/docs/roadmap/about/mcp-servers refreshed to the shipped product (the Brain, accounts) with true, traced claims.
- [ ] `/pricing` renders the DECIDED tiers (Free / Pro $19 / Team $29 per seat 2+ / Enterprise contact-sales) on the no-credits BYO wedge; Team/Enterprise framed early-access/in-dev; FAQ schema honest.
- [ ] Real gaps filled (a Brain surface, a BYO-neutrality trust surface); each new page in `sitemap.ts` + `llms.txt`.
- [ ] Frozen SEO gates re-verified (validate-schema/check-cluster/check-mcp-links) + Lighthouse 100 on every touched page.

### 19 · Docs completeness & app-sync
- [ ] `/docs` covers every shipped feature + `mogging` verb (get-started → concepts → guides → reference → troubleshooting → security).
- [ ] Reference lists derive from the app's typed contracts (no hand-drift); cross-linked to the Workspace docs.
- [ ] `DOCS` coverage gate green + bite-proven; new pages carry schema + sitemap + llms.txt; Lighthouse 100 holds.

### 20 · Blog maturation & editorial
- [ ] `src/lib/posts.ts` extended (author/tags/category) + archive/tag/author pages + a valid RSS feed; drafts never build.
- [ ] `EDITORIAL.md`: workflow + law-enforcing style guide (no em-dash/competitor, founder voice) + per-post SEO checklist.
- [ ] 3–5 real, true, on-voice launch posts live, each targeting a /learn cluster keyword and linked into docs; Lighthouse 100.

### 21 · Automated changelog pipeline (cross-repo)
- [ ] Workspace: Conventional-Commits + a deterministic `gen-changelog.mjs` → `CHANGELOG.md` + `changelog.json`, wired into `release.yml`.
- [ ] Delivery to the site is build-time or a committed file (zero client third-party); `/changelog` + RSS render it; in-app "What's new" reads the same JSON.
- [ ] `CHANGELOG` gate green + bite-proven + fake-tag dry-run; the three faces (Release/site/app) show identical entries.

### 22 · Industry-watch content engine
- [ ] Industry blog track + per-subject hub pages (Claude/Codex/Gemini/agent-CLIs) built, cluster-shaped, distinct from product posts.
- [ ] `RESEARCH-SOURCES.md` (primary feeds) + `NEWSROOM.md` (workflow, cadence, newsletter tie-in, accuracy/legal firewall) written.
- [ ] Any automation drafts to a review queue only; nothing about another company publishes without human review + citations; no rival is named.

### 23 · Measurement & SEO health (no third-party)
- [ ] Content + CTA events added to the EXISTING first-party `/api/t` collector; zero third-party requests + zero cookies preserved.
- [ ] GSC review loop + Bing (if added) + KPI set + cadence documented; a content→conversion admin view exists on the existing infra.
- [ ] A scheduled SEO-health check re-runs the frozen gates against the live edge and flags regressions.

### 24 · Social / X pipeline (deferred, dormant)
- [ ] `SOCIAL-PIPELINE.md` designs sources → draft → review → post; the generator emits platform-native drafts offline from existing payloads.
- [ ] Honest cost note: drafting $0, auto-posting a possible paid X tier → v1 is draft-and-human-post; auto-post wired OFF.
- [ ] Marked activate-after-launch; no credential committed; drafts obey the site's copy laws; every path human-approved.

### 25 · Web revamp milestone & overall freeze
- [ ] `WEBREVAMP` green on the built + edge site (Lighthouse 100, SEO gates, no stale claim, all new pages in sitemap/llms.txt, changelog dry-run, zero third-party).
- [ ] The site REPORT written in the freeze convention; the FULL CHECKLIST (Parts I–III) walked; every non-operator box checked.
- [ ] `docs/25-going-live.md` gains the web-flip section; the overall pack freeze table + `docs/02`/`prompts/README.md` rows updated.

---

## Operator steps — AFTER this pack (the founder; the only money)
- [~] Buy the Apple Developer Program cert ($99/yr) + set macOS notarization secrets.
- [~] Set up Windows code signing (Azure Trusted Signing ~$10/mo) + set `CSC_LINK`/`CSC_KEY_PASSWORD`.
- [~] Flip signing: add CI secrets, rerun `Release` (`signing-dryrun` → signed build).
- [~] Stand up the IdP project (Auth.js on Neon / Clerk) — free; set its secrets in Vercel env.
- [~] Set the entitlement backend's real config (pinned origins + private keys) in the Vercel/Neon secret store; deploy the new routes.
- [~] Confirm the live Stripe account carries the DECIDED products/prices (Pro $19 flat; Team $29/seat via quantity subscription, 2+) + enable Stripe Tax; a Polar/Paddle MoR wrapper stays optional-later.
- [~] Publish the legal docs (counsel-reviewed) + open the Stripe checkout + flip the site `PRIMARY_CTA` to the public download.
- [~] Submit winget PR + stand up the homebrew tap from the signed artifacts.
- [~] Run the full three-OS CI sweep + verify the update feed resolves on the real release.
- [~] Deploy the revamped site (`vercel deploy --prod --yes`) + verify through the Cloudflare edge; resubmit the sitemap to the already-verified GSC.
- [~] (Later, optional) enable X/social auto-posting only if opting into a paid API tier — else draft-and-human-post ($0).
- [x] Domain (`mogginglabs.com`) + GSC + Vercel/Cloudflare/Neon/Stripe/Loops: ALREADY set up and deployed — no action, no cost.

---

## Definition of "v1.0.0 ready" (this phase's exit)
- [ ] Part I green: every feature graded ≥ B, every S1/S2 fixed, both budgets held, `MAINT`/`LAUNCHAUDIT` green.
- [ ] Part II green: real backend (on the website's Neon/Vercel stack) + IdP + Stripe-derived entitlements wired and proven offline, secrets real, security honest, compliance drafted.
- [ ] Part III green: the LIVE site revamped — every page current, docs complete, blog real, changelog auto-publishes, newsroom + measurement + social structured, under the site's laws (`WEBREVAMP`).
- [ ] The only remaining work is the operator block above — every item named and costed, nothing silently open.
