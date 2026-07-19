# Phase Launch — RESEARCH: the $0 provider stack, explained

**Purpose:** ground step 08's decisions. What to pick for the IdP, the
merchant-of-record, and the backend host so v1 stands up **robust and at
$0 fixed cost**, and *why*. Figures are carried from the repo's own
`docs/research/2026-07-productization-accounts-subscriptions.md` (July
2026, sourced) — **verify current terms at signup**, they move.

> **SUPERSEDED IN PART BY THE DEPLOYED REALITY — read this first.** After
> this doc was written we confirmed the company site
> (`../MoggingLabs-Website`) is already live on **Next.js + Neon + Vercel**
> and already runs **Stripe** billing + a revenue ledger. So the concrete
> picks below are overridden by ADR 0019 / `RESEARCH-web.md`: the backend
> is new routes on that **existing website stack** (NOT a greenfield
> `server/` and NOT Supabase-host); **billing is Stripe** (already the
> rail), not Polar — a Polar/Paddle MoR wrapper is an OPTIONAL later move
> if global tax filing becomes a burden; the **IdP** is Auth.js/Clerk on
> the Neon stack (Supabase Auth still viable); pricing is the owner's
> DECIDED **Free / Pro $19 / Agency $39**. The sections below remain the
> *education* on WHY (the DPoP/IdP split, the MoR-vs-raw-Stripe tax
> tradeoff, offline grace) — read them for reasoning, not for the vendor
> to pick.

> **The one thing that costs money is code signing** (Apple $99/yr +
> Windows ~$10/mo Azure Trusted Signing). Everything below is $0 fixed:
> IdPs are free under a MAU ceiling you are nowhere near; MoRs charge a
> **percentage of revenue only** — no monthly fee, so $0 until you sell;
> hosts have real free tiers. This is why the phase can complete before
> you spend a cent.

---

## 1. The architecture question that comes FIRST (it picks the IdP for you)

The shipped account engine (`src/main/account.ts`) does **DPoP** (RFC
9449) — every token request is sender-constrained to the hardware device
key, and entitlements are bound to it. **No off-the-shelf IdP speaks
DPoP.** Supabase Auth, Clerk, Auth0, WorkOS — none of them issue
DPoP-bound tokens. So you cannot simply "point the app at Supabase" and
keep the design.

**The resolution (and it is the robust one): split authN from authZ.**
- **The IdP does identity only** — login in the system browser (OAuth 2.1
  + PKCE, RFC 8252 loopback, already built), returns a verified `id_token`
  (who you are). Any IdP can do this.
- **Your own backend is the token + entitlement authority** — it mints the
  **DPoP-bound API access token** and the **Ed25519 entitlement claim**.
  DPoP lives at the layer you control, exactly where the shipped code
  already does the RS-side nonce dance (the entitlement fetch).

This keeps every line of the shipped DPoP/device-binding design and makes
the IdP a swappable identity source. Step 08 must write this into ADR
0019; step 12 wires it.

---

## 2. IdP — identity provider

| Provider | Free tier | Then | For us |
|---|---|---|---|
| **Supabase Auth** | ~50k MAU | ~$0.003/MAU | Cheapest to scale; **one stack** with the Postgres backend below; Postgres RLS is a real security primitive; you own more UI. |
| **Clerk** | ~10k MAU | ~$0.02/MAU | Best DX + a hosted account portal you don't build; pricier sooner; still needs your own entitlements backend. |
| **WorkOS AuthKit** | free to ~1M users | per-SSO-connection | Aimed at enterprise SSO — the right pick the day **Team tier** needs SSO; overkill at launch. |
| **Auth0** | ~25k MAU | ~$0.07/MAU | Mature, priciest at scale. |
| Self-rolled magic-link | $0 | your time | Viable (Raycast ships it) but you own resets, abuse, deliverability. |

**Recommendation: Supabase Auth**, for the reason that dominates at your
stage — it is the same vendor as the backend host below, so identity,
Postgres, and the entitlement service are **one free-tier project** with
one dashboard, one bill ($0), one support surface. Because §1 makes the
IdP identity-only, you are not locked in: if enterprise SSO becomes the
priority for Team tier, WorkOS AuthKit swaps in behind the same
`id_token` seam without touching the token/entitlement layer. Use
Supabase's **PKCE** flow with the system-browser + loopback the app
already implements; do **not** embed a web view.

---

## 3. Merchant-of-record — billing without becoming a global tax filer

**Why not raw Stripe:** selling a desktop subscription worldwide means
sales-tax/VAT/GST registration in every jurisdiction you cross a threshold
in. With raw Stripe **you** are the merchant and **you** own all of that.
An **MoR is the legal seller of record** — they collect, remit, and file
tax everywhere, handle refunds/chargebacks/fraud, and pay you out. You
integrate a checkout link + a signed webhook. That is the whole reason the
FAKE issuer models a Stripe-shape webhook: the real MoR keeps that shape.

