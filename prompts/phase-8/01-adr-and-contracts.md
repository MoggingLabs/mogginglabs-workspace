Integrations start at the DECISION, not the code. Codify "protocols, not
plugins" as an ADR, then lay the one contracts seam every Phase-8 lane builds
on — the MCP tool catalog as data, the workspace grant shape, and the service
adapter interface. This step ships ZERO runtime; three lanes fork off it.

## Steps
1. **ADR 0008 — integrations are protocols, not plugins** (`docs/adr/`):
   (a) NO in-process plugin runtime — third-party JS inside the app attacks
   rendering reliability (the wedge) and the hardened posture (sandbox,
   closed allowlists, no new listeners); Hyper is the cautionary tale in
   docs/03. (b) The extensibility surface IS the control API + hooks + a
   first-party MCP server that is a pure CLIENT of the authed daemon socket
   (protocol stays v3 — zero new wire surface, stdio only, no TCP).
   (c) Write tools grant nothing an in-pane `mogging send` doesn't already
   grant — per-workspace opt-in is tool-catalog hygiene against prompt
   injection, not the security boundary; the reviewer gate remains the
   boundary and `approve` is NEVER a tool. (d) Outbound service adapters
   ride sessions the user's own tools hold (ADR 0007 pointer philosophy;
   `gh auth token` in memory, one request). (e) UI extensibility revisits
   post-v1 via MCP Apps (spec 2026-07-28), never npm-in-process.
2. **MCP contracts** (`@contracts/integrations/mcp.ts`): the tool catalog AS
   DATA — `McpToolDef { name, title, description, inputSchema, access:
   'read'|'write', daemonVerb }` and `MCP_TOOLS: readonly McpToolDef[]`
   (read: `list_panes`, `capture_pane`, `mail_read`, `list_owners`,
   `list_board`; write: `send_to_pane`, `send_key`, `mail_send`,
   `claim_files`, `release_files`, `update_card`). Closed unions, no `any`;
   the catalog is the single source dispatch and docs both derive from —
   Phase 2.5 memory tools later APPEND here without touching dispatch.
3. **Grant contracts** (same slice): `WorkspaceMcpGrant { workspaceId,
   writeTools: 'none'|'all'|toolName[] }`, default `'none'`. Persisted like
   other workspace settings; consumed by 03, edited by 04's Settings surface.
4. **Service-adapter contracts** (`@contracts/integrations/services.ts`),
   mirroring `@contracts/usage`: `ServiceLink { provider: 'github', kind:
   'pr'|'issue', ref, url }`, `LinkStatus { state, checks?, reviewState?,
   fetchedAt, health: 'fresh'|'stale'|'error'|'unconfigured' }`, adapter
   interface `ServiceAdapter { id, detect(), fetch(link, signal) }`.
5. **Boundary wiring**: contracts depend on nothing (house rule); add the
   grep lines so `@backend`/`@ui` reach integrations only via
   `@contracts/integrations`. Registry/dispatch/UI come in 02–05.

## Files
- `docs/adr/0008-integrations-protocols-not-plugins.md` ·
  `src/contracts/integrations/` (mcp.ts, services.ts, index.ts) ·
  `src/contracts/index.ts` (re-export) · boundary grep additions

## Definition of Done
- ADR 0008 committed with all five stances explicit and cross-referenced
  (0002, 0005, 0007, docs/03, docs/09's "humans own the review gate").
- The full tool catalog typechecks as data; a unit-level assert (build-time
  or existing check script) proves no catalog entry named `approve` exists
  and every entry carries a valid `access` + `daemonVerb`.
- Grant default is `'none'` in the contract itself (not just consumer code).

## Checks that must be green
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean
  (contracts import NOTHING — verify the new slice keeps the invariant).
- Full local sweep unchanged (no runtime ships; no new gate yet).

## Guardrails
- No implementation sneaks in — no server loop, no registry, no UI. Lanes
  02/04/05 all fork from exactly this commit; keep it mergeable-small.
- Catalog descriptions are written for MODELS (they become MCP tool
  descriptions verbatim in 02) — imperative, parameter-precise, no lore.
- `inputSchema` is plain JSON Schema data, not zod/runtime imports —
  contracts stay dependency-free.
- Names are verbs the daemon already speaks — if a tool needs a NEW daemon
  capability, it does not belong in this phase (protocol stays v3).
