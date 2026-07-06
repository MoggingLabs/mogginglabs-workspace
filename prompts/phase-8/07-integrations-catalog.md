06 takes arbitrary entries; this ships the curated **Integrations
Catalog** — presets for the official servers the WEBSITE promises,
**n8n and Google Workspace first (founder priority)**. The list is OPEN:
a data row, a registry search, or a pasted entry — never code.
Research: `docs/research/2026-07-third-party-integrations.md` §4/§6/§8;
roster: the site's `src/lib/site.ts`.

## Steps
1. **Presets as data** (01's `McpPreset`): seed the FULL research-§4
   matrix (20 rows, verified 2026-07-05), ORDERED by the site roster —
   n8n first (bearer workflow URL, self-hosted base override), Google
   Workspace second (a GROUP: one card, rows per product), then Slack,
   GitHub, Vercel, Supabase, ClickUp, Make, then the rest (Sentry →
   Higgsfield). Rows carry `verifiedAt`; a preset is ONE row — grid,
   writers, smoke derive.
2. **The verification pass for the site's remaining wall** (7/01 — never
   hardcode unverified): dev-check official servers for every site name
   beyond §4 (list: IMPLEMENTATION §07). VERIFIED → preset row + date;
   not → registry/custom/bridge in docs/14's site-honesty table.
   Honesty over coverage.
3. **Connect**: catalog grid in 06's module → Connect prefills →
   key/vault slots → base-URL override → diff preview → 06's writers.
   `authKinds` is an ARRAY: vendors with BOTH OAuth and token auth
   (Sentry, Supabase, GitHub) surface the second on-ramp as "one token,
   all agents" via the vault — the UI states the trade (per-CLI
   revocation vs one paste); default = vendor-preferred (IMPLEMENTATION:
   the cross-agent answer).
4. **The open end** — three on-ramps, ONE pipeline: (a) official-registry
   search → DRAFT badged "community — not house-vetted"; (b) 06's custom
   form; (c) preset JSON import/export.
   Same refusals → diff preview → writers for all three. The registry
   doubles as the presets' UPDATE FEED — explicit, previewed, never
   auto-applied, never trusted.
5. **Authorize**: per CLI, orchestrate its OWN MCP-OAuth in a managed
   PTY (the auth-settings pattern). Vendor authenticates; the CLI
   stores the token; we observe STATUS only —
   N approve-clicks, N tokens, per-CLI revocation, zero us. Per-CLI
   capability table: who speaks remote-HTTP+OAuth at which version
   floor; gaps dim the chip. NO `mcp-remote` proxy in v1.
6. **MCPCAT smoke** (`MOGGING_MCPCAT`, env-gated, in qa-smokes.sh):
   fixture homes + FIXTURE registry JSON — preset lands dialect-correct
   in all three CLIs; n8n base override lands; a GROUP lands all rows;
   a dual-auth preset offers the vault slot; registry draft + badge;
   import refuses a secret literal; capability gating dims; status
   read-back; refresh = PREVIEW diff only. Verdict
   `out/mcpcat-result.json`; zero network.

## Files
- `@backend/features/integrations/` (presets.json, registry client,
  capability table) · `settings/integrations.ts` · mcpcat-smoke.ts ·
  qa-smokes.sh · gallery · books

## Definition of Done
- Books: real self-hosted n8n connected (agent lists its tools) + one
  OAuth preset authorized for Claude Code — frames, dated; one registry
  server through the pipeline.
- The verification pass recorded: every site-named tool is preset or
  mapped — no silent drops.
- Scope-per-workspace is the default UX — 09's plans are the mechanism;
  Connect never implies everywhere.
- MCPCAT gate green; gallery: grid.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- We never run, proxy, or authenticate a server; tokens live in the CLIs;
  keys are env-ref pointers (0008.d), also on import.
- App-held OAuth stays DEFERRED (own ADR); MCP covers the need.
- Stripe (money) and Slack (speaks as you) get the LOUDEST grantCopy;
  community entries default cautious; the reviewer gate is the boundary.
- Preset data is public-safe (repo public until ~Aug 2026).
