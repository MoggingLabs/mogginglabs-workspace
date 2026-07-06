# Phase 8 — implementation notes (the best-path decisions)

Surveyed 2026-07-06 against shipped code (updated same day for the remade
10-step pack, post-phase-7 freeze). These are the concrete choices the steps
should default to; a step may deviate only by recording why here. House
rules assumed throughout: no new deps unless stated, no new listeners,
daemon protocol v3 frozen, smokes network-free.

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
| OS-vault key store, write-only (0007.a) | `src/main/usage-keys.ts` | 08 extracts the vault mechanics into a shared helper |
| House notify/attention path | notify verb → pane header/card events | 03 receipts, 10 bridge subscription, 12 review-back |
| Profile env → pane spawn (app → daemon, existing wire) | the profiles feature | 08 merges vault keys into the same map |
| Settings one-home module pattern | `src/ui/features/settings/usage.ts` (7/12) | § Integrations is ONE module the same way |

## Phase-7 lessons, binding on this pack

- **One home (7/12)**: every § Integrations knob lives in ONE settings
  module; the milestone greps that none renders elsewhere.
- **Catalog∪config truthfulness (7/12 bug)**: any get-config surface serves
  the UNION of static catalog and stored state, with the seam's own
  defaults — a saved thing must always render saved.
- **Vault-conditioned probes (7/05, certified 7/13)**: smokes that touch the
  OS vault assert the real round-trip where a vault exists and the REFUSAL
  where none does — platform-condition the probe, never the claim.
- **Verify-before-hardcode (7/01)**: every preset row, config dialect, and
  endpoint shape is dev-verified with a real login/install ONCE and dated in
  the books before it ships as data.
- **Four-environment certification (7/13)**: the milestone certifies the
  full uncut sweep on local Windows + the three CI OSes in one dispatch;
  gate counts are COUNTED from `qa-smokes.sh`, never hand-waved.
- **Marathon patterns**: collisions FAIL/MISS, never false-pass — re-run
  isolated; `MOGGING_*` env means smoke-world (real-session dev checks run
  env-clean).

## The custody rule (ADR 0008.h — the phase-7 bar, pack-wide)

- **Any secret in OUR custody rests as OS-vault ciphertext or does not
  rest at all.** Vault-unavailable machines (the 7/05 probe: Linux
  `basic_text` counts as unavailable) get REFUSAL or session-only — never
  a plaintext downgrade. Applies to: vault service keys (08), webhook
  URLs (10), and agent-web persistence (04 — see below).
