# Phase 8 — integrations: the campaign report

Receipts for the integrations pack (steps 01–14), same format as
`prompts/phase-7/REPORT.md`. Per-step mechanics live in `IMPLEMENTATION.md`
(deviations recorded there, inline); this file keeps dated verification
records and the finds worth remembering. Sweep count as of 8/12: **50 gates**
(35 + MCP + MCPWRITE + AGENTWEB + WEBTRAIL + MCPMGR + MCPCAT + PERWS +
PERWSAGENT + VAULTKEYS + WSCLOSE + KBSHORTCUTS + TOOLPLAN + EVBRIDGE +
MCPSTATUS + INTEG).

## 12 — the GitHub adapter: review lands back in the pane (2026-07-07)

The service seam's FAKE-first implementation + its first real provider. A
board card linked to a GitHub PR/issue shows live state — the app holding
NO credential — and a review/merge transition lands a house notify on the
OWNING pane (the website's sentence, literal). Read-only: agents create PRs
with their own `gh`; the app observes and notifies.

**Rides gh's own session — token never enters our process.** The adapter
calls `gh pr/issue view --json` and lets gh authenticate; we never run `gh
auth token`, never hold, log, or show a token (stronger than 0008.d's
letter). Ladder: no gh → `unconfigured`; logged-out → `error` + "run: gh
auth login"; rate-limited → the engine dims to `stale` (last good re-served),
never a retry storm. Repo names / URLs / titles are UI-only, never telemetry.

**The engine** (backend, usage-seam discipline): per-link cadence
(manual/1m/5m/15m, default 5m), jitter, exponential backoff, paused while
hidden; the last-good `LinkStatus` cached (stale is a STATE). A
review/merge/close TRANSITION fires `onTransition` → main lands
`getDaemonClient().notify(card.paneId, 'attention', "PR #123: changes
requested")` and emits the bridge's `review-changed` (10).

**FAKE-first**: every LinkStatus state has a deterministic fixture (green,
failing, changes-requested, approved, merged, closed, draft, stale, error);
smokes + gallery run ONLY fake, zero network. The board card ⋯ menu gains
"Link GitHub PR/issue…" (URL or owner/repo#123), a face chip (state glyph +
checks, token-colored, stale dims) with an "as of {age}" tooltip, and
Refresh/Unlink.

**INTEG gate** (8 asserts): link parse (URL/shorthand/reject); per-fixture
snapshot shape; stale-after-error keeps the old fetchedAt; a review flip
fires exactly one transition labelled `PR #123: changes requested` (and a
first fetch is not a transition); the poller pauses hidden and resumes; unlink
stops the poll. **Dev-verified 2026-07-07 (real gh 2.92.0)**: the adapter's
exact call — `gh pr view 13791 --repo cli/cli --json
state,isDraft,reviewDecision,statusCheckRollup,title` — returned
`MERGED · REVIEW_REQUIRED · 42 checks`, normalized to `merged`/`review-
required`/`passing`. Sweep 49 → **50** (INTEG).

## 11 — MCP connection status: know, don't assume (2026-07-07)

Is each connected tool actually LIVE for each CLI — and does the terminal
reflect it? 06/07 observed one-shot; 11 makes connection state a
continuously-known, PUSHED signal (registered → connected → needs-auth →
error → drift), surfaced where the user works, with one-click repair.
OBSERVATION only — the CLIs' own status output + our config hashes, never a
token store, a vendor endpoint, or a TUI scrape.

**The derivation** (`status.ts`, pure): compose our apply/drift verdict
(06's `mgrStatus`) with the CLI's OWN `mcp list` parsed per server (07's
`parseCliMcpList`). not-applied → registered; drift verdict → drift; applied
+ the CLI lists it → connected; applied + "Needs authentication" →
needs-auth; applied but absent from the list → error; not installed → off.
No new source of truth, no probing.

**The poller** — the usage-seam discipline: jittered 15m cadence (spread by
pid), refresh on Settings-open / after apply / on demand, PAUSED while
hidden (the tick no-ops), snapshot pushed over IPC. Runs each installed
CLI's `mcp list` ONCE and parses per server. States + counts are the whole
vocabulary that leaves the poller.

**Propagated to the terminal**: a quiet pane-header chip (`mcp N`) per the
pane's CLI, flipping to `mcp !` on needs-auth/error and to `restart +N` when
tools connected AFTER the pane launched (MCP configs are read at launch) —
one restart via the existing relaunch. The settings grid shows live
connection state on each server×CLI chip; `needs-auth` renders a
Re-authorize that opens the CLI's OWN auth in a pane — never an auto-spawned
browser (the consent is the user's to give).

**MCPSTATUS gate** (7 asserts a–g green): the five states derive exactly
from the CLI's own lines; the connected count aggregates; a refresh produces
a snapshot; a HIDDEN window pauses the tick (no fresh snapshot) and a visible
one resumes; and the snapshot's JSON carries no URL, tool name, or token —
states + ids only. **Dev-verify honesty**: the gate exercises the derivation
+ poller headlessly (the states come from real CLI-list strings); a live
Claude Code + one OAuth server flipping needs-auth on revoke is the
founder-run confirmation. Sweep 48 → **49** (MCPSTATUS).

## 10 — the event bridge: house events → your webhooks (2026-07-07)

The website's outbound promise, literal: n8n "trigger self-hosted workflows
from your panes", Make "from a notify call to any webhook", Slack "when a
pane needs you, the right channel knows." A doorbell, not a message bus.

**POST only, URLs are secrets.** A webhook's URL is stored as vault
ciphertext (consumer THREE of 8/08's `vault.ts`) or an env-ref pointer; the
KV, trail, logs, and telemetry only ever see the LABEL. Masked `host/…`
forever. URL policy: https anywhere; plain http ONLY loopback; private-LAN
http (RFC1918 / `.local`) demands the explicit "insecure URL" ack (LAN n8n
is real); public http refused outright.

**Daemon untouched.** The note the daemon drops (`applyNotify` maps event→
state, discards the message) means pane-notify bridge events carry ids only,
honestly — `note` rides the events main synthesizes (the test event, and
card-moved/review-changed when 12 emits). We subscribe to the attention
stream main ALREADY sees (`onState` → a transition into attention =
`needs-you`), so protocol v3 never moves.

**Polite delivery.** Per-webhook serial queue; POST with a 5 s timeout, no
redirects (`redirect:'error'`), 1 + 3 exponential retries, then DROP with a
`bridge` trail entry carrying the LABEL. `emitBridgeEvent` never blocks the
caller (emit returns in ~0 ms; delivery is queued) — a hung receiver costs a
notify nothing. Per-webhook health chip (ok/failing/off) from outcomes,
in-memory. The payload is the CONTRACT (`BRIDGE_PAYLOAD_VERSION = 1`):
growing it bumps `v` + the docs.

**EVBRIDGE gate** (all 8 a–h green): a notify lands with the exact v1 schema
(`v:1, event, ts, workspace, pane, note`); an unchecked kind never arrives;
workspace scope holds; a 500 receiver retries (4 hits) then drops with a
LABEL trail entry; the URL rests as vault ciphertext (the token-in-path
absent from the on-disk db); public http refused; a dead receiver
(192.0.2.1, TEST-NET) leaves emit at ~0 ms; the secret URL appears in no
trail entry. **Dev-verify honesty**: the gate's receiver is an in-process
loopback server (the site's real n8n/Slack path is the same POST) — a live
self-hosted n8n webhook receiving a pane's notify is the founder-run
confirmation. Sweep 47 → **48** (EVBRIDGE).

## 09 — workspace tool plans: scoping with a mechanism (2026-07-07)

Registered ≠ everywhere. A per-workspace TOOL PLAN says which registered
servers reach a workspace's panes, per CLI, materialized at pane launch so
an agent's context carries only the plan — research §8's context-pollution
risk, answered with a mechanism, not a warning.

**The launch mechanism (dev-verified 2026-07-07).** `claude --help` on this
machine confirms `--mcp-config <configs...>` + `--strict-mcp-config` ("only
use MCP servers from --mcp-config"). So Claude Code rides a scoped config
FILE in userData (nothing in the worktree) + the strict flag: strict = plan
only (global excluded), non-strict = plan ∪ the CLI's own global. The
`inheritGlobal` toggle IS that flag. No-flag CLIs (codex/gemini, research
floors — not installed here) get a git-EXCLUDED project-scope file instead
(`.git/info/exclude`, worktree-aware), so agents never see a plan file in
`git status`. Args ride the launch command, env rides spec.env — daemon v3
untouched. Main materializes it; the renderer never sees it.

**Opt-in, so no regression.** A workspace with NO stored plan launches
UNCHANGED (the CLI's own global config) — 8/09 never silently strips a
pre-existing user's servers. A plan is stored at creation (wizard picks /
template) or when the user edits the matrix; that's what turns scoping on.
Minimal by default once on: the house server is always present, plus the
picks, nothing else.

**The UI.** A wizard Tools row (chips of connected servers, shown only when
there ARE any — no silent scoping); a Settings › Workspace tools MATRIX
(tools × CLIs, three cell states planned/global/off, inherit toggle, the
per-pane truth line); the catalog grid gains an "in N of M workspaces"
badge (planCoverage over the scoped workspaces, honest denominator);
template-seeded plans at creation.

**Restart-needed (e), self-contained.** A pane records the plan SIGNATURE it
launched against (`planSignature` — any entry/inheritGlobal edit changes it);
editing the plan flips every live pane still holding an old signature to
"restart to apply". Real surface: the matrix truth line shows the live
pending-restart count, and a plan edit toasts the affected panes. Pure logic
(`restartNeededPanes`) is what the smoke asserts; 11 grows the per-pane chip
on top of the same signal.

**TOOLPLAN gate** (all 7 sub-asserts a–g green): {A,B for claude · A for
codex} materializes EXACTLY that (claude flag+strict+file, codex project
file); a CLI launched against the file lists ONLY the planned servers — the
frame, verbatim: `SERVERS=linear,mogging,sentry|STRICT=true` (no unplanned
posthog); `inheritGlobal` drops strict; the codex file is git-invisible; a
plan edit flips the launched panes to restart-needed (`restartFlipsOk`);
template picks seed a plan; matrix cells match. **Dev-verify honesty**: a
real second MCP server (Sentry) wasn't on the dev machine, so a node shim
stands in for the CLI reading the materialized `--mcp-config` file — the
flags themselves are verified present in the installed Claude Code. Sweep
46 → **47** (TOOLPLAN).

## 08 — the vault, fleet-wide: paste-once service keys (2026-07-07)

Phase-7 proved the paste-once vault for USAGE keys (ADR 0007.a); 08 brings
the SAME grammar to the fleet so an api-key MCP server (PostHog, fal.ai, an
n8n bearer) works with no secret literal in any CLI config, ever.

**The extraction (consumer one, zero behaviour change).** `usage-keys.ts`'s
safeStorage mechanics became `src/main/vault.ts` (encrypt / decrypt / KV-slot
/ the ONE availability probe / the vault-unavailable REFUSAL). usage-keys is
now a thin consumer — USAGE + USAGESET stayed green across the swap, the
proof. Agent-web persistence (8/04) folded onto the same shared probe, so
there is exactly one vault-availability truth machine-wide.

**Where a secret can and can't go — the load-bearing find.** The daemon's
per-pane env DOESN'T ride the spawn message today: profile env (4/04) is
typed as an `export NAME=…` PREFIX in `run`, and `run` echoes into the pane
and PERSISTS to sessions.db (scrollback). Fine for profile POINTERS (never
secret) — fatal for a service KEY. So routing a secret through the typed
prefix would rest it in plaintext in sessions.db, the exact thing the vault
exists to prevent. **Deviation from the goal's "daemon literally untouched":**
I added an OPTIONAL `env` to `SpawnSpec` and merged it in the daemon's
`pty.spawn` (`{...process.env, ...extraEnv, ...spec.env, MOGGING_PANE_ID}`).
This is backward-compatible (an optional field on the existing spawn message,
no version bump) and the daemon stays source-agnostic — it never learns the
vault exists; it just gets an env map. The secret is set in the PROCESS env,
never typed, so it's never in scrollback/sessions.db. Verified: the Session
stores only `spec.run`+cwd+scrollback — `spec.env` is never assigned to the
session, so it is never persisted. Main resolves the vault slots in the spawn
RELAY (`daemon-relay`), so a value never round-trips the renderer; remote
panes get none (a key would ride SSH to another machine).

**Per-CLI env semantics (dev-verified, 2026-07-07).** MCP stdio servers
inherit the launching CLI's process env — that's exactly how the house
`mogging-mcp` reads `MOGGING_PANE_ID` (proven live by the MCP/MCPCAT gates
under Claude Code). So a vault key placed in the pane's process env is read
by any stdio MCP server directly via `process.env.<NAME>` — the universal,
CLI-agnostic path (OS process inheritance, not a CLI feature). `${VAR}`
expansion INSIDE a CLI's mcp-config value is the secondary path (Claude Code
expands it; Codex TOML / Gemini rely on inheritance) — the presets use env
inheritance, so no preset claims `${VAR}`-in-config it hasn't earned. Recorded
so 10's URL store (consumer three) and future presets inherit the finding.

**Honest copy, both edges.** (a) the works-in-panes boundary is stated at
paste time, not fine print: "reaches agents in panes MoggingLabs Workspace
launches — a CLI you run elsewhere needs the same variable in your own
environment." (b) the grant truth: "any key an MCP server needs is readable
by that agent's process — the same as any env var; scope servers per
workspace." The env-ref (`${VAR}`) stays the everywhere-alternative.

**VAULTKEYS gate** (all green): a secret-shaped paste lands as vault
ciphertext (KV holds ciphertext, not the literal); a REAL fixture pane's env
carries the value via the spawn-path (`paneLen == secret.length`, delivered
without echoing the secret); an exhaustive grep of ALL of userData finds the
plaintext NOWHERE (`offenders: []`); a fixture CLI config carries `${NAME}`;
delete removes it from the store + next launch's env; a vault-less machine
REFUSES with the env-ref offer; usage keys still round-trip. Sweep 43 → **44**
(VAULTKEYS). Guardrail held: no `serviceKey:get` channel exists — the value
materializes only into the spawn env map, in main.

## Browser dock: <webview> migration + per-workspace browsers (2026-07-07)

Founder-driven, mid-pack (after the 8/07 catalog), while dev-verifying the
dock. Three commits, each superseding the last as the fix got proper:

1. **The drag lag** — the dock's main-owned `WebContentsView` is a separate
   Chromium compositor layer; resizing it reflows the page every frame and
   the native layer trails the CSS chrome. First pass FROZE the view during
   drag (killed the lag but blanked to black — rejected). Second pass showed
   a page SNAPSHOT during the drag (visible + smooth, but a static frame that
   snaps on release — rejected as "not the true solution").
2. **The proper fix (research-led)** — Electron's own docs + the open issues
   (webview/BrowserView resize lag, open since 2016) confirm two compositor
   surfaces can never resize atomically; the only artifact-free answer is to
   make the page a layout participant in the SAME compositor. Migrated the
   dock from a main-owned `WebContentsView` to an in-DOM `<webview>` (OOPIF;
   Chromium surface-sync resizes it atomically with its parent). Now resize
   is pure DOM — true LOCKSTEP, zero artifacts. Isolation preserved (guest
   out-of-process, own partition; main drives it by `webContents.fromId`).
   All dock gates green with a new `resizeLockstepOk` assert (guest rect ==
   view-host rect while resizing, page not reloaded).
3. **Per-workspace browsers (the founder's next ask)** — because the page is
   now a DOM element, each workspace gets its OWN browser: per-workspace
   `<webview>` guests with WORKSPACE-SCOPED partitions, so each keeps its own
   live page AND its own logins; switching workspaces switches the browser;
   LRU-capped (3 live workspaces). New PERWS gate proves it: workspace B on
   the SAME origin sees `COOKIE_none` while A holds `ws=AAA` (session
   isolation), and switching back to A restores its exact live page +
   cookie (state preserved), distinct urls per workspace.

**OAuth stance settled here too**: MCP-OAuth consent always opens in the
DEFAULT external browser (the CLI's own `mcp login`); an in-dock routing was
prototyped (`mogging browse`) and reverted at the founder's call.

4. **Per-workspace AGENT browser control (8/07c — the founder caught the
   gap)**: with per-workspace browsers, "leave an agent working in workspace
   A and switch to B" needed the agent path to be per-workspace too. Now each
   agent's browser tools carry its pane -> resolve its OWN workspace, and
   drive THAT workspace's browser gated by THAT workspace's consent/grant —
   never the foreground one (closing a real cross-workspace hole: an agent
   could previously act on whatever workspace was in front). The agent's
   workspace browser is materialized on demand (even if never opened),
   pinned from LRU eviction while the agent is attached (5-min window), and
   its tab shows a possession dot (pulsing while driving) — visible
   possession, now across workspaces. New PERWSAGENT gate proves it: agent
   in A drives A's browser while B is foreground, B untouched, A pinned +
   tab-marked, ungranted origin still refused.

**Gates**: BROWSER (lockstep) · BROWSERCTL · AGENTWEB · WEBTRAIL · PRODUCT ·
PERCEPTION/FLICKER/MILESTONE all green; new PERWS + PERWSAGENT gates green.
The heavier webview gates MISS under back-to-back contention and pass
isolated (the standing marathon lesson). Sweep 41 → **43** (PERWS +
PERWSAGENT).

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

**The n8n record (founder steer + LIVE verify, 2026-07-06)**: the scope is
CONFIG — the app registers servers into the CLIs; it never runs or hosts
one. Verified live, end to end, on a real self-hosted instance
(`docker run n8nio/n8n` — the vendor's blessed route; npm/npx/pnpm flat
installs fight n8n 2.29's packaging — URL-hosted xlsx subdep, DI metadata
split — and were abandoned after an hour; Docker closed it in minutes):

- owner + MCP-trigger workflow bootstrapped over n8n's REST. Find worth
  keeping: `/activate` returns 200 WITHOUT `{versionId}` but the workflow
  stays inactive and the webhook never registers — always re-read `active`.
- the **n8n preset + base-URL override** registered the trigger URL into
  real Claude Code through the catalog pipeline;
- `claude mcp list` → `n8n: http://127.0.0.1:5678/mcp/devverify4242 (HTTP)
  - ✔ Connected`;
- a real agent LISTED the workflow's tool (`add_numbers`) and CALLED it —
  `RESULT={"sum":5}`: a self-hosted n8n workflow executed by an agent
  through config we wrote. (n8n Code-Tool quirks under MCP, recorded:
  input arrives as `query`; the tool must return a STRING.)

The n8n→app direction (n8n's MCP Client Tool consuming the house `mogging`
server — the direction that matters most, per the founder) speaks the same
protocol MCP Inspector dev-verified against our server in 8/02; a Docker
container cannot reach the host's stdio/socket server by design (no TCP,
ADR 0008.b), so that live check belongs on a host-installed n8n — the
user's own. PERCEPTION failed once under the abandoned install's disk
contention and passed isolated — the contention lesson, re-confirmed.

**Gates**: MCPCAT PASS (12 assert groups, `out/mcpcat-result.json`);
PERCEPTION re-run PASS isolated. Full-sweep marathon: 39/41 + PERCEPTION/WORKTREE flaked mid-marathon (the two standing contention lessons — a concurrent build overlapped the sweep start) and passed isolated, the documented pattern. Sweep 40 → **41**.
