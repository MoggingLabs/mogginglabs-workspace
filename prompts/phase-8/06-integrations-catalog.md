The manager (05) takes arbitrary entries; this step ships a curated
**Integrations Catalog** — presets for the official MCP servers people
actually use: connecting Sentry to every hosted agent becomes one click
+ one consent per CLI. And the list is OPEN: the 21st tool is a data
row, a registry search, or a pasted entry — never a code change.
Research: `docs/research/` (2026-07 integrations).

## Steps
1. **Presets as data** (the 8/01 discipline): `McpPreset { id, label,
   transport, urlOrCommand, authKind: 'oauth'|'key-header'|'ambient-cli'
   |'bearer-url', envRefSlots, baseUrlOverride?, cliQuirks, grantCopy }`. Seed from the research §4: GitHub, GitLab, Sentry,
   Supabase, Notion, Stripe, Vercel, Cloudflare, Slack, Tally, Google
   Workspace, AWS, Azure, PostHog, fal.ai, ElevenLabs, ClickUp,
   Higgsfield, n8n, Make. A curated preset is ONE row — grid,
   writers, smoke derive from the data.
2. **Connect**: catalog grid in Settings § Integrations → Connect
   prefills an entry → env-ref slots for key tools (secret literals
   refused) → self-hosted base-URL override (GitLab/Sentry/n8n) → diff
   preview → 05's writers. Nothing new below the writers.
3. **The open end** — three on-ramps past the presets, ONE pipeline:
   (a) "Add from registry…" searches the official registry
   (registry.modelcontextprotocol.io), prefills a DRAFT from its
   metadata, badged "community — not house-vetted"; (b) "Add custom…" =
   05's arbitrary-entry form; (c) import a preset JSON (export too —
   teams share a stack). All three land in the same refusals → diff
   preview → writers path. The registry doubles as the presets' UPDATE
   FEED — explicit, diff-previewed, never auto-applied, never a trust
   source.
4. **Authorize**: per CLI, orchestrate its OWN MCP-OAuth step in a
   managed PTY (the auth-settings pattern; e.g. Claude Code's `/mcp`
   authorize). The vendor authenticates; the CLI stores the token; we
   observe STATUS only (config presence + the CLI's list output, never
   tokens). N consents, N tokens — per-CLI revocation, zero us.
5. **Per-CLI capability table** (data): who speaks remote-HTTP+OAuth at
   which tested-version floor; unsupported combos dim the chip,
   reasoned. NO `mcp-remote` proxy fallback in v1.
6. **MCPCAT smoke** (`MOGGING_MCPCAT`, env-gated, in qa-smokes.sh):
   fixture homes + a FIXTURE registry JSON — a preset lands dialect-
   correct in all three CLIs; registry draft lands too, badge asserted;
   import refuses a secret literal; base-URL override lands; capability
   gating dims; status read-back works; refresh = PREVIEW diff, nothing
   changes until applied. Zero network; verdict `out/mcpcat-result.json`.

## Files
- `src/backend/features/integrations/` (presets, registry client,
  capability table) · `src/ui/features/settings/` (grid, on-ramps,
  authorize) · `src/main/mcpcat-smoke.ts` · `scripts/qa-smokes.sh` (gate
  row) · `src/main/gallery.ts` (both themes)

## Definition of Done
- Books: ONE real preset (Sentry) connected + authorized for Claude
  Code, agent lists its tools — frames recorded; plus one registry-found
  server through the same pipeline.
- Scope-per-workspace is the default UX (20+ servers would drown agent
  context; grants are the mitigation).
- MCPCAT gate green; gallery has the grid, both themes.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- We never run, proxy, or authenticate a server; tokens live in the
  CLIs. Keys are env-ref pointers (ADR 0008.d), also on import.
- App-held OAuth stays DEFERRED behind its own ADR; MCP covers the need.
- Stripe (money) and Slack (speaks as you) carry the LOUDEST grantCopy;
  community entries get cautious defaults — injection risk grows with
  every tool; the reviewer gate stays the boundary.
- Preset data is public-safe (repo public until ~Aug 2026).
