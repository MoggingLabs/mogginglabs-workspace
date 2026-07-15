# 14 — Integrations: the five directions

Phase-8. The workspace stops being an island: agents reach your tools, your
tools reach your agents, and the outside world's state lands back on the board.
Five directions, one rule throughout — **every credential we hold, we hold as
OS-keychain ciphertext, on your machine, or we refuse to hold it at all.** The
daemon is untouched (still v3, grant-blind); every boundary below is app-side.

> **Updated by [ADR 0014](adr/0014-app-held-service-connections.md).** The app is now
> an OAuth client: it can hold a **connection** to a service *account* (Sentry, Notion,
> Vercel) and let every agent reach it, so the credential lives in one place instead of
> being re-granted into each CLI's own store. That inverts what Directions 1 & 2 said,
> and those sections are rewritten below. What is **unchanged**: we still never broker a
> **provider login** — Claude, Codex and Gemini authenticate themselves (ADR 0002) — and
> the per-CLI route documented here still exists, still works, and is still the right
> answer when you want a CLI to own its own auth.

> New here? The end-to-end proof that all five compose in one fixture world is
> `MOGGING_INTEGMILESTONE` (`src/main/integmilestone-smoke.ts`). This page is the
> map; that smoke is the territory.

## The five directions

| # | Direction | Who acts | Where it lives |
|---|---|---|---|
| 1 | **Tools → agents** | you connect an MCP server; agents in a workspace can call it | the Catalog + per-CLI config writers (8/06, 8/07) |
| 2 | **Agents → the fleet** | an agent calls the *house* MCP server to read/drive its own panes | `bin/mogging-mcp.mjs` + the app endpoint (8/02, 8/03) |
| 3 | **Agents → the web** | an agent drives the browser dock on a site you signed into | the agent-web profile (8/04) |
| 4 | **House → your automations** | a pane event rings your n8n/Make/Slack webhook | the outbound event bridge (8/10) |
| 5 | **The world → the board** | a linked PR/issue's state chips a card and pings its pane | the service-link adapters (8/12) |

Each direction has its own consent surface. None of them is on by default.

---

## Direction 2 — the house MCP server (the tool catalog)

One server (`serverInfo.name = "mogging"`), two upstreams (the **app** for the
browser dock, the **daemon** for the fleet), a single catalog that is **data,
not code** — `src/contracts/integrations/mcp-catalog.json`, byte-copied to
`bin/mcp-catalog.json` and served verbatim. `tools/list` is exactly the
catalog's non-`write` rows, in order; drift fails the smoke.

| Tool | Family | Access | Upstream |
|---|---|---|---|
| `browser_navigate` | browser | act | app |
| `browser_back` / `browser_forward` / `browser_reload` | browser | read | app |
| `browser_snapshot` | browser | read | app |
| `browser_screenshot` | browser | read | app |
| `browser_click` / `browser_type` / `browser_select` / `browser_eval` | browser | act | app |
| `browser_scroll` | browser | read | app |
| `browser_console` / `browser_network_failures` | browser | read | app |
| `browser_wait_for` | browser | read | app |
| `list_panes` | control | read | daemon |
| `capture_pane` | control | read | daemon |
| `mail_read` | control | read | daemon |
| `list_owners` | control | read | daemon |
| `list_board` | control | read | app |
| `send_to_pane` | control | **write** | daemon |
| `send_key` | control | **write** | daemon |
| `mail_send` | control | **write** | daemon |
| `claim_files` / `release_files` | control | **write** | daemon |
| `update_card` | control | **write** | app |

Reads are always available to a pane-identity session. The six **write** tools
are the boundary — see *Scoping*. There is deliberately **no `approve` tool**:
merging is a human gate, and the smoke greps every frame to prove the word
never appears.

**Degradation is independent.** A daemon-less session still answers browser
tools and returns a clean JSON-RPC error (naming the fix) for control ones; an
app-less session does the reverse. Neither upstream's outage crashes the other.

---

## Directions 1 & 2 — connect & authorize

There are **two routes**, and the difference between them is *who holds the grant*.

### Route A — a Connection (the app holds it) · ADR 0014

The default, and the one the Connections card grid drives. You connect a service
**account** to the app, once:

1. The app discovers the server's authorization server from its own `401`
   (RFC 9728 → RFC 8414), then **registers itself** as a public OAuth client
   (RFC 7591) where the vendor allows it — no vendor paperwork, no shipped secret.
