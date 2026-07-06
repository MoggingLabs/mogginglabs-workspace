The manager (05) takes arbitrary server entries; this step ships a
curated **Integrations Catalog** — preset entries for
the official MCP servers of the tools people actually use, so "connect
Sentry to every hosted agent" is one click + one browser consent per CLI.
The ecosystem converged to meet us (2026: official remote servers, OAuth
done by the CLI itself) — the app registers and orchestrates, holds
nothing. Research: `docs/research/2026-07-third-party-integrations.md`.

## Steps
1. **Presets as data** (the 8/01 discipline): `McpPreset { id, label,
   vendor, transport, urlOrCommand, authKind: 'oauth'|'key-header'|
   'ambient-cli'|'bearer-url', envRefSlots, baseUrlOverride?, cliQuirks,
   grantCopy }`. Seed from the research matrix: GitHub, GitLab, Sentry,
   Supabase, Notion, Stripe, Vercel, Cloudflare, Slack, Tally, Google
   Workspace (per-product), AWS, Azure, PostHog, fal.ai, ElevenLabs,
   ClickUp, Higgsfield, n8n, Make. The official MCP registry
   (registry.modelcontextprotocol.io) is an UPDATE FEED —
   explicit refresh, diff-previewed, never auto-applied, never a trust
   source; curation stays ours.
2. **Connect**: catalog grid in Settings § Integrations → Connect
   prefills a registry entry → env-ref slots for key-based tools
   (`${POSTHOG_API_KEY}`; secret literals refused, house heuristics) →
   self-hosted base-URL override (GitLab/Sentry/n8n) → diff preview →
   surgical write via 05's writers. Nothing new below the writers.
3. **Authorize**: per CLI, orchestrate that CLI's OWN MCP-OAuth step in a
   managed PTY (the auth-settings pattern — Claude Code's `/mcp`
   authorize, Codex's MCP login), browser consent via `shell.openExternal`.
   The vendor authenticates the user; the CLI stores the token; we observe
   STATUS only — config presence + the CLI's own list/status output, never
   token contents. N CLIs = N consents = N tokens, each held by its
   CLI — a feature (per-CLI revocation, zero us).
4. **Per-CLI capability table** (data): which CLI speaks remote-HTTP+OAuth
   at which tested-version floor; unsupported combos dim the preset chip
   with the reason. NO `mcp-remote` proxy fallback in v1.
5. **MCPCAT smoke** (`MOGGING_MCPCAT`, env-gated, in qa-smokes.sh):
   fixture homes — a preset lands dialect-correct in all three CLIs;
   env-ref slot refuses a literal; base-URL override lands; capability
   gating dims; status read-back from fixture config + faked status
   output; registry refresh produces a PREVIEW diff and changes nothing
   until applied. Zero network; verdict via `out/mcpcat-result.json`.

## Files
- `src/backend/features/integrations/` (presets, capability table,
  status read-back) · `src/ui/features/settings/` (catalog grid,
  connect/authorize flows) · `src/main/mcpcat-smoke.ts` ·
  `scripts/qa-smokes.sh` (gate row) · `src/main/gallery.ts` (both themes)

## Definition of Done
- Dev-verified in the books: ONE real preset (Sentry) connected +
  authorized for Claude Code from the app; the agent lists its tools —
  frames recorded.
- Scope-per-workspace is the default UX (20 servers × dozens of tools would
  drown agent context; grants are the mitigation).
- MCPCAT gate green; gallery has the grid in both themes.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- We never run, proxy, or authenticate a server; tokens live in the
  CLIs. KEYS are env-ref pointers (ADR 0008.d) — never stored.
- App-held OAuth (posting as the app, Drive-in-our-UI) stays DEFERRED
  behind its own ADR; MCP covers the user-facing need.
- Stripe (money) and Slack (speaks as you) presets carry the LOUDEST
  `grantCopy` — injection risk grows with every tool an agent can call;
  the reviewer gate stays the boundary.
- Preset data is public-safe (repo public until ~Aug 2026); no vendor-
  relationship notes in the repo.
