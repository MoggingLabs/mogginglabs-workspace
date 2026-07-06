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
| House notify/attention path | notify verb → pane header/card events | 03 receipts, 09 bridge subscription, 10 review-back |
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
  URLs (09), and agent-web persistence (04 — see below).
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
  milestone (11) ends with a DISK-WIDE sweep — every fixture secret
  (vault key, webhook URL, the fixture site's session cookie value)
  grepped across the entire fixture userData + fixture CLI homes;
  plaintext absence is the assert, the 7/12 masked-key ladder writ large.

## 01 — contracts

- The control-tool names (01 step 2 references this list): reads =
  `list_panes`, `capture_pane`, `mail_read`, `list_owners`, `list_board`;
  writes = `send_to_pane`, `send_key`, `mail_send`, `claim_files`,
  `release_files`, `update_card`. Browser names stay verbatim from the
  shipped server.
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
- New in the remake: `TrailEntry` (05), `IntegrationWebhook` + the versioned
  `BridgeEvent` payload (09), `McpPreset` (07) all live in this slice from
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
  proof. The key store (this step) and the bridge's URL store (09) are
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

## 09 — event bridge (new step)

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

## 10 — GitHub adapter

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

## Execution order (solo, no parallel agents — house rule)

01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11. The lanes in the
README describe INDEPENDENCE (06–09 and 10 don't need 02–05), not
simultaneous execution; if a lane blocks, skip forward and return.

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
