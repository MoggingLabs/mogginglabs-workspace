# Phase 8 — implementation notes (the best-path decisions)

Surveyed 2026-07-06 against shipped code, before any step runs. These are
the concrete choices the steps should default to; a step may deviate only
by recording why here. House rules assumed throughout: no new deps unless
stated, no new listeners, daemon protocol v3 frozen, smokes network-free.

## What the pack stands on (verified in source)

| Shipped piece | Where | What the phase reuses |
|---|---|---|
| MCP stdio server (newline JSON-RPC, initialize/tools) | `bin/mogging-mcp.mjs` | THE server; 02 extends it |
| App control endpoint (token 0600 file, hello/welcome, newline JSON) | `src/main/mcp-endpoint.ts` | browser upstream + grant/receipt wire |
| Daemon client (`withDaemon`, endpoint.json v3, same handshake) | `bin/mogging.mjs:350-420` | pattern for the daemon upstream |
| Single agent-verb choke point, consent re-checked inside | `browser-dock.ts` `agentAct()` | 04's act-gating goes HERE, nowhere else |
| Dock partition + hardening block | `browser-dock.ts:93-…` | extract `hardenSession(ses)`, reuse for agent-web |
| Generic settings KV (`getSetting`/`setSetting`) | `settings-store.ts:173-186` | grants, profile choice, drift hashes |
| 6/05b consent boolean | KV `kvConsent(wsId)` | migrates to `web:'public'` |
| Per-CLI install layout | `hooks/{claude-code,codex,gemini}` | the manager generalizes this |

## 01 — contracts

- Catalog SOURCE OF TRUTH is **JSON**: `src/contracts/integrations/mcp-catalog.json`.
  `mcp.ts` imports it (resolveJsonModule) and pins it with
  `satisfies readonly McpToolDef[]` — full type-checking, zero runtime deps,
  and the bin can consume the same data without a build step.
- "Generation" for the bin is therefore a **copy**: `npm run build` copies it
  to `bin/mcp-catalog.json`; BOTH files are committed; the MCP smoke
  byte-compares them and compares served `tools/list` against the file.
  No tsx/esbuild machinery, nothing to break.
- Grant persists as JSON in the settings KV under
  `integrations.grant.<wsId>` (same store as everything else — no schema
  migration). The 6/05b migration is a read-through: absent grant + legacy
  `kvConsent`=1 → `web:'public'` on first read, then written back.
- `SENSITIVE_ORIGIN_PATTERNS`: host-suffix patterns as plain strings in
  contracts; the matching helper lives in `@backend` (contracts stay data).
  A test-only extra pattern comes via `MOGGING_TEST_BLOCK_ORIGIN` for the
  AGENTWEB smoke.

## 02 — one server, two upstreams