**"Free at my stage" = revenue-share, no fixed cost.** MoRs take a
percentage per sale and nothing otherwise — $0 until money comes in.

| MoR | Fee | Notes |
|---|---|---|
| **Polar** | ~4% + 40¢ | Open-source, developer-first, **Stripe rails underneath**; built for exactly "sell a digital subscription/license"; checkout + customer portal + entitlement/license primitives; 2026 indie default. |
| **Paddle** | ~5% + 50¢ | Most mature tax coverage; vets sellers (approval can take days). |
| **Creem** | ~3.9% + 40¢ | Newer, indie-focused. |
| **Lemon Squeezy** | ~5% + 50¢ | Stripe-owned since 2024; direction/support uncertain — don't bet the launch on it. |

**Recommendation: Polar.** Lowest fee, the best developer ergonomics, and
its primitives (checkout, customer portal, license/benefit granting) map
onto our entitlement loop with the least glue. Paddle is the fallback only
if maximal tax-jurisdiction maturity outweighs everything. A real bonus at
your stage: because the MoR is the seller of record, you can often **start
without forming a company** — a payout account suffices in many countries
(Polar/Paddle onboard individuals). Confirm payout eligibility for your
country at signup; that, not incorporation, is the gating step.

---

## 4. Backend host — robust on a free tier

The backend is small in surface (webhook consumer, `GET /entitlement`
signer, device registry, JWKS) but must be **robust**: idempotent,
observable, migration-managed, backed up. All achievable at $0.

| Host | Free tier | Fit |
|---|---|---|
| **Supabase** | Postgres + Auth + Edge Functions + cron, generous free | **Integrated with the IdP pick**; Postgres gives real transactions, RLS, and durable webhook/idempotency tables; Edge Functions (Deno) host the endpoints. One stack. |
| **Cloudflare Workers + D1 + Queues** | very generous | Best global edge latency + scale-to-zero; bring your own auth; D1 is younger than Postgres. |
| **Fly.io / Railway / Render** | limited | A normal long-running server if you'd rather not go serverless. |

**Recommendation: Supabase** — Postgres is the right database for
money-adjacent state (transactions, idempotency keys, an append-only event
log), it pairs with Supabase Auth as one project, and cron handles
reconciliation. Cloudflare Workers is the swap if edge latency ever
matters more than the integrated stack. **Monorepo:** keep the service in
this repo under `server/` (separate from the in-app `src/backend/`) so the
contract and the app evolve together; splitting to its own repo later is
cheap.

**Robust-at-$0 checklist (step 09 implements):** SQL migrations checked
in; every webhook write idempotent on event-id; an append-only `events`
audit table; structured logs to a free sink (Sentry/Logtail free tier);
health + readiness endpoints; rate-limiting on public routes; secrets from
env, never committed; nightly logical backup (Supabase includes it);
config-per-environment (local / staging / prod) so gates run on local.

---

## 5. The recommended stack (what step 08 should ratify)

```
Identity   : Supabase Auth (PKCE, system browser + loopback)   $0
AuthZ/token: OWN backend mints DPoP-bound access tokens         $0
Backend    : Supabase (Postgres + Edge Functions + cron)        $0
Billing    : Polar (MoR, ~4% of revenue, $0 fixed)              $0 until a sale
Issuance   : Ed25519 entitlement JWT in the backend             $0
Signing    : Apple $99/yr + Azure Trusted Signing ~$10/mo   ← the ONLY cost, operator's
```

This is a **fill-in of the shipped FAKE contracts, not a redesign**:
`fake-idp.ts` → Supabase Auth + own token endpoint; `fake-entitle.ts`
`/mor/webhook` → Polar webhook (same timestamped-HMAC + idempotency shape);
`fake-entitle.ts` issuer → the backend's Ed25519 signer with the same
`deviceId` + watermark claims. Every gate keeps running on the FAKEs or on
`server/` at loopback — offline, forever.

## 6. Cost summary

| Item | Cost | Who |
|---|---|---|
| IdP, backend host, Sentry/PostHog | **$0** at launch scale | done in-pack |
| MoR | **% of revenue only** ($0 fixed) | operator signs up (free) |
| Apple Developer | $99/yr | **operator (money)** |
| Windows signing (Azure Trusted Signing) | ~$10/mo | **operator (money)** |
| Legal entity | often **deferrable** (MoR is seller of record) | operator, later |

**Everything in this phase is $0.** The founder's only spend is the two
signing lines, taken up *after* this pack lands (their own step).

## 7. Verify-before-you-trust
Pricing, free-tier ceilings, DPoP/PKCE specifics, and MoR payout
eligibility all change. Treat this doc as the shape of the answer; confirm
each number on the provider's own page when you create the account. The
repo's `docs/research/2026-07-productization-accounts-subscriptions.md`
holds the sourced July-2026 snapshot and the primary links.
