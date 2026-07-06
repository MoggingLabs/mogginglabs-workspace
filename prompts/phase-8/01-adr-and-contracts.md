Integrations start at the DECISION, not the code. Codify "protocols, not
plugins" AND the browser-session boundary as one ADR, then the contracts
seam every lane builds on: ONE tool catalog as data (the shipped browser
tools join it), ONE grant shape (writes + web), the service-adapter
interface. Ships ZERO runtime; three lanes fork.

## Steps
1. **ADR 0008 — integrations are protocols, not plugins** (`docs/adr/`), six
   stances: (a) NO in-process plugin runtime — third-party JS attacks
   rendering reliability and the hardened posture (docs/03).
   (b) The extensibility surface IS the control API + hooks + the ONE
   first-party MCP server (6/05b's bin) — a pure CLIENT of authed
   sockets, stdio only, no TCP; daemon protocol stays v3.
   (c) Write tools grant nothing `mogging send` doesn't; grants are
   catalog hygiene against prompt injection; the reviewer gate is the
   boundary; `approve` is NEVER a tool. (d) Service adapters ride sessions
   the user's tools hold (`gh auth token`, in memory, once). (e) **Web sessions: consent-by-login only.** Agents act on
   real logins ONLY where the user signed in INSIDE the dock (Branch C)
   and granted the origin; reading system cookie stores (Branch B)
   reverses ADR 0002 — its own ADR first (`phase-10/FINDINGS.md`). (f) UI extensibility
   post-v1 via MCP Apps, never npm-in-process.
2. **The unified catalog** (`@contracts/integrations/mcp.ts`): `McpToolDef
   { name, title, description, inputSchema, family: 'browser'|'control',
   access: 'read'|'write'|'act', upstream: 'app'|'daemon', verb }`;
   `MCP_TOOLS: readonly McpToolDef[]`: the 14 SHIPPED browser tools,
   names/schemas verbatim (agents depend on them; reads `'read'`,
   click/type/eval/navigate `'act'`) + control reads (`list_panes`, `capture_pane`, `mail_read`,
   `list_owners`, `list_board`) + control writes (`send_to_pane`,
   `send_key`, `mail_send`, `claim_files`, `release_files`,
   `update_card`). Closed unions, no `any`; dispatch + docs
   derive from it; Phase 2.5 memory tools later APPEND.
3. **The unified grant** (same slice): `WorkspaceIntegrationsGrant {
   workspaceId, writeTools: 'none'|'all'|toolName[], web: 'off'|'public'|
   'signed-in', actOrigins: string[] }` — defaults `'none'`/`'off'`/`[]`.
   `'public'` = today's shipped consent; migration maps the 6/05b boolean. Plus `SENSITIVE_ORIGIN_PATTERNS` (banking/mail/gov)
   that `actOrigins` never overrides — data here, enforced in 03/04.
4. **Service-adapter contracts** (`services.ts`), mirroring
   `@contracts/usage`: `ServiceLink { provider: 'github', kind:
   'pr'|'issue', ref, url }`, `LinkStatus { state, checks?, reviewState?,
   fetchedAt, health: 'fresh'|'stale'|'error'|'unconfigured' }`,
   `ServiceAdapter { id, detect(), fetch(link, signal) }`.
5. **Boundaries**: contracts depend on nothing; grep lines so `@backend`/
   `@ui` reach integrations only via `@contracts/integrations`.

## Files
- `docs/adr/0008-integrations-protocols-not-plugins.md` ·
  `src/contracts/integrations/` (mcp.ts, services.ts, index.ts) ·
  `src/contracts/index.ts` · boundary grep additions

## Definition of Done
- ADR 0008 committed, six stances explicit, cross-refs (0002/0005/0007,
  docs/03/09/13, FINDINGS).
- Catalog typechecks; an assert proves no entry named `approve`, every
  entry valid, browser names matching the shipped server.
- Grant defaults live in the contract itself, not consumer code.

## Checks that must be green
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean.
- Full local sweep unchanged (no runtime, no new gate yet).

## Guardrails
- No implementation — no server edits, no registry, no UI. Lanes
  02/05/06 fork from this commit; keep it mergeable-small.
- Descriptions are written for MODELS (02 serves them verbatim).
- `inputSchema` is plain JSON Schema data — contracts stay dependency-free.
- Verbs are ones the daemon/app endpoint already speak. A tool needing
  NEW capability is out of scope.
