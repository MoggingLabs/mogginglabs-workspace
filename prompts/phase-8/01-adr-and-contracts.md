Integrations start at the DECISION. One ADR codifies "protocols, not
plugins", the browser-session boundary, and the outbound-events stance;
then the contracts every lane builds on. Ships ZERO runtime; lanes fork.

## Steps
1. **ADR 0008 — integrations are protocols, not plugins** (`docs/adr/`),
   seven stances: (a) NO in-process plugin runtime (attacks rendering +
   hardening, docs/03); (b) extensibility = control API + hooks + the ONE
   first-party MCP server — pure client of authed sockets, stdio, no TCP,
   daemon v3; (c) write tools grant nothing `mogging send` doesn't; grants
   = catalog hygiene vs injection; the reviewer gate is THE boundary;
   `approve` NEVER a tool; (d) service adapters ride the user's own tool
   sessions (`gh auth token`, in-memory, once); service keys = POINTERS
   (0007 extended): env-refs or vault slots, never literals; app-held
   OAuth deferred to its own ADR;
   (e) web sessions: consent-by-login only — Branch C, per-origin grants,
   every act trailed locally; system cookie stores = Branch B, reverses
   0002, own ADR first (`phase-10/FINDINGS.md`); (f) UI extensibility
   post-v1 via MCP Apps, never npm-in-process; (g) outbound events =
   user-configured webhooks — POST only, nothing listens, URLs are secrets
   (vault/env-ref), versioned documented payload of ids + the user's own
   note text, never scrollback/diffs/page content/origins.
2. **The unified catalog** (`@contracts/integrations/mcp.ts` + JSON
   source): `McpToolDef { name, title, description, inputSchema, family:
   'browser'|'control', access: 'read'|'write'|'act', upstream:
   'app'|'daemon', verb }`; `MCP_TOOLS` = the 14 SHIPPED browser tools,
   names/schemas verbatim + reads (`list_panes`, `capture_pane`,
   `mail_read`, `list_owners`, `list_board`) + writes (`send_to_pane`,
   `send_key`, `mail_send`, `claim_files`, `release_files`,
   `update_card`). Closed unions, no `any`; dispatch + docs derive from
   it; Phase 2.5 memory tools APPEND later.
3. **The unified grant**: `WorkspaceIntegrationsGrant { workspaceId,
   writeTools: 'none'|'all'|toolName[], web: 'off'|'public'|'signed-in',
   actOrigins: string[] }` — defaults `'none'`/`'off'`/`[]`; `'public'` =
   today's shipped consent; migration maps the 6/05b boolean. Plus
   `SENSITIVE_ORIGIN_PATTERNS` (banking/mail/gov) that `actOrigins` never
   overrides — data here, enforced 03/04.
4. **Trail + bridge + preset + service shapes** (data only): `TrailEntry
   { ts, source:'web'|'mcp'|'bridge', workspaceId, pane?, verb, target,
   outcome:'ok'|'refused'|'confirmed', reason? }`; `IntegrationWebhook
   { id, label, urlRef, events, workspaceId? }` + `BridgeEvent { v:1,
   event, ts, workspace, pane?, card?, note? }` (closed union: needs-you ·
   notify · card-moved · review-changed); `McpPreset` (id, label,
   transport, urlOrCommand, authKind, envRefSlots, baseUrlOverride?,
   cliQuirks, grantCopy, verifiedAt); `ServiceLink`/`LinkStatus`/
   `ServiceAdapter` mirroring `@contracts/usage`. Boundaries: contracts
   depend on nothing; the boundary greps hold.

## Files
- `docs/adr/0008-integrations-protocols-not-plugins.md` ·
  `src/contracts/integrations/` · `src/contracts/index.ts` · boundary greps

## Definition of Done
- ADR 0008 committed, seven stances, cross-refs (0002/0005/0007,
  docs/03/09/13, FINDINGS).
- Catalog typechecks; an assert proves no entry named `approve`, every
  entry valid, browser names matching the shipped server.
- All defaults live in the contracts, not consumers.

## Checks that must be green
- `npm run typecheck` → 0; `npm run build` ok; boundary greps clean.
- Full local sweep unchanged (no runtime, no new gate yet).

## Guardrails
- No implementation — no server edits, no registry, no UI; mergeable-small.
- Descriptions are for MODELS (02 serves them verbatim); `inputSchema` =
  plain JSON Schema data — contracts stay dependency-free.
- Verbs must already exist daemon/app-side; NEW capability out of scope.
