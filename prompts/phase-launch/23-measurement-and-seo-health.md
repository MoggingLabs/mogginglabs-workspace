"SEO that actually works" needs a feedback loop — and the site already has
most of the instrument: a first-party privacy collector, admin dashboards,
and a verified Google Search Console. This step CLOSES the loop (content →
conversion, rankings → next post) and adds SEO-health monitoring, all
without adding a single third-party request. Work in
`../MoggingLabs-Website`; extend `prompts/admin-page`'s frozen collector.

## Steps
1. **Extend the first-party collector, don't replace it**: the `/api/t` →
   Neon `events` pipeline already tracks traffic with zero cookies and zero
   third-party requests (that is why Lighthouse is 100). Add content-type +
   CTA events (post read, docs → download intent, pricing view, changelog
   view) to the SAME collector; NEVER add PostHog/Plausible/GA — it would
   break the zero-third-party law.
2. **Close the Search Console loop**: GSC is already verified with the
   sitemap submitted. Document (`prompts/admin-page` or a new note) the
   monthly review — impressions/CTR/avg-position per /learn cluster and per
   new page — and feed findings back into the content plan (18/20) and the
   newsroom (22). Bing Webmaster is a free add if not done.
3. **The measurement view** (admin): a content→conversion panel in the
   existing admin (top landing pages, blog/news traffic, download/early-
   access conversion, the /changelog + RSS pull) using the daily-rollup
   infra already there — one more dashboard, not a new stack.
4. **SEO-health monitoring**: a scheduled re-run of the frozen SEO gates
   against the LIVE edge (Lighthouse budget + `validate-schema` +
   `check-cluster` + `check-mcp-links`), so a production regression (a
   slipped CWV, a dead MCP link, a broken schema) surfaces on a cadence
   rather than in a ranking drop. Reuse the site's `curl --resolve` edge
   verification.
5. **KPI definition**: write the KPI set + review cadence
   (`prompts/website/MEASUREMENT.md`) so the loop is repeatable — what we
   watch, how often, what it changes.

## Files
- `../MoggingLabs-Website/src/app/api/t/route.ts` (new event types) ·
  admin dashboard (content→conversion panel) · a scheduled SEO-health check
  (Vercel cron or CI) · `prompts/website/MEASUREMENT.md` · `CHECKLIST.md`
  (mark 23)

## Definition of Done
- Content + CTA events flow through the EXISTING first-party collector;
  zero third-party requests + zero cookies + Lighthouse 100 preserved.
- The Search-Console review + Bing (if added) + the KPI set + cadence are
  documented; a content→conversion admin view exists on the existing infra.
- A scheduled SEO-health check re-runs the frozen gates against the live
  edge and flags regressions.

## Checks that must be green
- `npm run build` clean; the frozen SEO gates green; Lighthouse 100 ×4 on
  any touched page; the collector still emits no third-party request
  (verify in the network panel / a request-count assertion).

## Guardrails
- NO third-party analytics — the first-party collector is the whole point;
  a script tag to GA/PostHog/Plausible is rejected outright.
- Privacy first — no raw IP, no PII, honor the existing visitor-hash design
  (ADR-equivalent to the app's telemetry stance).
- Never claim a ranking Claude can't observe; the loop measures, it doesn't
  assert.