2. Consent runs in **your own browser**, on the vendor's real page, over an
   ephemeral `127.0.0.1` loopback redirect (RFC 8252) with PKCE/S256. The app never
   renders a login form and never sees your password.
3. The grant rests as **OS-keychain ciphertext**. It is decrypted at exactly one
   point: the moment a token is attached to an outbound request.
4. The connection is registered as an MCP server whose command is **our bridge**
   (`bin/mogging-connection.mjs --connection <id>`). Agents call the service *through
   the app*, so **what lands in `~/.claude.json` is a command and a service id — no
   token, no key, not even a `${VAR}`.**
5. **Connected means proven:** the card shows what the server *answered* at
   `initialize` + `tools/list` — its name, its tool count, the scopes, the renewal
   clock. Nothing is inferred from a config file's contents.

One grant, one refresher (rotation-safe), one **Disconnect**.

### Route B — a per-CLI server (the CLI holds it)

Unchanged, still supported, still right when you *want* a CLI to own its credential —
or when the server must run locally (`aws`, `azure` ride your machine's own credential
chain and have nothing to connect). **Connect** here writes config through the per-CLI
writers (8/06); on this route the app runs and authenticates nothing. Three on-ramps,
one pipeline:

- **A preset** — an official, dev-verified row from the Catalog (see the map).
- **A registry search** — the official MCP registry, rendered as a *community
  DRAFT* (never house-vetted, badged as such).
- **A pasted preset** — your own JSON, converted through the same refusals.

**Authorize**, on route B, is the CLI's job. OAuth consent runs in the CLI's own
managed pane (`claude /mcp`, `codex mcp login <id>`, `gemini mcp auth <id>`) and the
token lands in **that CLI's** store. Token servers take an **env-ref pointer**
(`${POSTHOG_API_KEY}`) — the literal never enters a config file. One paste of a shared
key into the vault is the exception, and it rests as ciphertext (see *Custody*).

---

## Scoping — plans vs grants

Two different scopes, two different jobs. Don't conflate them.

| | **Tool plan** (8/09) | **Write grant** (8/03) |
|---|---|---|
| Question | *which servers does this workspace's CLI even see?* | *may the house server's `write` tools act?* |
| About | **context hygiene** — fewer tools, sharper agents | **the boundary** — can an agent move your fleet? |
| Default | opt-in; an unplanned workspace launches unchanged | `writeTools: 'none'` — writes invisible AND refused |
| Mechanism | a materialized MCP config the CLI launches against (`--mcp-config --strict-mcp-config` for Claude Code; a git-excluded project file for Codex/Gemini) | a per-workspace grant the app endpoint resolves; flipping it fires `notifications/tools/list_changed` |

A plan **narrows what exists**; a grant **gates what a tool may do**. A plan of
`{sentry for claude}` materializes exactly `{mogging, sentry}` — the global
`posthog` is absent. A grant of `'all'` makes the six writes appear in
`tools/list` and work; `'none'` makes them vanish and a direct call is refused
*naming the grant*. Grants are **workspace-scoped**: workspace A on `'all'`
never grants workspace B, and a human session (no pane identity) sees zero
writes, period. Editing a live plan flips **restart-needed** on that
workspace's panes — the config is read at launch.

---

## Direction 3 — agents on the web, and the injection threat

The agent-web profile lets an agent drive the dock on a site **you** signed
into. Reads (snapshot) are ungated; **acts** (click/type/navigate/eval) demand
a per-workspace grant naming the **origin** (granted in Settings § Browser —
the browser boundary's home — or the dock's own Sites & grants panel), and the
first act on an origin raises a pending-confirm the human clicks. Crossing origins raises an alert; a
blocklisted origin is refused at save *and* at dispatch, even if a hostile
grant is force-persisted (the blocklist beats anything stored).

**The injection model (docs/09, restated).** A swarm agent already treats pane
scrollback as untrusted input — a prompt injected into one agent's context must
not become another's instruction. The web widens that surface: **page content
is attacker-controlled**. An agent that reads a page and then acts on it is one
`document.body.innerText` away from following instructions a stranger wrote.

**FINDINGS (agent-web).** This is why acts are origin-grant-gated and
human-confirmed while reads are free: reading a hostile page is safe; *acting*
on what it says is the risk, so the human stays in the loop for the first act
on every origin, the trail records every act with its origin, and the
loudest presets (Slack, Stripe) say in plain words that a prompt-injected agent
here can do real damage — grant to one trusted workspace, keep the reviewer
gate on, read the trail. The agent-web session is vault-conditioned: with no OS
keychain it runs a **non-persist** partition and says so in the chrome.

