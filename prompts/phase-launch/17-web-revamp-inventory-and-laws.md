Part III revamps the EXISTING company site — it does not build one. The
site is live at `mogginglabs.com` (Next.js 16 · Tailwind v4 · Vercel behind
Cloudflare · Neon), with the `seo-authority` and `admin-page` phases shipped
and FROZEN. This step inventories what's there, audits it against the
shipped product, and adopts the site's own laws — no code, just the map the
rest of Part III fills. Work in `../MoggingLabs-Website`.

## Steps
1. **Read the ground truth first**: `../MoggingLabs-Website/README.md`,
   `prompts/seo-authority/{README,REPORT}.md`, `prompts/admin-page/
   README.md`, `PRICING-STRATEGY.md`, `GROWTH-PLAN.md`, `NEWSLETTER-PLAN.md`,
   `src/lib/site.ts`. These bind every later step; do not contradict them.
2. **The laws, restated in this pack** (`prompts/phase-launch/
   RESEARCH-web.md` cross-link): Lighthouse **100/100/100/100** on every
   public page; **zero third-party requests, zero cookies**; **no
   em-dashes, no exclamation marks, no AI-tell copy**; **never name a
   competitor** on the public site; **no fake ratings**; **truth outranks
   keywords**; `src/lib/site.ts` is the single source of truth; a new page
   updates `sitemap.ts` + `llms.txt` in the SAME step.
3. **Inventory** (`prompts/phase-launch/WEB-INVENTORY.md`): every public
   route (the ~20 pages, /learn cluster, /mcp-servers, /blog, /docs*,
   /pricing, /roadmap, legal), each admin/API surface, each existing SEO
   gate (`validate-schema`, `check-cluster`, `check-mcp-links`), and the
   analytics collector — with a `file:line` and its current freshness.
4. **The freshness audit**: the site predates the **Brain** and the
   **accounts/entitlements** work and states an older product (v0.4.0
   numbers, "early access", no Brain). Grade each page STALE / OK against
   the shipped Workspace (v0.14.0; the Brain; Free/**Pro $19**/**Agency
   $39** pricing) and the roadmap — route each gap to `WEB-FINDINGS.md`
   (page · claim · reality · fix). Truth-outranks-keywords is the test.
5. **Gap map to the net-new work**: mark what only NEEDS extending (SEO,
   structured data, analytics — mostly done) vs what is genuinely new
   (blog content, `/changelog`, the industry-watch track, X) so 18–25
   don't re-buy shipped work.

## Files
- `prompts/phase-launch/WEB-INVENTORY.md` · `WEB-FINDINGS.md` ·
  `RESEARCH-web.md` (cross-link) · `CHECKLIST.md` (mark 17) — all authored
  in the workspace pack; the audited code lives in `../MoggingLabs-Website`.

## Definition of Done
- WEB-INVENTORY lists every public route + gate + the analytics collector
  with freshness; no surface unlisted.
- Every stale claim (product version, feature set, pricing, the missing
  Brain/accounts story) is routed in WEB-FINDINGS with the true replacement.
- The gap map cleanly separates extend-existing from net-new; the site's
  laws are restated as binding on 18–25.

## Checks that must be green
- No site code changed this step (audit only), so the site build +
  Lighthouse + the frozen SEO gates stay green untouched; the workspace
  app sweep is untouched.

## Guardrails
- Revamp, never rebuild — the frozen phases (seo-authority, admin, demo,
  ambient) are extended, never reopened.
- Adopt the site's laws verbatim; a finding that would break Lighthouse
  100, add a third-party request, or name a competitor is rejected.
- This step writes docs only — zero product/site code.
