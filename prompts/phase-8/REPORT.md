# Phase 8 — integrations: the campaign report

Receipts for the integrations pack (steps 01–14), same format as
`prompts/phase-7/REPORT.md`. Per-step mechanics live in `IMPLEMENTATION.md`
(deviations recorded there, inline); this file keeps dated verification
records and the finds worth remembering. Sweep count as of 8/02: **36 gates**
(35 + MCP).

## 01 — ADR 0008 + the integrations contracts (2026-07-06)

- ADR 0008 committed (eight stances); `@contracts/integrations` ships the
  catalog (JSON source + load-time validator — the `satisfies`-on-JSON
  deviation is recorded in IMPLEMENTATION §01), grant, trail, bridge, preset,
  and service shapes. Zero runtime.
- Validator teeth proven on tampered copies: a tool named `approve_branch`,
  a drifted browser name, and a `required` naming an unknown property all
  throw with precise messages.
- WEBUSAGE + BROWSERCTL re-run green after the sensitive-origin blocklist
  moved home (usage → integrations).

## 02 — the house server: one server, two upstreams (2026-07-06)

**Shipped**: `bin/mogging-mcp.mjs` serves the contracts catalog (hand-written
TOOLS died; `bin/mcp-catalog.json` build-copied + committed, byte-compared by
the smoke), serverInfo flips to `mogging`, control READS ride a fresh authed
daemon round-trip per call (`bin/lib/endpoint-client.mjs` owns the shared
framing/handshake), write tools answer a spec error naming the 8/03 grant.
The app endpoint gained `board.list` (the board is app-side) and a
catalog↔dispatch drift assert at boot.

**Dev-verify, real hosted CLI (Claude Code 2.1.200, 2026-07-06)** — registered
ONCE (`--mcp-config` naming `node bin/mogging-mcp.mjs`), one session against a
standalone daemon world (pane 101, planted scrollback + mail):

- tools listed: all 19 (`mcp__mogging__browser_*` ×14 + `capture_pane`,
  `list_board`, `list_owners`, `list_panes`, `mail_read`) — zero writes.
- `list_panes` → `[{"id":"101","cols":120,"rows":30,"cwd":"C:\\Users\\pedro","state":"idle"}]`
- `capture_pane {pane:'101',lines:50}` → tail contained `DEVVERIFY_MCP_101`.
- `mail_read` (identity = `MOGGING_PANE_ID=101`) →
  `[{"id":1,"from":"0","to":"101","body":"DEVVERIFY_MAIL_4242","ts":1783355485170}]`

**Dev-verify, NON-CLI client (MCP Inspector `--cli`, 2026-07-06)** — the same
server, unmodified: `--method tools/list` returned the catalog verbatim
(name/title/description/inputSchema); `--method tools/call --tool-name
list_panes` returned the live pane as MCP text content. Protocol citizen, not
a Claude-Code trick.

**Re-register one-liner for dev machines** (the 6/05b name retires):

```
claude mcp remove mogging-browser ; claude mcp add mogging -- node <install>/bin/mogging-mcp.mjs
```

**Notes for the record**

- The MCP smoke's "daemon down mid-session" is implemented as a SESSION with
  an absent daemon endpoint (browser read ok → control read answers the clean
  JSON-RPC error naming the fix → browser read ok again), plus the reverse
  (app endpoint absent, control fine). Same session, both directions of
  independent degradation — without killing the shared fixture world's daemon
  under the app mid-smoke (a flake source, not a fidelity gain).
- Identity note: `mail_read` outside a pane (no `MOGGING_PANE_ID`) is the
  human view — everything — exactly the CLI's rule.
- Token hygiene is asserted structurally: the smoke greps every frame every
  child wrote (stdout + stderr) for BOTH endpoint tokens.

**Gates**: MCP PASS (22 asserts, `out/mcp-result.json`); BROWSERCTL re-run
PASS untouched. Sweep 35 → **36**.
