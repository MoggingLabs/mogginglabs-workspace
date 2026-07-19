# Phase Launch — v1.0.0 readiness: proof, polish, and the real backend

Sequenced task prompts for the **launch phase** of **MoggingLabs
Workspace**: the work between "feature-complete with the Brain merged"
and a **public v1.0.0** — split in two. **Part I (01–07)** proves the
*whole* codebase is correct and clean: every feature verified against its
edge cases, every smell / anti-pattern / dead branch / duplicated helper /
inefficiency routed and fixed, nothing shipping on a guess. **Part II
(08–16)** stands up the parts the accounts pack left as "the operator's
deferred wiring" — a **real IdP**, **entitlements derived from the LIVE
Stripe billing**, a **robust** backend on the website's Neon/Vercel stack,
the **real operator secrets**, a deeper anti-piracy pass, and the
**business + compliance** paperwork — every one of them **at $0**. **Part III (17–25) REVAMPS the EXISTING company site** — it is live at
`mogginglabs.com` (Next.js 16 · Tailwind v4 · Vercel behind Cloudflare ·
Neon), with the `seo-authority` and `admin-page` phases already shipped and
frozen (structured data, a `/learn` cluster, a 40-server `/mcp-servers`
directory, **GSC verified**, a first-party zero-cookie analytics collector,
Stripe billing). So Part III **updates and extends** it: content freshness
to the shipped product, **complete docs**, a **real blog + editorial**, an
**auto-generated release-driven changelog** (cross-repo), the
**Claude/Codex industry-watch** engine, the measurement loop, and a
**deferred X/social** pipeline — all **at $0** (domain owned, GSC done).
It runs in the sibling repo `../MoggingLabs-Website` under ITS laws
(Lighthouse 100/100/100/100, zero third-party requests, no em-dashes, no
competitor names, truth-over-keywords). Same format as
`prompts/phase-1..12/`: each step self-contained, pasteable as a `/goal`,
**≤ 3900 chars**. Execute in order.

> **Precondition — MET as of 2026-07-19.** This pack runs on `main` with
> Phase 12 (the Brain) **merged** and its gates green — Part I audits the
> composed product. Current baseline: **v0.15.0, 182 gates (159 app-boot +
> 23 static)**. `check-gate-count.mjs` is the only authority on the count,
> so treat that number as live (it keeps moving), never a hard-coded literal.

## The laws that bind this phase

> **The $0 law.** Nothing in this pack costs money. Every provider chosen
> is free at launch scale (IdP free-tier MAU) or **revenue-share only**
> (the MoR takes a cut of sales, never a fixed fee — $0 until a sale
> exists); every host is a free tier; keys are generated locally. **The
> ONE exception is code signing** (Apple $99/yr + Windows signing), which
> is the operator's own later step, OUT of this pack. A step that cannot
> be done for $0 stops and says so — it is never faked.

> **FAKE-first survives — the gates stay offline.** The real IdP / MoR /
> issuer become real CODE and a locally-runnable `server/`, but **every
> gate runs with zero external network**: against the shipped FAKEs
> (`src/backend/features/account/fake-idp.ts`, `fake-entitle.ts`) or
> against the real `server/` bound to `127.0.0.1` with a local DB and a
> FAKE MoR delivery. The operator flips production config with their own
> free accounts; no gate ever reaches the internet (the house rule since
> phase-accounts).

> **The enforcement-honesty law (ADR 0016 §5, restated).** A client check
> is UX, not security. Real teeth stay exactly two: **hardware binding**
> and **server-authoritative value**. This phase may deepen friction and
> attribution, but no step is allowed to describe fuses / bytecode /
> watermark / tamper as a wall. Say what each actually buys.

> **No-regression is a veto.** Both budgets (MILESTONE + PERCEPTION) and
> every existing gate stay green on the bytes each step ships. A smarter
> or cleaner change that moves a budget or reds a gate is a stop-ship, not
> a footnote. Determinism + custody laws (ADR 0018 / 0016 / 0008) carry
> over untouched.

