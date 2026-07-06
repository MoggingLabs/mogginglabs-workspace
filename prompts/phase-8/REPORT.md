# Phase 8 — integrations: the campaign report

Receipts for the integrations pack (steps 01–14), same format as
`prompts/phase-7/REPORT.md`. Per-step mechanics live in `IMPLEMENTATION.md`
(deviations recorded there, inline); this file keeps dated verification
records and the finds worth remembering. Sweep count as of 8/07: **41 gates**
(35 + MCP + MCPWRITE + AGENTWEB + WEBTRAIL + MCPMGR + MCPCAT).

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

## 05 — the audit trail with teeth (2026-07-06)

**Shipped**: `TrailStore` (@backend/features/integrations/trail.ts) —
append-only JSONL per workspace under `<userData>/trail/`, ring-capped
(2000 entries / 1 MB, oldest-half rewrite), queued + idle-flushed
(250 ms, unref'd — never a hot path, never keeps the process alive), a full
disk drops entries with ONE loud log line. Entries are refs STRUCTURALLY:
every string field is length-capped on append (verb 64 · target 256 ·
reason 256), so page text/eval bodies/cookies physically cannot fit.
`recordTrail()` (03's receipts + 04's act instrumentation) now lands here —
no caller changed shape. Viewer: Settings § Integrations (the minimal shell,
06 absorbs) — reverse-chron, workspace/source filters, outcome badges,
relative times via the ONE `fmtAge` formatter (exported from the usage
feature), two-click clear per workspace, LOCAL JSON export via save dialog,
the retention-honesty + FINDINGS threat-model copy in user words. Plus the
compact recent-acts strip (last 3 web entries) on the dock possession
surface, debounced off the activity push. Gallery:
`integrations-activity`, both themes.

**Dev-verify, real site + real CLI (Claude Code 2.1.200, saucedemo.com,
2026-07-06)** — the 04 DEV world, trail live underneath; raw file inspected
(`trail/<wsId>.jsonl`):

- Exactly FOUR entries for four emissions, 1:1 — `click/refused` (ungranted,
  wording verbatim), `click/refused` (awaiting the human's allow),
  `confirm/confirmed`, `click/ok` — every target the ORIGIN
  (`https://www.saucedemo.com`), timestamped.
- Zero content leakage, grepped: `secret_sauce`, `standard_user`,
  `Backpack`, `session-username`, `inventory.html` — all absent. The viewer
  rendering of the same entry shapes is DOM-asserted by the WEBTRAIL gate
  (h) and shot in the gallery.

**Gates**: WEBTRAIL PASS (a–h + the confirm event,
`out/webtrail-result.json`; the ring held 1000 after a 2100 seed, restart
survival via a fresh store instance, clear scoped to one file). Sweep 38 →
**39**.

## 06 — the MCP manager: one registry, three dialects (2026-07-06)

**Shipped**: the server registry (settings KV; the house server as the
built-in first row — `node <app>/bin/mogging-mcp.mjs`, one entry, whole app;
env values `${VAR}` references only, secret-shaped literals refused by the
SAME redactor deny-list the profiles use) + three surgical writers behind one
adapter interface: Claude Code (`~/.claude.json` JSON, `type:'http'` + `url`
remotes), Codex (`~/.codex/config.toml` TOML **line-splice**, no parser dep —
a managed block is `# managed-by: mogginglabs` + the table, spliced to the
first blank/header line; foreign lines with inline comments never
re-serialized), Gemini (`settings.json`, the **`httpUrl`** remote quirk).
Backups `<file>.bak-<stamp>` once per file per session before our first
write; drift = sha256 of the canonical block in the KV at write time —
detected read-only (applied / drift-edited / drift-missing), healed only by
explicit re-apply/adopt/forget. Settings § Integrations is now the ONE
module: Servers (chips per CLI, diff preview, apply/remove, backups line) +
Workspace grants (write tools + act origins, 03/04's store) + Activity
(8/05, absorbed). Gallery: `integrations-settings` + `integrations-activity`.

**Format find (fixture-honesty)**: JSON byte-identity across add+remove holds
when fixtures are stringify-shaped (multi-line arrays) — the form the CLIs'
own writers produce. Single-line arrays are HAND formatting and normalize;
first MCPMGR run failed exactly there, fixtures corrected to realistic.

**Dev-verify (2026-07-06, real machine)**: `MOGGING_MCPMGR=DEV` applied the
house server to REAL homes for installed CLIs — Claude Code:
`claude mcp list` → `mogging: node …\bin\mogging-mcp.mjs - ✔ Connected`
(backup `~/.claude.json.bak-2026-07-06-190655` taken first). DEVREMOVE
extracted it cleanly; `claude mcp list` no longer shows it; the ONLY residue
vs the pre-apply snapshot is an empty `mcpServers: {}` where the key had
been absent (accepted: deleting a key we may not own is riskier; claude
treats both identically). **Codex and Gemini are not installed on the dev
machine** — their writers skip (the dimmed-chip rule) and their dialects are
certified by the MCPMGR fixtures; recorded honestly per the 7/01 discipline.
Packaged-app note for 8/14: the house row's args use `app.getAppPath()` —
the packaged bin location needs a distribution decision (asar-external bin).

**Gates**: MCPMGR PASS (16 asserts, `out/mcpmgr-result.json`). Sweep 39 →
**40**.

## 07 — the Integrations Catalog (2026-07-06)

**Shipped**: 31 preset rows (`presets.json`, roster-ordered — n8n first,
Google Workspace as a GROUP of four product endpoints second), every row
carrying `verifiedAt`; the per-CLI capability table (remote-HTTP/OAuth floors;
`presetBlockedFor` dims gaps — NO mcp-remote proxy in v1); the registry
client (official registry v0, wrapped `{server,_meta}` shape, ANY parse
failure = "registry unavailable", never blocking); preset → entry conversion
(the ONE pipeline: every on-ramp converts, validates through the SAME
redactor/env-ref refusals, saves as a 06 registry row, lands via 06's
writers); dual-auth on-ramps (`authKinds` array — OAuth per CLI
vendor-preferred vs "one token, all agents" as a `Bearer ${VAR}` header ref;
codex maps it to `bearer_token_env_var`); import/export (imported = community,
blank `verifiedAt` renders the DRAFT badge); the update FEED (registry match →
PREVIEW diff only, never applied); Authorize = the CLI's own MCP-OAuth in a
managed pane (openWorkspaceFromTemplate; we observe status only via each
CLI's own `mcp list` output, presence-parsed). Stripe and Slack carry the
loudest grantCopy. Connect copy states scope-per-workspace (8/09 plans).

**The verification pass (2026-07-06, live probes — initialize POST, 401 =
live authed MCP endpoint).** VERIFIED → preset: n8n (docs-verified flow,
2026-07-06 real instance below) · Google Workspace ×4 (`drivemcp/gmailmcp/
calendarmcp/chatmcp.googleapis.com/mcp/v1` all live — the sibling pattern
confirmed) · Slack `mcp.slack.com/mcp` · GitHub · Vercel · Supabase ·
**GoHighLevel** (`services.leadconnectorhq.com/mcp/` AND
`mcp.gohighlevel.com/mcp` both live — the roster tile lands) · ClickUp ·
Make (token URL, research 2026-07-05) · Sentry · PostHog · Stripe ·
Cloudflare-docs · AWS (pypi `awslabs.aws-api-mcp-server` live) · Azure (npm
`@azure/mcp` live) · GitLab (`gitlab.com/api/v4/mcp`) · Notion · Tally
(redirect → 401) · **Zapier** (`mcp.zapier.com/api/mcp/mcp`) · **Jira/
Atlassian** (`mcp.atlassian.com/v1/sse`) · **Figma** (`mcp.figma.com/mcp`) ·
**Postman** · **Airtable** · **Jotform** · **Replicate** · fal.ai ·
ElevenLabs (pypi) · Higgsfield.

**NOT verified → the site-honesty map (docs/14 lifts this):** Shopify
(mcp.shopify.com 404, shopify.dev/mcp 404 → registry/custom; their dev MCP
is an npm stdio package — registry search finds it) · Discord (no endpoint,
DNS dead → custom/registry) · Twilio (404 → registry) · Docker (404 — the
Docker MCP Toolkit is a Desktop-local feature → custom) · WordPress (302,
ambiguous → registry/custom) · Typeform (302 → registry/custom) · Fillout
(no known official endpoint → custom) · Kie.ai · Midjourney (no official
MCP) · Runway (DNS dead) · Stability AI · Leonardo.Ai (all → registry/
custom/bridge). Google Cloud (beyond Workspace) → registry. Every site name
maps to preset OR registry/custom/bridge — no silent drops.

**Find**: the registry v0 wraps results as `{ server, _meta }` — the first
client read the flat shape and saw empty rows; the fixture now mirrors the
real wrapped shape (probed live 2026-07-06).

**Dev-verify, real machine (2026-07-06)** — the OAuth-preset cycle through
the REAL pipeline: `MOGGING_MCPCAT=DEV` connected the **ClickUp** preset to
the real Claude Code config; `claude mcp list` read back
`clickup: https://mcp.clickup.com/mcp (HTTP) - ! Needs authentication` —
the correct pre-consent state (the browser consent click is the USER's, by
design: N approve-clicks belong to the human, ADR 0008.d). DEVREMOVE
extracted it cleanly; the user's own claude.ai ClickUp connector was never
touched. One registry server (fixture pipeline) certified by the gate;
the LIVE registry probed and its `{server,_meta}` shape folded in.

**The n8n record (founder steer, 2026-07-06)**: the scope is CONFIG — the
app registers servers into the CLIs; it never runs or hosts one. The
app→n8n direction (preset, base-URL override, bearer slot) is
gate-certified on fixtures: paste a real instance's MCP URL and the entry
lands dialect-correct (MCPCAT asserts exactly this). The n8n→app direction
(n8n's MCP Client Tool consuming the house `mogging` server — the direction
that matters, per the founder) speaks the same protocol MCP Inspector
dev-verified against our server in 8/02; the live one-click check runs
against the user's own instance whenever wanted (docs will carry the two
steps; a sandbox is one `docker run -p 5678:5678 n8nio/n8n` away — Docker
is present on the dev machine). A local npm/npx/pnpm n8n install was
attempted and abandoned (n8n 2.29's npm packaging fights flat installs:
URL-hosted xlsx subdep, DI metadata split; its blessed routes are Docker or
its own lockfile) — an hour of machine time says the honest record beats
the theater. PERCEPTION failed once under that install's disk contention
and passed isolated — the 7/xx contention lesson, re-confirmed.

**Gates**: MCPCAT PASS (12 assert groups, `out/mcpcat-result.json`);
PERCEPTION re-run PASS isolated. Full-sweep marathon: 39/41 + PERCEPTION/WORKTREE flaked mid-marathon (the two standing contention lessons — a concurrent build overlapped the sweep start) and passed isolated, the documented pattern. Sweep 40 → **41**.