---

## Custody — whose secret is whose

The rule, in your words:

> **What we store, we store as ciphertext or we refuse. What the CLIs store is
> theirs.**

- A shared service key you paste (the vault, 8/08) rests as **OS-keychain
  ciphertext**; config files carry `${NAME}`, never the literal; the value
  reaches a pane's env only at spawn. No keychain → **refused**, with the
  env-ref offered instead.
- A webhook URL is a **secret** (Slack/Make embed a token in the path). It rests
  as vault ciphertext or an env-ref; the KV, logs, telemetry, and trail see only
  the **label** and a `host/…` mask.
- An MCP OAuth token's custody depends on the route (ADR 0014). On **route B** it is
  **the CLI's** — it lives in that CLI's store and this process never sees it. On
  **route A** it is **ours to guard**: it rests as OS-keychain ciphertext, is decrypted
  only to be attached to one outbound request, and no IPC channel can return it (there
  is no getter, by construction). No keychain → we **refuse to connect** rather than
  keep a refresh token in plaintext. The GitHub *adapter* (direction 5) is different
  again, and goes further than both: it shells out to your own `gh`, which authenticates
  itself.

The milestone's custody sweep greps every fixture secret — vault key, webhook
token, the site cookie value — across the *entire* fixture userData, the CLI
homes, and every frame/trail. Plaintext absence in **our** stores is the assert;
the site's own cookie jar legitimately holds its own cookie (that's theirs).

---

## The trail — what it never holds

Every agent act (web + MCP-write receipts + bridge drops) lands in a local,
per-workspace ring (≤2000 entries, survives restart, clearable per workspace).
It records **outcome, verb, and the target as an ORIGIN or pane ref** — and
nothing else:

- **no** eval bodies, page text, or cookie values
- **no** URL path or query beyond the origin
- **no** webhook URL (only the label)
- **no** message bodies or scrollback

The viewer lives in Settings § Activity (Trust group — it is how you check what
agents did, not an integrations knob). Its own copy says the content "never sent
anywhere" — because it never leaves the machine.

---

## Direction 4 — the outbound bridge (webhooks)

A **doorbell, not a message bus**: POST only, nothing listens. A house event
fires at every matching webhook on a per-webhook queue with bounded retries; a
hung or dead receiver never stalls the emit. URLs are secrets (above). The v1
event vocabulary is closed: `needs-you`, `notify`, `card-moved`,
`review-changed`.

### The payload, verbatim

```json
{
  "v": 1,
  "event": "notify",
  "ts": 1751846400000,
  "workspace": "ws_ab12",
  "pane": "101",
  "card": "c_7f3a",
  "note": "build done"
}
```