## Sequence

| # | File | Gate / output |
|---|------|---------------|
| 01 | `01-audit-method-and-coverage.md` | Feature inventory + rubric + routing doc; **LAUNCHAUDIT** static coverage gate |
| 02 | `02-correctness-runtime-ui.md` | Edge-case sweep: terminal/PTY/daemon/scroll/layout/updater-UX; findings routed + fixed |
| 03 | `03-correctness-orchestration.md` | Edge-case sweep: board/worktrees/review-merge/swarm/control-API |
| 04 | `04-correctness-paid-and-reach.md` | Edge-case sweep: account/entitlements/hardening/connections/usage/browser/files/brain/MCP |
| 05 | `05-quality-dedup-refactor.md` | Dedup + dead-code + refactor; **MAINT** static gate (dup/dead/module-size) |
| 06 | `06-efficiency-and-perf.md` | Inefficiency hunt + both budgets re-measured on the merged surface |
| 07 | `07-environment-and-failure.md` | Cross-OS · offline · first-run · upgrade/migration · low-resource · error-injection |
| 08 | `08-provider-decisions-adr.md` | IdP + MoR + host decided ($0); DPoP architecture resolved; **ADR 0019** |
| 09 | `09-backend-foundation.md` | `server/` skeleton, schema, migrations, config, observability, local-run + test harness |
| 10 | `10-backend-billing.md` | Extend the LIVE Stripe webhook to derive entitlements + full subscription lifecycle |
| 11 | `11-backend-issuance.md` | `GET /entitlement`: real Ed25519 claim, DPoP RS dance, device registry, JWKS, revoke |
| 12 | `12-real-idp-wiring.md` | Real IdP in `account.ts`; FAKE kept for gates; **IDPPARITY** gate |
| 13 | `13-operator-secrets.md` | Real keypairs generated, custody/rotation runbooks, pinned halves, tamper manifest; **OPSECRETS** |
| 14 | `14-security-antipiracy-uplift.md` | Threat re-model, residual gaps closed, cheap teeth added; **PIRACYAUDIT** |
| 15 | `15-business-compliance-distribution.md` | EULA/ToS/privacy/security.txt/support + legal-entity & MoR runbooks + distribution prep |
| 16 | `16-v1-milestone-and-freeze.md` | **V1MILESTONE** (product side) on the local real stack; Parts I–II verified; signing-flip runbook |

### Part III — Revamp the EXISTING site `mogginglabs.com` (Next.js/Vercel/Neon; all $0, in `../MoggingLabs-Website`)

| # | File | Gate / output |
|---|------|---------------|
| 17 | `17-web-revamp-inventory-and-laws.md` | Inventory + freshness audit + adopt the site's laws (no build); `WEB-INVENTORY`/`WEB-FINDINGS` |
| 18 | `18-content-freshness-and-completeness.md` | Every page current (Brain, accounts, Free/Pro/Team/Enterprise); frozen SEO gates re-verified |
| 19 | `19-docs-completeness-and-app-sync.md` | `/docs` complete + synced to the app; **DOCS** coverage gate |
| 20 | `20-blog-maturation-and-editorial.md` | Grow `posts.ts` → real blog (authors/tags/RSS) + editorial system + launch posts |
| 21 | `21-changelog-pipeline-cross-repo.md` | Release-driven `/changelog` + RSS + in-app "What's new" (Workspace→site); **CHANGELOG** gate |
| 22 | `22-industry-watch-content-engine.md` | Claude/Codex news track + hubs + newsroom (human-in-loop) + newsletter tie-in |
| 23 | `23-measurement-and-seo-health.md` | Extend the first-party collector + GSC loop + scheduled SEO-health check (no third-party) |
| 24 | `24-social-x-pipeline-deferred.md` | Draft-and-human-post X/social pipeline, built dormant, activate-after-launch |
| 25 | `25-web-revamp-milestone-and-freeze.md` | **WEBREVAMP** + site REPORT + full-pack CHECKLIST verify + going-live runbook; **overall freeze** |

