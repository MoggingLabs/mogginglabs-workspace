The site tells an old story: it predates the Brain and the accounts
tier, quotes v0.4.0 numbers, and prices nothing. Bring every public page
CURRENT and COMPLETE against the shipped Workspace — truthfully, in the
founder's voice — and re-verify the frozen SEO gates so the refresh can't
regress them. Work in `../MoggingLabs-Website`. Extend, never rebuild.

## Steps
1. **Refresh product truth** across home, /learn (pillar + 4 spokes),
   /docs*, /roadmap, /about, /mcp-servers: fold in the **Brain** (the
   deterministic code graph + memory the app now ships) and the
   **accounts/entitlements** tier, and update the reliability numbers to
   the current release audit (never invent — trace each to the Workspace
   git truth, the site's own rule). Retire "v0.4.0" and any claim the
   product outgrew.
2. **The pricing page** (`/pricing`): render from **`TIERS.md`** (the
   matrix, not prose) — **Free** (2 workspaces, 4 panes, all integrations)
   · **Pro $19/mo ($15 annual)** (unlimited workspaces, 16 panes, 3
   devices) · **Team $29/seat** · **Enterprise** — on the "no credits, no
   metering, BYO agents" wedge. **Team + Enterprise are WAITLIST:
   contact-us only, NO checkout button** (no Stripe product exists; a buy
   button that cannot transact is the worst version of this). **Any benefit
   without a `TIERS.md` row or flag is labelled in-development —
   `cross-machine sync` specifically, which this pack does NOT build.**
   Print **price-lock** + the **7-day money-back guarantee** only because
   10/15 make them real. Keep FAQPage schema honest; update
   `src/lib/site.ts` if the CTA moved.
3. **Fill real gaps** the freshness audit (17) found: any shipped
   capability with no page or a thin one (the Brain deserves a /learn
   spoke or a docs section; accounts/BYO-neutrality a trust surface).
   New page → new `metadata`, `json-ld.tsx` schema, `sitemap.ts` +
   `llms.txt` in the SAME step (their global check).
4. **Honesty pass**: integrations stay framed as in-development where they
   are; early-access vs public-download copy matches reality; every claim
   traces to the product. Reconcile with the app's wording gate so the
   free-core promise reads identically on both sides.
5. **Re-verify the frozen gates** on the changed bytes: `build` clean,
   `validate-schema.mjs` 0 errors, `check-cluster.mjs` + `check-mcp-
   links.mjs` green, **Lighthouse 100/100/100/100** on every touched page,
   em-dash/competitor greps at 0.

## Files
- `../MoggingLabs-Website/src/app/(site)/**` (home, learn, docs, roadmap,
  pricing, about, mcp-servers) · `src/lib/site.ts` · `src/components/
  json-ld.tsx` · `src/app/sitemap.ts` · `public/llms.txt` ·
  `WEB-FINDINGS.md` (resolved) · `CHECKLIST.md` (mark 18)

## Definition of Done
- No public page states a stale product: Brain + accounts + pricing true;
  **every sellable claim traces to a `TIERS.md` row, everything else is
  labelled in-development (sync, Team, Enterprise) with no checkout
  path**; every WEB-FINDINGS gap closed or deferred with reason.
- Every new/changed page carries valid structured data and is in
  `sitemap.ts` + `llms.txt`; frozen SEO gates + Lighthouse 100 hold.
- Copy obeys the laws (no em-dash, no competitor, no invented number, no
  fake rating); pricing matches `PRICING-STRATEGY.md` exactly.

## Checks that must be green
- `npm run build` clean; `validate-schema` / `check-cluster` /
  `check-mcp-links` green; Lighthouse 100 ×4 on every touched page;
  em-dash + competitor greps → 0; deploy-preview verified through the edge.

## Guardrails
- Truth outranks keywords — never add a feature/metric/review that isn't
  real; trace each claim to the Workspace source.
- Zero third-party requests, zero cookies, Lighthouse 100 are inviolable —
  a refresh that dents them is reverted.
- Extend the frozen phases; do not reopen seo-authority's shipped pages
  except to correct a now-false claim.
