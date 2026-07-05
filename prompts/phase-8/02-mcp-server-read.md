The agents get the control plane. `mogging mcp serve` — a stdio MCP server
any hosted CLI can register — exposing the READ half of the Phase-8/01
catalog. It is a pure client of the authed daemon socket: the same discovery,
the same token, the same protocol v3 the `mogging` CLI already speaks.

## Steps
1. **Transport + handshake** (`bin/` beside `mogging.mjs`, sharing its daemon
   client): `mogging mcp serve` reads JSON-RPC 2.0 over stdio (newline-
   delimited or Content-Length framed — match the spec's stdio transport),
   answers `initialize` (protocol version + capabilities: tools only),
   `notifications/initialized`, `ping`, and clean shutdown on stdin EOF or
   parent death. Hand-rolled framing like the daemon protocol — no SDK
   dependency for a surface this small; the spec is the contract.
2. **tools/list from the catalog**: serve `MCP_TOOLS` (read entries only in
   this step) verbatim — name, title, description, inputSchema straight from
   contracts. The catalog is data; dispatch derives from `daemonVerb`, no
   per-tool switch statements.
3. **tools/call → daemon verbs**: `list_panes` → the `list` snapshot
   (id/size/state/title/role); `capture_pane {pane, lines?}` → scrollback
   tail (cap at the Control-API 10000, default 1000); `mail_read {since?}` →
   the caller's messages; `list_owners` / `list_board` → their snapshots.
   Results are MCP `content` text (JSON payloads stringified); daemon errors
   map to spec error objects (unknown pane → tool error with the same wording
   the CLI prints, never a crash).
4. **Identity + auth**: resolve the endpoint file exactly as the CLI does
   (`MOGGING_DAEMON_ENDPOINT` inside panes, well-known path outside); carry
   `MOGGING_PANE_ID` as the session identity for `mail_read`, `human`
   otherwise. No daemon → exit with the CLI's code-3 semantics at startup,
   or a clean JSON-RPC error per call if it dies mid-session. The token
   never appears in any frame, log, or error string.
5. **MCP smoke** (`MOGGING_MCP`, env-gated, wired into qa-smokes.sh): boots
   the daemon fixture world, spawns `mogging mcp serve` as a child, drives
   scripted JSON-RPC frames (initialize → tools/list → each read tool →
   error cases: unknown pane, malformed args, wrong protocol version) and
   asserts golden-shaped responses. Zero network; verdict via
   `out/mcp-result.json`.

## Files
- `bin/mogging-mcp.mjs` (or subcommand in `mogging.mjs` — keep the daemon
  client shared either way) · `src/contracts/integrations/mcp.ts` (only if a
  catalog field proves missing) · `src/main/mcp-smoke.ts` ·
  `scripts/qa-smokes.sh` (gate row)

## Definition of Done
- A real hosted CLI (dev-verify with Claude Code via `hooks/`-style local
  registration) lists the read tools and gets live pane/scrollback/mailbox
  data — recorded in the books with the frames it exchanged.
- tools/list output equals the catalog byte-for-byte (assert in the smoke —
  drift between contracts and server is a failure).
- MCP gate green; sweep count grows by one everywhere the books mention it.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep including the new gate.

## Guardrails
- READ ONLY — no write tool ships here even behind a flag; refusal for a
  write-tool call is a spec error naming step 03's grant, not a stub.
- The server is a daemon CLIENT: protocol v3 untouched, stdio only, no TCP,
  no second listener, no bypassing the token handshake.
- `capture_pane` output goes to the CALLING MODEL only — never into app
  state, telemetry, or logs (ADR 0002/0005 lineage, same as `capture`).
- Session-scoped and stateless: no history, no caching of pane content;
  every call is a fresh daemon round-trip.