- **Keep newline-delimited JSON-RPC framing exactly as shipped** — it is the
  MCP stdio transport and it already works against real Claude Code. Do not
  switch to Content-Length framing (that's LSP, not MCP stdio).
- Capabilities: `{ tools: { listChanged: true } }` (needed by 03); keep the
  permissive protocolVersion echo the server does today.
- `bin/lib/endpoint-client.mjs`: ONE `connectEndpoint(file)` speaking the
  hello/token/welcome + newline-JSON shape — used by mogging-mcp for BOTH
  `browser-control.json` and `endpoint.json` (they share the handshake).
  **Leave `mogging.mjs` untouched this phase** — it's a load-bearing CLI;
  refactoring it onto the lib is separate churn with no phase payoff.
- Control reads map to the daemon messages the CLI handlers already send
  (`runMailRead`, `runOwners`, list/capture): mirror the message bodies, do
  not invent new ones. Pane identity = `MOGGING_PANE_ID`, exactly like
  `paneIdentityOrUsage()`.

## 03 — write tools + live grants

- The daemon must NOT learn about grants (v3 frozen). Enforcement lives in
  the SERVER process, fed by the APP: two new app-endpoint messages
  (`{t:'grantGet',pane}` → grant snapshot + workspace resolution, and a
  pushed `{t:'grantChanged'}`). That wire is 6/05b's app transport — ours to
  extend, not daemon protocol.
- On `grantChanged` the server re-reads and emits
  `notifications/tools/list_changed`; every `tools/call` still re-checks
  (revoke lands mid-session even if the client ignores list_changed).
- Receipts: `{t:'receipt',pane,tool,by}` to the app → existing notify path
  lands it on the target pane's header/card.

## 04 — agent web profile

- Partition is fixed at WebContentsView creation → the switch is **two
  lazily-created views** (preview / agent-web), attach-swapped; per-workspace
  last profile in the KV. `hardenSession()` extracted and applied to both.
- Act-gating goes inside `agentAct()` — the one choke point that all
  transports already funnel through (IPC and MCP both call it). Compute
  `new URL(wc.getURL()).origin` AT DISPATCH TIME (redirect-safe); act verbs
  = click/type/select/eval/navigate; blocklist beats grant.
- Iframe stance: act verbs refuse when the target frame's origin differs
  from the top origin unless BOTH are granted (cheap check via the frame's
  url off the snapshot ref; documents the cross-origin-iframe hole shut).
- Session-scoped confirm: in-memory `Set<origin>` per possession, cleared on
  Stop/possession end; the banner button flips it via existing IPC channels.
- Signed-in sites: `ses.cookies.get({})` → unique origins; forget =
  `cookies.remove` per origin + `clearStorageData({ origin })`.

## 05 — manager writers (the risky step; strategy per format)

- **TOML (codex): NO parser dependency.** Managed entries are whole
  `[mcp_servers.<id>]` tables tagged `# managed-by: mogginglabs`; add/remove
  is a LINE SPLICE from our table header to the next header. Foreign lines
  are never re-serialized → byte-preservation is structural, not hoped-for.
  A minimal scanner (headers + our tag) covers detection and drift.
- **JSON (claude/gemini): parse → mutate only our keys → stringify with
  detected indent** (JS object key order is stable, so foreign keys keep
  position; trailing-newline preserved). Realistic-formatting fixtures make
  the byte-preservation assert honest; exotic formatting normalizes — the
  backup plus diff preview is the safety net, and docs/14 says so.
- Drift = sha256 of our managed block stored in the KV at write time.
- Backups: `<file>.bak-<ISO8601>` beside the file, first write per session.
- Paths ride one table incl. profile pointer homes; win32 comparisons use
  the 6/03 canonical-path helper.

## 06 — catalog

- Presets: `presets.json` in `@backend/features/integrations` typed by the
  contract; the registry client is a plain https GET of
  `registry.modelcontextprotocol.io/v0/servers?search=…` (app-side only;
  the smoke overrides the base URL to a local fixture file via env).
- Authorize spawns the CLI **in a real visible pane** via the existing pane
  machinery (vendor TUIs stay unasserted — the user completes OAuth in the
  browser; we never scrape the TUI). Status read-back = execFile of each
  CLI's list command with a timeout, parsed for PRESENCE only.
- CLI version floors come from the existing `agents/detect` adapters
  (`installHint` pattern shows where per-adapter data lives).

## 07 — GitHub adapter

- **One GraphQL call per refresh** via `gh api graphql`: PR state +
  `reviewDecision` + `statusCheckRollup` in a single bounded request (REST
  needs 2–3 calls for the same; ETag savings at a 5-minute cadence don't
  outweigh the extra round-trips). 403/429 → stale + long backoff.
- `gh auth token` via execFile with a 5 s timeout, per request, never
  stored — straight ADR 0008.d.
- Poller pauses on `BrowserWindow` hide/blur events (main-side, no renderer
  involvement); last-good `LinkStatus` cached in memory only.

## Execution order (solo, no parallel agents — house rule)

01 → 02 → 03 → 04 → 05 → 06 → 07 → 08. The lanes in the README describe
INDEPENDENCE (05/06 and 07 don't need 02–04), not simultaneous execution;
if a lane blocks, skip forward and return.

## Risks worth naming now

1. TOML splice must handle our table being LAST in the file and inline
   `#` comments on foreign lines (never touch them — splice by header only).
2. Claude Code config location varies by install vintage (`~/.claude.json`
   top-level `mcpServers` today) — the path table carries a per-CLI probe
   order, and MCPMGR fixtures cover both shapes.
3. Registry API is frozen v0.1 but young — the client treats ANY parse
   failure as "registry unavailable", never blocking preset flows.
4. Two views in the dock double renderer surface — create lazily, destroy
   the hidden one under memory pressure; PERCEPTION re-run is the guard.
5. `browser_eval` in agent-web is the sharpest tool: it is act-gated AND
   confirm-gated like clicks; no read-tier exception, ever (already in 04).
