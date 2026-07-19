# Phase Launch — RESEARCH (web): the site EXISTS — this is a revamp

Grounds **Part III** (17–25). **Correction to an earlier draft of this
file:** we are NOT building a site from scratch and NOT using Astro. The
company site is **live at `mogginglabs.com`**, already deployed, already
ranked-for-intent. Part III **revamps and extends it**; it never rebuilds
it. Read `../MoggingLabs-Website/README.md` + `prompts/seo-authority/
REPORT.md` first — they are the ground truth.

> **Where the site actually is** (sibling repo `../MoggingLabs-Website`):
> - **Next.js 16** (App Router) · TypeScript · **Tailwind v4** · fully
>   static output · **Vercel Hobby** behind the **Cloudflare** proxy ·
>   deploy `vercel deploy --prod --yes`. **Neon** Postgres for the admin
>   backend.
> - **Frozen, shipped phases** (do not rebuild — extend): `prompts/
>   seo-authority/` (brand-disambiguation metadata on all 20 pages, a
>   resolved JSON-LD `@id` graph, a `/learn` topic cluster, a 40-server
>   `/mcp-servers` directory, `validate-schema`/`check-cluster`/
>   `check-mcp-links` gates, **GSC verified + sitemap submitted**,
>   `public/llms.txt`); `prompts/admin-page/` (a **first-party privacy
>   analytics collector** `/api/t` → Neon, dashboards, newsletter via
>   Loops, early-access CRM, a **Stripe revenue ledger**); `interactive-
>   demo`; `ambient-background`; `website`.
> - **Laws that bind every change** (from their READMEs — non-negotiable):
>   **Lighthouse 100/100/100/100** on every public page · **zero
>   third-party requests, zero cookies** · **no em-dashes, no exclamation
>   marks, no AI-tell copy** · **never name a competitor** on the public
>   site (disambiguate by owning our semantics) · **no fake ratings** ·
>   **truth outranks keywords** · `src/lib/site.ts` is the single source of
>   truth for links/CTA/roster · copy provenance lives in `prompts/
>   website/` (CONTEXT/COMPETITIVE/COPY/DESIGN).

## 1. Platform — it's Next.js, and it stays

No framework decision to make: extend the existing Next.js app. Use its
idioms — the `metadata` export per route, `src/components/json-ld.tsx`
helpers, `PageShell`/`DocSection`, `src/lib/site.ts`, the `robots.ts`/
`sitemap.ts`/`llms.txt` surfaces, and the npm-script + Lighthouse + grep
gates the site already runs. New content is a new route + a sitemap +
llms.txt entry in the SAME step, per their global check.

## 2. SEO — mostly DONE; this is audit + freshness, not a build

The `seo-authority` phase already shipped brand metadata, the `@id`
structured-data graph, the `/learn` cluster, the `/mcp-servers` directory,
and **GSC is verified with the sitemap submitted**. So Part III's SEO
energy is: (a) **keep it TRUE and CURRENT** — the pages describe the
product; the product shipped the Brain + accounts since, so content is
stale and must be refreshed; (b) **extend** structured data + the cluster
to any new page (blog posts, changelog, industry hub) with the existing
helpers + gates; (c) a light **SEO regression gate** that re-runs the
frozen checks (schema/cluster/mcp-links/Lighthouse) so a revamp can't
regress them. No Astro, no new sitemap engine, no re-doing GSC.

## 3. Analytics — first-party ONLY (their collector), never a third party

The site already has a privacy-preserving `/api/t` collector → Neon
`events` + daily rollups + an admin traffic dashboard, with **zero
third-party requests and zero cookies** (that is *why* it holds Lighthouse
100). **Do NOT add PostHog or Plausible to the site** — it would break the
zero-third-party law. Measurement extends the existing collector + GSC:
new content-type events, a content→conversion view in the admin, and a
scheduled edge re-check of Lighthouse/schema/links.

## 4. Billing — Stripe is already the rail (reconciles Part II)

The site runs a **Stripe webhook → append-only `revenue_events` ledger**
(hashed customers, event-id idempotent, 400/200/503 contract) with a
reconcile cron and an admin revenue module. So **Stripe, not Polar, is the
committed billing rail** — and the app's entitlement backend belongs
HERE (Next.js API routes + Neon + Vercel), extending this, not a greenfield
`server/`. The MoR/tax question is real but not a rebuild: **Stripe direct
+ Stripe Tax now**; a **Polar/Paddle MoR wrapper** (both run on Stripe
rails) stays an *optional later* move if global tax filing becomes a
burden. See `RESEARCH.md` §3 (updated) for the reconciliation.

## 5. Pricing — DECIDED, use these exact tiers

From `../MoggingLabs-Website/PRICING-STRATEGY.md` (owner-confirmed, July
2026): **Free** (up to 3 panes, 1 workspace, 1 basic integration,
community support) · **Pro $19/mo ($15 annual)** (unlimited panes/
workspaces/integrations, full notifications, priority email) · **Agency
$39/user/mo ($32 annual)** (shared team workspaces, roles, central
billing, onboarding). Wedge: *no credits, no metering — bring the agents
you already pay for*, aimed at **agency developers**. Part II's entitlement
tiers and the pricing page align to **Free/Pro/Agency**, not Free/Pro/Team.

## 6. Blog — a typed file-based model, extend it

Content is `src/lib/posts.ts` — a typed `Post[]` (sections =
heading/paragraphs/bullets), rendered by `/blog` + `/blog/[slug]` with
TechArticle + Breadcrumb JSON-LD, **one post today**. Grow THIS model
(authors, tags, RSS, more posts) in their idiom — no MDX runtime, no CMS,
nothing that adds a third-party request or dents Lighthouse. Every post
claim must be true at publish (their rule, already in the file's header).

## 7. What is genuinely NET-NEW (where Part III spends its energy)
- A **real blog with content + editorial** (only one post exists).
- The **automated, release-driven changelog** — no `/changelog` exists;
  cross-repo from the Workspace `release.yml` to the site. The strongest
  net-new ask.
- The **industry-watch** track (Claude/Codex/agent news) + its newsroom,
  tied to the existing newsletter (Loops), human-in-the-loop.
- **Content freshness**: the site predates the Brain + accounts; pages,
  /learn, /docs, pricing, roadmap must catch up to the shipped product.
- The **X/social** pipeline (deferred, dormant), per `GROWTH-PLAN.md`.

## 8. Cost — $0 (domain owned, GSC done)

`mogginglabs.com` is registered and deployed; GSC is verified. Vercel
Hobby + Cloudflare + Neon + Loops free tiers carry it. **Nothing in Part
III costs money.** X auto-posting (deferred) may need a paid API tier —
so it stays draft-and-human-post at $0. The only launch spend anywhere is
the product's code signing (Part II, operator's).
