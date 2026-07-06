06 takes arbitrary entries; this ships the curated **Integrations
Catalog** — presets for the official MCP servers the WEBSITE promises,
**n8n and Google Workspace first (founder priority)**. The list is OPEN:
the next tool is a data row, a registry search, or a pasted entry, never
code. Research: `docs/research/2026-07-third-party-integrations.md`
§4/§6/§8; roster: the site's `src/lib/site.ts`.

## Steps
1. **Presets as data** (01's `McpPreset`): seed the FULL research-§4
   matrix (20 rows, verified 2026-07-05), ORDERED by the site roster —
   n8n first (bearer workflow URL, self-hosted base override), Google
   Workspace second (a GROUP: one card, rows per product —
   Drive/Gmail/Calendar/Chat), then Slack, GitHub, Vercel, Supabase,
   ClickUp, Make, then the rest (Sentry → Higgsfield). Every row carries
   `verifiedAt`; a preset is ONE row — grid, writers, smoke derive.
2. **The verification pass for the site's remaining wall** (7/01 — never
   hardcode unverified): dev-check official servers for every site name
   beyond §4 — Zapier, Jira, Figma, Shopify, Docker, Postman, Replicate +
   the rest of the wall and media chips (list: IMPLEMENTATION §07).
   VERIFIED → preset row + date; not → mapped to registry/custom/bridge
   in docs/14's site-honesty table. Honesty over coverage.
3. **Connect**: catalog grid in 06's module → Connect prefills → env-ref
   slots for key tools (secret literals refused) → base-URL override →
   diff preview → 06's writers, nothing new below them.
4. **The open end** — three on-ramps, ONE pipeline: (a) registry search
   (registry.modelcontextprotocol.io) → DRAFT badged "community — not
   house-vetted"; (b) 06's custom form; (c) preset JSON import/export.
   Same refusals → diff preview → writers for all three. The registry
   doubles as the presets' UPDATE FEED — explicit, previewed, never
   auto-applied, never a trust source.
5. **Authorize**: per CLI, orchestrate its OWN MCP-OAuth in a managed PTY
   (auth-settings pattern — e.g. `/mcp` authorize). Vendor authenticates;
   the CLI stores the token; we observe STATUS only (config presence +
   list output). N consents, N tokens — per-CLI revocation, zero us.
   Per-CLI capability table (data): who speaks remote-HTTP+OAuth at which
   version floor; gaps dim the chip. NO `mcp-remote` proxy in v1.
6. **MCPCAT smoke** (`MOGGING_MCPCAT`, env-gated, in qa-smokes.sh):
   fixture homes + FIXTURE registry JSON — preset lands dialect-correct
   in all three CLIs; n8n base override lands; a GROUP lands all rows;
   registry draft + badge; import refuses a secret literal; capability
   gating dims; status read-back; refresh = PREVIEW diff only. Verdict
   `out/mcpcat-result.json`; zero network.

## Files
- `@backend/features/integrations/` (presets.json, registry client,
  capability table) · `settings/integrations.ts` · mcpcat-smoke.ts ·
  qa-smokes.sh · gallery · books

## Definition of Done
- Books: real self-hosted n8n connected (agent lists its workflow tools)
  + one OAuth preset authorized for Claude Code — frames, dated; one
  registry-found server through the same pipeline.
- The verification pass recorded: every site-named tool is preset or
  explicitly mapped — no silent drops.
- Scope-per-workspace is the default UX (grants mitigate catalog bloat).
- MCPCAT gate green; gallery: the grid, both themes.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- We never run, proxy, or authenticate a server; tokens live in the CLIs;
  keys are env-ref pointers (0008.d), also on import.
- App-held OAuth stays DEFERRED behind its own ADR; MCP covers the need.
- Stripe (money) and Slack (speaks as you) get the LOUDEST grantCopy;
  community entries default cautious; the reviewer gate is the boundary.
- Preset data is public-safe (repo public until ~Aug 2026).