`v` and `event` are always present; `ts` is epoch ms; `workspace` is an **id**,
never a path or repo name. `pane`, `card`, and `note` appear only when relevant
(`note` is the caller's own `mogging notify --message`, capped at 280 chars).
Growing this shape means bumping `v` and this doc together.

**URL safety.** `https` anywhere; plain `http` only to loopback; private-LAN
`http` demands the explicit "insecure URL" acknowledgment; plain `http` to a
public host is never allowed. No redirects, ever.

### Wire it to n8n (a Webhook node)

1. In n8n, add a **Webhook** node. Set method **POST**, copy its **Production
   URL** (it embeds a token — treat it as a secret).
2. In the workspace, open **Settings § Webhooks → Add** (its own tab under
   Agents & tools). Paste the URL (it vaults; you'll only ever see
   `your-n8n.host/…` afterward), name it, and check **`notify`** (and any
   others).
3. Scope it to this workspace, or leave it global.
4. Hit **Test** — the receiver gets a `notify` with `note: "Test event…"`. In
   n8n, pin that run and build the rest of the flow off the pinned JSON above.
5. Now `mogging notify --message "…"` from any pane rings the flow. A pane going
   to *attention* fires `needs-you`; a linked PR's review fires `review-changed`.

---

## The three dialects

One managed entry, three config formats. Each writer is **surgical**: it touches
only blocks wearing the `mogginglabs` marker, preserves every foreign key/line
byte-for-byte, backs up once per file per session before its first write, and
never goes near an auth key. Drift (a hand-edit) is detected read-only and
never auto-healed.

| | Claude Code | Codex | Gemini |
|---|---|---|---|
| File | `~/.claude.json` | `~/.codex/config.toml` (`CODEX_HOME`) | `~/.gemini/settings.json` (`GEMINI_CLI_HOME` relocates the parent home; legacy `GEMINI_CONFIG_DIR` profiles remain readable) |
| Shape | `mcpServers` map, `"type":"stdio"` | `[mcp_servers.<id>]` TOML table | `mcpServers` map |
| Our marker | `"_managedBy":"mogginglabs"` | `# managed-by: mogginglabs` comment line | `"_managedBy":"mogginglabs"` |
| **Remote quirk** | writes `"url"` + `"type":"http"` | `bearer_token_env_var` for token auth | writes **`"httpUrl"`**, never `"url"` |
| Scoped plan | `--mcp-config <file> --strict-mcp-config` (verified 2026-07-07) | git-excluded `.codex/config.toml` | git-excluded `.gemini/settings.json` |

Two Claude vintages are handled: an existing `.claude.json` is spliced; a
missing one gets a minimal file created.

---

## Direction 5 — the adapter ladder

A board card links to a GitHub PR/issue; the engine polls (per-link cadence,
jitter, backoff, paused while hidden, **last-good cached — stale is a state, not
an error**), and on a review/merge/close **transition** it lands a house notify
on the card's owning pane and fires `review-changed`. The app holds **no**
credential.

`src/backend/features/integrations/services/github.ts` is the exemplar rung:

- **Rides your `gh`.** One bounded `gh pr/issue view --json` per refresh; the
  token never enters this process (stronger than `gh auth token`).
- **Read-only.** Never a mutation.
- **Labeled failures, never thrown.** The ladder is `no gh → unconfigured`,
  `logged out → error` (run `gh auth login`), `rate-limited → stale` (last good
  re-served). A reason string never carries a token.

The `fake` adapter is the same interface with deterministic fixtures (every
`LinkStatus` state has one) — zero network, for the smoke and gallery. A new
service is a new rung: implement `detect()` + `fetch()`, done.

---

## The site-honesty map

Every integration the site names has a real on-ramp in the app — none is
dropped or dead-linked. The on-ramps:

- **preset + date** — a dev-verified Catalog row (Connect writes config; you
  authorize in the CLI). Every row below is `verifiedAt` in `presets.json`.
- **registry** — an official-registry search, rendered as a community draft.
- **custom** — a pasted preset JSON, same refusals.
- **bridge** — an *outbound* target: house events ring it via a webhook.
- **none yet** — named for the roadmap; arrives via registry/custom until vetted.

### Presets (preset + date · all verified 2026-07-05/06/07)

`n8n` · Google Workspace (`Drive`, `Gmail`, `Calendar`, `Chat`) · `Slack` ·
`GitHub` · `Vercel` · `Supabase` · `GoHighLevel` · `ClickUp` · `Make.com` ·
`Sentry` · `PostHog` · `Stripe` · `Cloudflare (docs)` · `AWS (API suite)` ·
`Microsoft Azure` · `GitLab` · `Notion` · `Tally` · `Zapier` · `Jira /
Atlassian` · `Figma` · `Postman` · `Airtable` · `Jotform` · `Replicate` ·
`fal.ai` · `ElevenLabs` · `Higgsfield`.

### Also reachable as bridge targets (direction 4)

`n8n`, `Make.com`, `Zapier`, and `Slack` are inbound presets **and** outbound
webhook receivers — house events (`notify`, `needs-you`, `review-changed`,
`card-moved`) ring their trigger URLs.

### Native board chips (direction 5)

`GitHub` PRs/issues chip a card live through the `github.ts` adapter — distinct
from the GitHub *MCP* preset (that's tools for agents; this is state for the
board).

### Anything else the site names

Any tool **not** in the roster above is not dropped: it reaches you via a
**registry** search or a **custom** pasted preset (community, un-vetted, badged
as a draft). If the site names it as "coming," that's a **none yet** — the
Catalog is open data, so it lands as a preset the day it's verified.

### What Phase 2.5 mounts later

The registry feed and OAuth-per-CLI maturity vary by CLI today (Claude Code is
verified on-machine; Codex/Gemini floors are research-attributed until a real
install re-verifies). Phase 2.5 mounts the re-verified Codex/Gemini rows, the
richer registry browse, and the account-scoped Cloudflare/observability servers
that currently arrive only via the registry.

---

See also: **docs/13** (the browser dock & agent control — direction 3's
substrate), **docs/06** (the control API — the same verbs the MCP server
speaks), **docs/09** (the swarm & the injection model).
