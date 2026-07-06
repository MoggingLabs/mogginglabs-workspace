One server, whole app. 6/05b shipped `bin/mogging-mcp.mjs` speaking the
browser tools; this step makes it THE house server: serverInfo becomes
`mogging`, the catalog is served from 01's contracts data, and the control
plane's READ half arrives via a second authed upstream — the daemon socket
the `mogging` CLI already speaks. No new server, no second registration.

## Steps
1. **Catalog from contracts**: the server's hand-written TOOLS array dies.
   Serve `MCP_TOOLS` (browser family + control READ entries this step) —
   name/title/description/inputSchema straight from the catalog. `bin/` is plain
   node, so generate `bin/mcp-catalog.json` from contracts at build time;
   the smoke asserts generated == contracts — drift is a failure. Dispatch derives from `family`+`verb`: browser
   calls → the app endpoint (existing path, unchanged); control calls → the
   daemon client. serverInfo flips to `mogging` (books note the
   re-register one-liner for dev machines).
2. **The daemon upstream**: reuse the CLI's discovery exactly
   (`MOGGING_DAEMON_ENDPOINT` inside panes, well-known runtime path
   outside) — extract the shared client into `bin/lib/` beside the existing
   app-endpoint client rather than duplicating framing. Same token
   handshake, protocol v3 untouched. No daemon → control tools answer with
   a clean JSON-RPC error naming the fix (`the app is not running`);
   browser tools keep working if the app endpoint is up, and vice versa —
   the two upstreams degrade independently.
3. **Control read tools**: `list_panes` → the `list` snapshot (id/size/
   state/title/role); `capture_pane {pane, lines?}` → scrollback tail (cap
   10000, default 1000); `mail_read {since?}` → the caller's messages;
   `list_owners` / `list_board` → their snapshots. Results are MCP
   `content` text (JSON stringified); daemon errors map to spec error
   objects with the CLI's wording (unknown pane → tool error, never a
   crash).
4. **Identity**: carry `MOGGING_PANE_ID` as session identity for
   `mail_read` (`human` outside a pane). The token never appears in any
   frame, log, or error string — the smoke greps every frame for it.
5. **MCP smoke** (`MOGGING_MCP`, env-gated, in qa-smokes.sh): fixture world
   with daemon + app endpoint up, spawns the server as a child, drives
   scripted frames — initialize (serverInfo `mogging`) → tools/list (browser
   + control reads present, ZERO write tools) → each control read → one
   browser read (proves both upstreams in one session) → error cases
   (unknown pane, malformed args, daemon down mid-session). Golden-shaped
   asserts; zero network; verdict via `out/mcp-result.json`.

## Files
- `bin/mogging-mcp.mjs` + `bin/lib/` (shared clients) · `scripts/` catalog
  emit + `package.json` build wiring · `src/main/mcp-smoke.ts` ·
  `scripts/qa-smokes.sh` (gate row) · books

## Definition of Done
- A real hosted CLI (dev-verify with Claude Code) registered ONCE lists
  browser + control read tools in one session and gets live pane/
  scrollback/mailbox data — recorded in the books with frames.
- tools/list equals the contracts catalog exactly (smoke-asserted via the
  generated file).
- BROWSERCTL still green untouched (no browser regression); MCP gate
  green; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok (incl. catalog emit); boundaries clean.
- Full local sweep including the new gate.

## Guardrails
- READ ONLY for control: no write tool ships even flagged; a write-tool
  call gets a spec error naming step 03's grant, not a stub.
- Pure client of two sockets it does not own: stdio to the agent, no TCP,
  no second listener, no bypassing either token handshake.
- `capture_pane` output goes to the CALLING MODEL only — never app state,
  telemetry, or logs (ADR 0002/0005, same as `capture`).
- Stateless: no history, no caching of pane or page content; every call is
  a fresh upstream round-trip.
