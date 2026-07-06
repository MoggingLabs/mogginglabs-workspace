# Phase 8 — integrations: the campaign report

Receipts for the integrations pack (steps 01–14), same format as
`prompts/phase-7/REPORT.md`. Per-step mechanics live in `IMPLEMENTATION.md`
(deviations recorded there, inline); this file keeps dated verification
records and the finds worth remembering. Sweep count as of 8/04: **38 gates**
(35 + MCP + MCPWRITE + AGENTWEB).

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

## 03 — write tools behind the per-workspace grant (2026-07-06)

**Shipped**: `WorkspaceIntegrationsGrant` persists in the app-settings KV
(`integrations.grant.<wsId>`, @backend/features/integrations store; the 6/05b
consent boolean migrates to `web:'public'` on first read, written back) with
IPC `integrations:grant:get/set` + a push. The server resolves its session's
granted write-tool names via the app endpoint (`grant.get`: pane -> workspace
-> names, fail-closed), serves writes ONLY when granted (ungranted =
invisible), re-checks the LIVE grant per write call, and emits
`notifications/tools/list_changed` when a `grantChanged` push flips its set.
The six write tools dispatch to the existing daemon/app verbs (send = input +
pipelined ping; send-key's closed allowlist; mail with pane-identity sender;
claim/release with the exit-5 denial wording; update_card = board.save patch).
Every granted write emits a receipt (`{t:'receipt', tool, by, pane?, card?}`)
— the app lands "MCP: … by pane N" attention on the TARGET pane via the house
notify path and feeds the `recordTrail()` stub (8/05 gives it the store).
Humans (no pane identity) get no write tools, period.

**Find (caught by the gate)**: the FIRST workspace's ordinal is **0** — pane
ids 1, 2. The pane->workspace resolver must validate the PANE id (slots start
at 1) and accept ordinal 0, not reject `ordinal <= 0`. The MCPWRITE gate's
'all' half failed until the guard moved to the pane number.

**Dev-verify, real CLI (Claude Code 2.1.200, 2026-07-06)** — the DEV-held
fixture world (`MOGGING_MCPWRITE=DEV`), workspace A granted `'all'`,
workspace B untouched:

- Session as pane 1 (ws A): reported **6/6 write tools present**; `mail_read`
  → `DEVVERIFY_WRITE_MAIL_4242`; `claim_files {pattern:'src/dev/**'}` →
  `claim #1 granted`; `send_to_pane {pane:'2', text:'echo
  DEVVERIFY_SENT_BY_AGENT'}` → `sent to pane 2`; `capture_pane {pane:'2'}` →
  the line arrived. The agent read the mailbox, claimed a glob, and sent to
  its own workspace's pane — the DoD sentence, demonstrated.
- Session as pane 101 (ws B): listed exactly the 19 read/act tools and
  reported `WRITE_TOOL_COUNT=0` — the second workspace's session saw none of
  those tools.

**Gates**: MCPWRITE PASS (19 asserts, `out/mcpwrite-result.json`); MCP +
BROWSERCTL re-run PASS. Sweep 36 → **37**.

## 04 — the agent web profile (Branch C) (2026-07-06)

**Shipped**: two partitions, one dock — `persist:browser-dock` stays the
preview byte-for-byte; `persist:agent-web` is the signed-in profile
(`hardenSession()` extracted, applied to both; two lazy views,
visibility-swapped; per-workspace profile persisted; per-profile console/net
rings). Persistence is vault-conditioned (0008.h): the `isKeyVaultAvailable`
probe decides `persist:agent-web` vs an ephemeral partition + the honest
copy. ACT verbs (click/type/select/eval/navigate) gate per ORIGIN at dispatch
inside `agentAct()` — blocklist beats grant beats confirm, refusals CLI-worded
naming grant + origin; reads never gate; preview ignores `actOrigins`.
Session-scoped confirms ride the possession banner (cleared on Stop);
cross-origin navigation raises the alert + trail event; `agentAct()` emits
acts/refusals/confirms/origin-changes through the `recordTrail()` stub
(origins + verbs only). Sites & grants panel: signed-in sites in OUR
partition with Forget / Clear all + the minimal act-origin grant editor
(sensitive origins refuse at save AND dispatch; test hook
`MOGGING_TEST_BLOCK_ORIGIN`). Gallery: `browser-agentweb` state, both themes.

**Deviations recorded (IMPLEMENTATION §04)**: cross-origin-iframe acts are
structurally unreachable rather than checked per-call — snapshot refs come
from the TOP frame's DOM and `executeJavaScript` cannot cross a cross-origin
frame boundary, so no ref can name an element there; the confirm is
refuse-then-banner (the act returns a clean "awaiting the human's allow"
refusal and the agent retries after the click) rather than a held promise.

**Dev-verify, real site + real CLI (Claude Code 2.1.200, saucedemo.com,
2026-07-06)** — the DEV-held world (`MOGGING_AGENTWEB=DEV`; the human's login
performed as scripted keystrokes into the dock, stated here; the banner click
stood in by the DEV arm's auto-confirm — the renderer button path itself is
gate-asserted):

- Ungranted: `browser_snapshot` read the SIGNED-IN inventory
  (`URL=https://www.saucedemo.com/inventory.html … SEES_PRODUCTS=yes`);
  `browser_click` refused verbatim: *"ungranted origin
  https://www.saucedemo.com — acting on a signed-in site needs this
  workspace's grant (the human adds it under Sites & grants)"*.
- Granted + confirmed: `FIRST_CLICK=refused` (pending confirm) →
  `RETRY=ok CART_BADGE=1 BUTTON_NOW=Remove` — the agent completed a task on
  the user's session, exactly once granted, never before.

**Gates**: AGENTWEB PASS (16 asserts, `out/agentweb-result.json`); BROWSER +
BROWSERCTL untouched-green; MCP + MCPWRITE re-run PASS; MILESTONE +
PERCEPTION re-run PASS (renderer touched). Sweep 37 → **38**.
