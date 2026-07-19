The public docs (`/docs`, /docs/features, /docs/automation, /docs/security)
are hand-authored and predate half the product. Make them COMPLETE and
keep them in sync with the shipping app — every feature a user might need,
findable — with a coverage gate that ties the site's docs to the
Workspace's real feature set. Work in `../MoggingLabs-Website`, extend the
existing `/docs` shell.

## Steps
1. **Docs IA to completeness**: audit `/docs*` against the Workspace app
   (its `docs/` + the phase-launch `INVENTORY.md` if present) and fill the
   gaps — get-started/install per-OS, first run, the multi-pane grid,
   workspaces/worktrees, the board + swarm + reviewer-gated merges, the
   browser dock, usage/failover, integrations, the **Brain** (code graph +
   memory), **accounts/entitlements + the Free/Pro/Team/Enterprise line**, the
   `mogging` control CLI (every verb), MCP config, troubleshooting
   (SmartScreen/Gatekeeper, native rebuilds, offline), security & privacy.
2. **Sync, don't fork**: the Workspace repo's `docs/` is the SOURCE of
   truth for behavior; the site's docs are the user-facing rendering.
   Where a fact is generated in the app (CLI verbs, MCP tools from the
   typed contracts), derive the reference list rather than retype it, so it
   can't drift. Cross-link to app docs where appropriate.
3. **Keep the site's idioms**: `PageShell`/`DocSection`, per-page
   `metadata`, TechArticle + Breadcrumb JSON-LD via `json-ld.tsx`, a real
   in-page nav; static output, zero third-party, Lighthouse 100. Add each
   new doc page to `sitemap.ts` + `llms.txt` in the same step.
4. **DOCS coverage gate** (`scripts/check-docs-coverage.mjs` in the site
   repo, added to its build/CI): fails if a shipped Workspace feature or a
   `mogging` verb has no docs page or reference entry, or a docs link is
   broken. It reads the Workspace feature list (a committed manifest or the
   `INVENTORY.md`) as the denominator. Evidence file under the site's
   convention.
5. **Honesty**: troubleshooting tells the real story (unsigned warnings
   until signing lands, the arm64-only mac note); nothing is glossed;
   in-development features are labeled.

## Files
- `../MoggingLabs-Website/src/app/(site)/docs/**` · a Workspace-feature
  manifest or `INVENTORY.md` reference · `scripts/check-docs-coverage.mjs`
  · `src/app/sitemap.ts` · `public/llms.txt` · `CHECKLIST.md` (mark 19)

## Definition of Done
- The docs cover every shipped feature + every `mogging` verb; a user can
  find install, first-run, each capability, security/privacy, and
  troubleshooting.
- The reference lists derive from the app's typed contracts (no hand-drift);
  the DOCS coverage gate is green + bite-proven (hide a verb → red).
- New pages carry schema + sitemap + llms.txt entries; Lighthouse 100 holds.

## Checks that must be green
- `npm run build` clean; DOCS coverage gate green; `validate-schema` +
  link-check green; Lighthouse 100 ×4 on touched docs pages; deploy-preview
  verified through the edge.

## Guardrails
- Docs derive from the Workspace's real behavior — never document a feature
  that doesn't ship or in a way its source contradicts.
- Zero third-party, Lighthouse 100, no em-dash/competitor — the docs obey
  the same laws as every public page.
- Completeness is gated, not asserted; a new app feature owes a docs page.