## Overall Definition of Done
- Every user-facing feature is graded, its edge cases enumerated, and
  every finding either fixed or deferred-with-rationale — no surface below
  the audit floor, no unrouted finding (`LAUNCHAUDIT`).
- The codebase carries no duplicated helper, dead affordance, or
  oversized/​spaghetti module past its budget (`MAINT`); both budgets held
  (`MILESTONE` · `PERCEPTION`).
- A **real** IdP + entitlement backend exist as code on the website's
  Neon/Vercel stack and run locally offline in a gate; the app talks to it
  and the whole PRODMILESTONE promise holds (`V1MILESTONE`). Billing is the
  already-deployed **Stripe** rail, extended to derive entitlements.
- The real operator secrets are generated, custodied, rotatable, and their
  public halves pinned; the tamper manifest is signed (`OPSECRETS`).
- The legal + compliance set (EULA, ToS, privacy, security.txt) exists and
  the positioning copy is reconciled (`check-credential-wording.mjs`).
- The EXISTING site (`mogginglabs.com`) is revamped and current: every page
  states the shipped product (Brain, accounts, Free/Pro/Team/Enterprise),
  docs are complete, the blog is real, and a tagged release
  **auto-publishes the changelog** to `/changelog` — all under the site's
  laws (Lighthouse 100, zero third-party) and all $0 (`WEBREVAMP`).
- The industry-watch newsroom + the GSC/first-party measurement loop + the
  deferred X pipeline are drafted and structured; nothing publishes
  unreviewed.
- `CHECKLIST.md` is complete and every non-money item is checked; the only
  open items are the operator's money/account/domain/deploy steps, each
  named.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok; the static battery green
  (AUDIT · SPACING `--max 0` · PTYSEAM · PROTOVER · CHANNELS · gate-count).
- The step's new/updated gate green in `scripts/qa-smokes.sh` isolation;
  MILESTONE + PERCEPTION re-run after any renderer-touching step.
- Counts stay DERIVED — write what `check-gate-count.mjs` prints, never a
  hand-typed total.

## Guardrails
- **$0 or it stops.** Any step that would require spend (beyond signing)
  halts with the reason; it never fakes a paid path as done.
- **Offline gates, always.** Zero external network in any smoke; the real
  backend (Next.js routes on the website's Neon stack) runs on loopback
  with a local DB and a FAKE Stripe delivery.
- **Honesty over theater.** No security control is oversold; every
  residual is stated (docs/19 "honest limits" is the model).
- **Derived state stays out of the repo; secrets never commit** — only
  public halves and signed manifests land; private keys live in the
  operator's secret store (ADR 0002 applies to our own secrets).

## Parallelization
01 → 02/03/04 (three independent sweeps) → 05 → 06 → 07 closes Part I.
Part II spine: 08 → 09 → {10, 11} → 12; 13 needs 11; 14 needs 11+13; 15 is
independent of the backend (docs/runbooks) and can run alongside 09–14; 16
closes Part II. Part III (in `../MoggingLabs-Website`) spine: 17 → 18 → {19, 20} → 21; 22
needs 20; 23 extends the existing collector (any time after 18); 24 needs 21
and is **deferred** (activate after the site is live); 25 needs all of Part
III (and reads 16's product certification). Part III depends on Part I's
INVENTORY (docs coverage) but is otherwise independent of Part II, so it may
run in parallel with the backend arc. Solo execution runs 01 → 25 in order
(house rule: no parallel agents). See `RESEARCH.md` (the IdP/split/tax
education, reconciled with the deployed Stripe reality) + `RESEARCH-web.md`
(the live-site ground truth) for what 08 and 17 consume, and `CHECKLIST.md`
for the living state of the whole phase.
