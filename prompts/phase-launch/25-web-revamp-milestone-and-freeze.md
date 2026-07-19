Close Part III and the whole pack: a composed check that the revamped site
is current, fast, and honest, a REPORT in the site's own freeze convention,
and the OVERALL launch freeze that certifies both the product (step 16) and
the web presence are v1.0.0-ready except the operator's named steps. Work
in `../MoggingLabs-Website` for the site side.

## Steps
1. **WEBREVAMP check** (`scripts/check-web-revamp.mjs` in the site repo, in
   its build/CI): one composed pass on the built + edge-deployed site —
   (a) every public page holds **Lighthouse 100/100/100/100**; (b) the
   frozen SEO gates pass (`validate-schema` 0 errors, `check-cluster`,
   `check-mcp-links`); (c) **no page states a stale product** (a grep/
   assert for retired claims: old version strings, "no Brain", missing
   pricing) — freshness held; (d) `sitemap.ts` + `llms.txt` include every
   new page (blog, changelog, industry hubs); (e) the **changelog dry-run**
   (21) renders `/changelog` + RSS from a fake tag; (f) em-dash +
   competitor-name greps → 0; (g) zero third-party requests confirmed.
2. **The site REPORT** (`prompts/website/…/REPORT.md`, matching the
   seo-authority/admin freeze style): what shipped in the revamp, the
   measured Lighthouse scores, the new URLs + their target intents, the
   cross-repo changelog proof, and the honest certification — local +
   edge gates green; the live GSC re-crawl + real ranking movement stay
   PENDING-observation (Claude never claims a ranking).
3. **The going-live runbook, completed** (`docs/25-going-live.md` in the
   Workspace repo gains the web section): the ordered operator steps —
   deploy the revamp (`vercel deploy --prod --yes`), verify through the
   Cloudflare edge, resubmit the sitemap to GSC, flip the site's
   `PRIMARY_CTA` to the public download when signing lands, then activate
   social (24). Each: cost ($0 — domain owned, GSC verified), what it
   unblocks, how to verify.
4. **The overall pack freeze** (phase-launch README): the FULL gate table
   (Parts I-III) with the honest status of each — Part I/II product gates +
   Part III site gates green locally/edge; the CI-OS sweep, `server`/backend
   deploy, code signing, and live-ranking observation stay PENDING-operator.
   Walk the WHOLE `CHECKLIST.md`; every non-operator box checked. `docs/02`
   + `prompts/README.md` gain the pack's shipped-form rows.

## Files
- `../MoggingLabs-Website/scripts/check-web-revamp.mjs` + its CI wire +
  `prompts/website/…/REPORT.md` · Workspace `docs/25-going-live.md` (web
  section) · `docs/02` · `prompts/README.md` · phase-launch README (freeze)
  · `CHECKLIST.md` (final full verify)

## Definition of Done
- WEBREVAMP green on the built + edge site: Lighthouse 100 everywhere, SEO
  gates pass, no stale claim, all new pages in sitemap + llms.txt, changelog
  dry-run renders, greps at 0, zero third-party.
- The site REPORT is written in the freeze convention; `docs/25-going-live.md`
  covers BOTH the product flip (16) and the web flip.
- The whole CHECKLIST (Parts I-III) is checked or PENDING-operator with a
  reason; the overall freeze table is honest about what's PENDING.

## Checks that must be green
- Website: `npm run build` clean; WEBREVAMP + all frozen SEO gates green;
  Lighthouse 100 ×4 on a page-per-type; edge verification via `curl
  --resolve`. Workspace: V1MILESTONE (16) + full static battery still green;
  gate-count re-derived and every prose count matching.

## Guardrails
- The milestone composes existing gates — nothing lands here a Part-III
  step didn't already own.
- PENDING-operator stays PENDING; Claude never claims a live deploy, a GSC
  ranking, a signed build, or a full three-OS sweep it did not run.
- Every site law holds to the end — Lighthouse 100, zero third-party, no
  em-dash, no competitor, truth over keywords.