- **Agent-web cookies ride Chromium's cookie encryption, which uses the
  SAME OS facility as our vault.** So the persistent `persist:agent-web`
  partition is vault-conditioned: no real vault → the dock creates the
  agent-web view on a NON-persist partition instead, with honest copy
  ("this machine can't encrypt at rest — logins here last until the dock
  closes"). Same probe as `isKeyVaultAvailable`, one shared helper.
- **What the CLIs store after THEIR logins is theirs** (ADR 0002 —
  exactly as if the user ran the CLI in a plain terminal): some store
  OAuth tokens as plaintext JSON in their own homes; we neither read,
  copy, nor "fix" that. docs/14 states both halves plainly — our custody
  is ciphertext-only; their custody is their vendor's posture.
- **Certified, not promised**: VAULTKEYS greps KV + configs; the
  milestone (14) ends with a DISK-WIDE sweep — every fixture secret
  (vault key, webhook URL, the fixture site's session cookie value)
  grepped across the entire fixture userData + fixture CLI homes;
  plaintext absence is the assert, the 7/12 masked-key ladder writ large.

## The cross-agent question (app-held OAuth), answered

- **One login already serves all agents almost everywhere we hold the
  credential**: vault keys (08) reach every pane of every CLI from one
  paste; webhook URLs likewise; an agent-web login (04) is ONE browser
  session that any CLI's agent drives. The only class with per-CLI
  logins is OAuth-remote MCP.
- **Why that class resists app-holding, technically**: OAuth 2.1 refresh
  tokens ROTATE — concurrent use by independent consumers trips theft
  detection and revokes the grant, so three CLIs cannot share one
  refresh token. The app as sole refresher minting access tokens fails
  too: access tokens expire mid-session and env is set at SPAWN — no
  re-injection into a running pane. The only working shape is a local
  token-holding PROXY in every request path — the broker 0002 forbids,
  plus a listener. This is why app-held OAuth is an ADR-later, not a
  step: the deferral is engineering, not just philosophy.
- **The residual cost, stated honestly**: N CLIs = N approve-CLICKS at
  connect time (the browser holds ONE vendor login; consents 2..N are
  rubber stamps, no password re-entry), once ever — 07's Authorize runs
  them as a guided sequence and 11's registry shows which CLI is still
  pending. Copy never calls this "log in N times".
- **The mitigation that IS ours**: `authKinds` is an ARRAY
  (vendor-preferred first). Vendors offering BOTH OAuth and token/header
  auth (Sentry `Sentry-Bearer`, Supabase PAT, GitHub PAT — research §4)
  get the second on-ramp surfaced as "one token, all agents" via the
  vault (08). The UI presents the trade: per-CLI OAuth = per-CLI
  revocation + vendor-recommended; one vault token = one paste,
  shared blast radius. User chooses; default = vendor-preferred.
- **Revisit trigger** for the future ADR: a vendor-blessed multi-client
  grant model, or a concrete feature agents-with-MCP cannot serve.

## 01 — contracts

- The control-tool names (01 step 2 references this list): reads =
  `list_panes`, `capture_pane`, `mail_read`, `list_owners`, `list_board`;
  writes = `send_to_pane`, `send_key`, `mail_send`, `claim_files`,
  `release_files`, `update_card`. Browser names stay verbatim from the
  shipped server.
- Catalog SOURCE OF TRUTH is **JSON**: `src/contracts/integrations/mcp-catalog.json`.
  `mcp.ts` imports it (resolveJsonModule) — zero runtime deps, and the bin can
  consume the same data without a build step.
  - **Deviation recorded (01, 2026-07-06)**: `satisfies readonly McpToolDef[]`
    cannot pin a JSON import — TS widens JSON string literals to `string`, so
    closed unions fail (verified against the repo's tsc 5.6, error TS1360).
    The pin is a LOAD-TIME structural validator in `mcp.ts` that narrows the
    JSON into `readonly McpToolDef[]` and doubles as the 01 DoD assert (no
    `approve` anywhere in a name, names exactly the declared unions in order —
    browser = the shipped server's 14 verbatim — act set = the §04 gate list,
    schemas well-formed). Same single JSON source, no generation machinery; an
    invalid catalog fails every app boot and every smoke at import.
  - **Deviation recorded (01, 2026-07-06)**: `isSensitiveOrigin` stays in
    contracts beside the pattern data rather than moving to `@backend` — 7/06
    already shipped it in contracts and both `@backend` (web-session class)
    and `src/main` (webusage-smoke) import it from `@contracts`. 01 moved data
    + helper together from `usage/` to their real home,
    `integrations/grant.ts` (the usage comment always said it was the 8/01
    blocklist, needed there first); the barrel keeps every import working.
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
- New in the remake: `TrailEntry` (05), `IntegrationWebhook` + the versioned
  `BridgeEvent` payload (10), `McpPreset` (07) all live in this slice from
  day one — the steps enforce, 01 only shapes.

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
- Dev-verify against a SECOND, non-CLI client (MCP Inspector, or n8n's MCP
  Client Tool node against a local n8n) — the research names n8n consuming
  our server as a real direction; being a protocol citizen is the claim.

## 03 — write tools + live grants

- The daemon must NOT learn about grants (v3 frozen). Enforcement lives in
  the SERVER process, fed by the APP: two new app-endpoint messages
  (`{t:'grantGet',pane}` → grant snapshot + workspace resolution, and a
  pushed `{t:'grantChanged'}`). That wire is 6/05b's app transport — ours to
  extend, not daemon protocol.
  - **Deviation recorded (03, 2026-07-06)**: the request half rides the
    endpoint's EXISTING `{t:'call', id, name:'grant.get'}` → `{t:'result',
    id}` correlation (like `usage.*` and `board.list`) instead of a bare
    `{t:'grantGet'}` t-type — identical semantics, request/response
    correlation for free. The reply is the RESOLVED granted write-tool NAMES
    (pane → workspace → names, fail-closed), so the server stays a dumb
    catalog filter. `{t:'grantChanged'}` (push, all authed clients) and
    `{t:'receipt', tool, by, pane?, card?}` (fire-and-forget) are new
    t-frames as specced.
  - **Find (03)**: the first workspace's ordinal is 0 (panes 1..n) — pane →
    workspace resolution must validate the pane number (slots start at 1),
    never reject ordinal 0.
- On `grantChanged` the server re-reads and emits
  `notifications/tools/list_changed`; every `tools/call` still re-checks
  (revoke lands mid-session even if the client ignores list_changed).
- Receipts: `{t:'receipt',pane,tool,by}` to the app → existing notify path
  lands it on the target pane's header/card. 05 additionally journals the
  same receipt into the trail — one emission, two sinks.

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
  - **Deviation recorded (04, 2026-07-06)**: the hole is shut STRUCTURALLY,
    no per-call check needed — snapshot refs are stamped by
    `executeJavaScript` in the TOP frame's DOM, and Chromium forbids that
    context from reaching into a cross-origin frame's document; no ref can
    ever name an element there. Documented in the driver comment; the gate
    governs the top origin.
  - **Deviation recorded (04, 2026-07-06)**: the session confirm is
    refuse-then-banner — the first act on a granted-but-unconfirmed origin
    returns a clean "awaiting the human's allow" refusal and sets
    `pendingConfirm` (banner button appears; the agent retries after the
    click) — not a held promise. Deterministic for agents and smokes; no
    dangling act while a human deliberates.
- Session-scoped confirm: in-memory `Set<origin>` per possession, cleared on
  Stop/possession end; the banner button flips it via existing IPC channels.
- Signed-in sites: `ses.cookies.get({})` → unique origins; forget =
  `cookies.remove` per origin + `clearStorageData({ origin })`.
- 04 EMITS trail events from `agentAct()` (act/refusal/confirm/origin-change)
  through a thin `recordTrail()` stub that 05 gives a real store — the
  choke point is instrumented once, in this step, while it's open.

## 05 — the trail (new step; FINDINGS §4.5)

- Store: JSONL per workspace under userData
  (`trail/<workspaceId>.jsonl`), append-only, ring-capped (2000 entries or
  1 MB, oldest-half rewrite on overflow — same spirit as the history ring).
  NOT the settings KV: entries are high-churn and user-clearable per
  workspace.
- One entry shape for all three sources (`web` | `mcp` | `bridge`):
  `{ts, source, workspaceId, pane?, verb, target, outcome, reason?}` where
  `target` is an ORIGIN (web), a pane/card ref (mcp), or a webhook LABEL
  (bridge — never the URL, it may embed a secret). No page content, no tool
  args, no eval bodies, no payloads — refs only, structurally.
- Viewer: a block in Settings § Integrations (one-home rule) + a compact
  "recent acts" strip on the dock's possession banner surface. Filter by
  workspace/source; "clear this workspace's trail" is a user verb.
- The WEBTRAIL smoke greps the store file for fixture eval bodies and
  webhook URLs — absence is the assertion, presence of refs is the other.

## 06 — manager writers (the risky step; strategy per format)

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

## 07 — catalog

- Presets: `presets.json` in `@backend/features/integrations` typed by the
  contract; the registry client is a plain https GET of
  `registry.modelcontextprotocol.io/v0/servers?search=…` (app-side only;
  the smoke overrides the base URL to a local fixture file via env).
- Seed = research §4 (20 rows, verified 2026-07-05) ORDERED by the site
  roster: n8n and Google Workspace first (founder priority), then the
  INTEGRATIONS queue, then the wall. Google Workspace is a preset GROUP —
  one card, one row per product endpoint (Drive/Gmail/Calendar/Chat).
- Site names beyond the research matrix (Zapier, Jira/Atlassian, Figma,
  Shopify, Docker, Postman, Replicate, Discord, Twilio, Airtable,
  WordPress, Typeform/Jotform/Fillout, Kie.ai, Midjourney, Runway,
  Stability, Leonardo, GoHighLevel) get a preset ONLY after the same
  dev-verification (official server, URL, auth kind, date) — this step
  budgets a verification pass for the top of that list; everything
  unverified maps to registry/custom/bridge in docs/14 instead. Honesty
  over coverage.
- Authorize spawns the CLI **in a real visible pane** via the existing pane
  machinery (vendor TUIs stay unasserted — the user completes OAuth in the
  browser; we never scrape the TUI). Status read-back = execFile of each
  CLI's list command with a timeout, parsed for PRESENCE only.
- CLI version floors come from the existing `agents/detect` adapters
  (`installHint` pattern shows where per-adapter data lives).

## 08 — vault service keys (new step; the phase-7 vault, fleet-wide)

- The question this answers: how does a paste-once key reach an api-key
  MCP server the CLIS consume, when writing a literal into their configs
  is forbidden? Because WE launch the panes: profile env already flows
  app → daemon in the spawn message (that's how profile lanes work) — the
  app resolves vault slots and merges them into that SAME map, pre-spawn.
  Daemon v3 untouched; the daemon never learns the vault exists.
- Extract `usage-keys.ts`'s safeStorage mechanics into `src/main/vault.ts`
  first — encrypt/decrypt/slot, write-only, refusal-when-unavailable —
  with usage-keys as consumer one and USAGE/USAGESET as the zero-change
  proof. The key store (this step) and the bridge's URL store (10) are
  consumers two and three.
- Security honesty, stated wherever the key is pasted: at rest this is
  strictly better than a plaintext `export` in dotfiles; at runtime it is
  IDENTICAL to any env var — the agent process can read it, so injection
  can exfiltrate it; per-workspace server scoping is the mitigation. And
  the boundary: vault keys resolve only in panes the Workspace launches —
  a CLI run in a plain terminal needs the user's own env var (the env-ref
  option stays, one toggle away).
- This also closes a standing gap: profiles REFUSE secret literals
  because profile env rests plaintext in the KV — the vault is now the
  one sanctioned path for a secret to reach an agent.
- Per-CLI env expansion/inheritance for MCP entries (`${VAR}` in config
  vs process-env inheritance) is cliQuirks data, dev-verified per CLI
  with a real install before any preset claims it (7/01).

## 09 — workspace tool plans (new step; context hygiene with a mechanism)

- **Why launch-time, not config-time**: the manager's user-home writes
  are inherently global — every pane of that CLI sees every entry. True
  scoping rides the same seam as vault keys: WE launch the panes, so the
  launcher hands each pane exactly its plan. Per-CLI mechanism is
  capability-table data, dev-verified: Claude Code takes `--mcp-config`
  pointing at a userData-composed file (preferred — nothing in the
  worktree); CLIs without a flag get a project-scope file written with
  the managed marker and appended to the WORKTREE's own
  `.git/info/exclude` (worktree-local, never the shared repo excludes) —
  an agent's `git status` must stay clean of our plumbing.
- **Two tiers, no third**: GLOBAL (06) and WORKSPACE (the plan). A
  per-PANE tier is deliberately out of v1 — panes inherit their
  workspace's plan; role-scoped plans are a data-ready extension
  (entries keyed by role) deferred until swarm demand is real.
- **Plans vs grants, said once and repeated in docs/14**: plans decide
  WHERE a server appears (context hygiene); grants decide what OUR
  server permits (the boundary). A plan never widens a grant.
- **Templates seed plans**: the template shape gains `tools: serverId[]`
  — a data field, so the template smokes (TEMPLATE_A/B) extend
  naturally; the wizard picker pre-checks them.
- **Composition with 08 and 11**: the launcher resolves the plan AND the
  vault env in the same pre-spawn pass (one merge point, one place to
  audit); 11's registry + restart-needed compare against the pane's
  MATERIALIZED set, not the global config — the chip tells the pane's
  truth.

## 10 — event bridge (new step)

- The bridge lives in the APP's main process, subscribed to the SAME
  attention/notify events the UI already receives — the daemon stays v3 and
  never learns about webhooks. Nothing listens: outbound POST only.
- Webhook URLs are SECRETS by default (Slack/Make embed tokens in the
  path): stored as ciphertext via 08's `vault.ts`, shown masked as
  `host + /…` forever; env-ref alternative for the dotfiles crowd.
- Events v1: `needs-you`, `notify` (the CLI verb — the site's exact promise),
  `card-moved`, `review-changed` (09 emits). Payload
  `{v:1, event, ts, workspace, pane?, card?, note?}` — ids and the short
  note text the user's own notify carried; never scrollback, diffs, or
  origins. Versioned; documented verbatim in docs/14.
- Delivery: per-webhook queue, at-most-once semantics stated honestly
  (fire, 3 retries exponential, drop with a trail entry) — the bridge is a
  doorbell, not a message bus. Never blocks the notify path (queue +
  timeout). URL scheme rule: https anywhere, plain http ONLY for loopback;
  anything else needs the explicit "insecure URL" acknowledgment, loudly
  labeled (self-hosted n8n on a LAN is real).
- EVBRIDGE smoke: in-process localhost receiver; asserts payload schema,
  event filtering, workspace scoping, retry/backoff on 500, vault-conditioned
  URL storage (round-trip where a vault exists, refusal where not), the
  no-URL-in-trail/no-secret-in-logs greps, and that a dead receiver never
  stalls a notify.

## 11 — MCP connection status (new step; know, don't assume)

- The ONLY honest "connected" signal for a third-party server is the
  consuming CLI's own verdict: `claude mcp list` prints per-server
  connection state; Codex and Gemini have list equivalents — each CLI's
  invocation + parse is CAPABILITY-TABLE data, dev-verified with a real
  install (7/01), never guessed. We add no probe of vendor endpoints
  (that would be the app talking to servers it must never authenticate
  to) and never read a CLI's token store.
- The registry composes three cheap sources: our config presence + drift
  hash (06's scanner), the CLI list output (execFile, headless, timeout,
  serialized per CLI — never concurrent spawns of the same CLI), and
  vault/env slot presence (08). Poller = the usage seam's manners:
  jitter, per-CLI backoff, hidden-pause, push-on-change.
- **Restart-needed** is a timestamp comparison, entirely ours: pane
  spawn time (the daemon already knows it) vs the last managed-config
  write per CLI (the manager records it at write time). No daemon
  change — the app holds both sides.
- The pane chip is paint-only state (the usage-gauge discipline):
  count + worst-state class, attention treatment on needs-auth/error;
  the relaunch path for "restart to pick up" is the existing pane
  restart verb.
- needs-auth detection: the CLI's list output marks auth failures
  (dev-verify the exact wording per CLI, record verbatim in the books) —
  Re-authorize reuses 07's managed-PTY flow; the button is the ONLY
  path (no auto-spawned browser, ever).

## 12 — GitHub adapter

- **One GraphQL call per refresh** via `gh api graphql`: PR state +
  `reviewDecision` + `statusCheckRollup` in a single bounded request (REST
  needs 2–3 calls for the same; ETag savings at a 5-minute cadence don't
  outweigh the extra round-trips). 403/429 → stale + long backoff.
- `gh auth token` via execFile with a 5 s timeout, per request, never
  stored — straight ADR 0008.d.
- Poller pauses on `BrowserWindow` hide/blur events (main-side, no renderer
  involvement); last-good `LinkStatus` cached in memory only.
- "Review lands back in the pane" (the site's sentence): a `reviewDecision`
  TRANSITION on a linked card lands a house notify on the pane that owns
  the card (attention chip + optional bridge `review-changed` event) —
  observed state only, no new GitHub capability.

## 13 — onboarding + polish (new step; UX as spec)

- The guided flow is a STATE MACHINE over existing actions (06 Connect,
  07 Authorize, 09 plans) — progress is a KV cursor (roster index +
  per-CLI sub-state), so quit/resume is free and restart-safe. It never
  owns a write path; it sequences the ones that exist.
- needs-auth toasts ride 11's transitions with the 7/09 single-fire
  grammar: KV key per (server × CLI) storing the token-epoch (the
  checkedAt of the first needs-auth); fire once per epoch, re-arm when
  the state returns to connected. Repair action = the SAME Re-authorize
  route as the grid button.
- Palette entries register through the existing command registry with
  args resolved at invoke time (current workspace, pane's CLI) — routes
  only; capability lives in the one home.
- The plain diff summary is DERIVED: the writers already know target
  file, CLI, and scope — the summary renders that tuple ("Adds Sentry
  to Claude Code — all workspaces" / "— this workspace only"), so it
  can never drift from the diff below it.
- Grid grammar mirrors 7/12 verbatim: category groups from the site
  roster (queue/wall/media), connected-first sort, search, empty-state
  CTA — one look and feel across Usage and Integrations.

## Execution order (solo, no parallel agents — house rule)

01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14.
The lanes in the README describe INDEPENDENCE (06–11 + 13 and 12 don't
need 02–05), not simultaneous execution; if a lane blocks, skip forward
and return.

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
6. The trail must never become the leak: it stores refs, not content — the
   WEBTRAIL grep is structural, and the bridge writes LABELS, not URLs.
7. Webhook receivers are the user's infrastructure: a hung receiver, a
   redirect to http, a 10 MB response — the client caps response read at
   1 KB, follows no redirects, and times out at 5 s. The bridge trusts
   nothing it talks to.
8. Preset verification is a moving target (the 7/08 statuspage lesson:
   endpoints drift, vendors redirect) — every preset row carries its
   verified date; docs/14's map is re-checkable, not eternal.
9. Vault keys in pane env are agent-readable BY DESIGN (same as any env
   var) — the copy must never imply otherwise, and no future step may
   "optimize" by writing a decrypted value anywhere persistent. The
   works-in-panes boundary (08) is the other honesty: env-refs remain
   the answer for CLIs run outside the Workspace.
10. Plan materialization must never dirty a worktree: the exclude entry
    is per-WORKTREE (`.git/info/exclude` resolves through the worktree
    gitdir — verify on win32 with canonical paths, 6/03), and the
    TOOLPLAN smoke's `git status` grep is the tripwire. A CLI whose
    project-scope discovery ignores excludes entirely gets the
    launch-flag path or waits — never a tracked file.
