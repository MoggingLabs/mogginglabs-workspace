# Research — Third-party app integrations (MCP · API · plugins)

- **Date:** 2026-07-05 · **Status:** research synthesis, pre-implementation

> **Addendum 2026-07-06 (remade pack — current mapping).** Phase 8 was
> restructured twice this day: first absorbing phase 10's Comet resolution,
> then REMADE as 10 steps on the website roster + the phase-10 trail + an
> outbound event bridge. Current references: the MCP manager is **8/06**,
> the Integrations Catalog **8/07** (presets from §4, Connect/Authorize
> from §6, capability table + no-proxy rule from §8, MCPCAT smoke; n8n +
> Google Workspace lead per the site roster), the "notify → webhook"
> outbound direction (§4's n8n/Make rows) is **8/08 event bridge**, the
> GitHub adapter **8/09**, the milestone **8/10**; the docs page is
> **`docs/14-integrations.md`**. §7.3's "ADR 0009 — service keys as
> pointers" is folded into **ADR 0008 stance (d)**; outbound webhooks got
> stance **(g)**. The 2026-07-05 text below is preserved as written.
- **Question:** how do we integrate third-party tools (n8n, Make, Slack, Sentry, PostHog,
  AWS, Azure, GitHub, GitLab, Vercel, Supabase, Google Workspace/Drive, Google CLI,
  Cloudflare, Stripe, Notion, Tally, fal.ai, ElevenLabs, Higgsfield, ClickUp, …) so users can connect them
  from the app and every hosted agent can use their capabilities — MCPs, APIs, and
  plugins, "all of it"?
- **Answer in one line:** the Phase-8 architecture (`prompts/phase-8/`, ADR 0008
  "protocols, not plugins") is the right chassis and the 2026 ecosystem has converged to
  meet it — nearly every tool on the list now ships an **official MCP server**, most of
  them **remote with OAuth handled by the MCP client**, and all three hosted CLIs
  (Claude Code, Codex, Gemini CLI) do that OAuth dance themselves. So the app delivers
  "all of their capabilities" by **registering** servers into the CLIs' configs — never
  running, proxying, or authenticating anything itself. ADR 0002 stays intact.

---

## 1. What the current system already decides (recap)

- **ADR 0002:** never broker provider auth. Extended by ADR 0007's *pointer philosophy*
  (reference secrets by env name/path; read at request time; in-memory for one request;
  secret-shaped literals refused at save).
- **Phase 8 (authored, not yet built)** — three lanes, one philosophy:
  1. **agents→app:** first-party MCP server (`mogging mcp serve`, stdio, pure client of
     the authed daemon socket) exposing the control plane as tools; write tools behind
     per-workspace grants; `approve` never a tool.
  2. **app→CLIs:** the **MCP manager** (8/04) — register any MCP server once, fan it out
     to Claude Code (`~/.claude.json` · `mcpServers`), Codex (`~/.codex/config.toml` ·
     `mcp_servers`), Gemini (`~/.gemini/settings.json` · `mcpServers`, `httpUrl` quirk);
     surgical writes, backups, diff preview, drift detection, env-refs only.
  3. **app→services:** service-adapter seam (8/01, 8/05) riding sessions the user's own
     tools hold (`gh auth token` — in memory, one request, never persisted).
- **Phase 9/04:** Sentry watcher = read-only BYOK adapter on that seam (token pointer).
- **`prompts/features/auth-settings.md`:** the app may *orchestrate* a CLI's own native
  login in a managed PTY and read status — never credentials.
- **No in-process plugin runtime** (ADR 0008): third-party JS inside the app attacks the
  rendering wedge and the hardened posture.

**Nothing found in this research contradicts these decisions. Everything extends them.**

## 2. The ecosystem fact that makes this easy

Since mid-2025 the vendors converged on **official, mostly remote (streamable-HTTP) MCP
servers with OAuth 2.1 + PKCE, where the *client* performs the browser login and stores
the token**. Verified for this list (details + sources in §4):

- Remote + OAuth, official: **GitHub, GitLab, Sentry, Supabase, Notion, Stripe, Vercel,
  Cloudflare, Slack (GA 2026-02-17), Tally, Google Workspace (per-product Gmail / Drive /
  Calendar / Chat endpoints), AWS (managed remote server, GA 2026-05-06), ClickUp
  (`mcp.clickup.com/mcp`, OAuth 2.1/PKCE only, public beta), Higgsfield (hosted MCP,
  account login — "no API keys to manage")**.
- Remote + API-key header, official: **PostHog** (`mcp.posthog.com/mcp`), **fal.ai**
  (`mcp.fal.ai/mcp`, key per-request, stateless).
- Local stdio + ambient CLI/key auth, official: **Azure MCP** (Entra credential chain —
  picks up `az login`), **ElevenLabs** (`ELEVENLABS_API_KEY` env).
- Self-hosted product as MCP server: **n8n** (MCP Server Trigger exposes *your workflows*
  as tools; MCP Client Tool node consumes external servers; plus n8n's own management MCP
  + public REST API), **Make** (MCP server / "Toolboxes" expose *scenarios* as tools —
  transitively 3,000+ apps).

And on the client side, **all three hosted CLIs handle remote-MCP OAuth natively**:

- **Claude Code:** remote HTTP servers with OAuth (`claude mcp add --transport http`,
  in-client `/mcp` authorize; user/project scopes).
- **Codex:** `config.toml` `[mcp_servers]` supports streamable HTTP, bearer/static
  headers, OAuth login with local loopback callback (configurable port/callback).
- **Gemini CLI:** `settings.json` `mcpServers` with `httpUrl` + `oauth.enabled`
  (dynamic discovery default); tokens stored in `~/.gemini/mcp-oauth-tokens.json`.

**Consequence:** for the OAuth-remote class (12+ of the listed tools) the app's entire
job is *config registration + login orchestration*. The CLI opens the browser; the
vendor authenticates the user; the CLI stores the token. We hold nothing — the exact
ADR 0002 posture, now covering third-party services too.

## 3. The four integration lanes

### Lane 1 — MCP registration fan-out (the workhorse; Phase 8/04 + a catalog on top)
The 8/04 manager as authored takes arbitrary server entries. What this research adds: a
**curated Integrations Catalog** — preset entries for the tools above (label, transport,
URL/command, auth kind, env-ref slots, per-CLI quirks, self-hosted base-URL override) so
connecting Sentry to *every* hosted agent is one click + one browser consent per CLI.
- Presets are **data** (the 8/01 catalog-as-data discipline), shipped with the app and
  refreshable from the **official MCP registry** (`registry.modelcontextprotocol.io`,
  API frozen v0.1 since 2025-10-24) — curation stays ours; the registry is an update
  feed, not a trust source.
- Key-based servers (PostHog, fal.ai, ElevenLabs, n8n bearer): env-refs only —
  `${POSTHOG_API_KEY}` — the existing secret-literal refusal applies unchanged.
- Per-workspace grants + diff preview + drift detection as authored.

### Lane 2 — service adapters riding CLI sessions (Phase 8/05 pattern, more providers)
For **app-native UI** (board chips, watchers, meters) — not agent tools. GitHub-via-`gh`
ships first (8/05). The same `detect()/fetch()` seam extends to: GitLab (`glab auth
token`), AWS (`aws` CLI / default credential chain), Azure (`az account get-access-token`),
Google Cloud (`gcloud auth print-access-token`), Vercel (`vercel` CLI session), Stripe
(`stripe` CLI), Supabase (`supabase` CLI), Cloudflare (`wrangler`). One provider per
step, FAKE-first, read-only v1 — exactly the 8/05 template.

### Lane 3 — first-party use (already planned; unchanged)
Sentry crash reporting + optional PostHog product analytics behind the consent seam
(`prompts/observability/`, ADR 0005); the Phase-9 Sentry **watcher** turns production
errors into queue cards over Lane 2.

### Lane 4 — app-held credentials (the only genuinely new decision → ADR 0009)
Two sub-cases:
1. **Key-pointer adapters** (fal.ai, ElevenLabs, PostHog, n8n/Make tokens) for *app*
   features (e.g. a TTS notification voice via ElevenLabs): allowed today by the ADR 0007
   pointer pattern — env name or documented path, read per request, never persisted.
   Codify the extension to *services* in a short ADR 0009.
2. **App-held OAuth** (the app itself as an OAuth client — e.g. posting to Slack *as the
   app*, browsing Drive *in our UI*): **defer**. 8/05 already flags this ("Slack/Linear
   each want app-held OAuth → their own ADR later"). The MCP lane now covers the
   user-facing need (Slack's official MCP server GA'd) without us storing tokens, which
   removes most of the pressure to ever do this. Revisit only with a concrete feature
   that agents-with-MCP can't serve.

## 4. Per-tool matrix

| Tool | Official MCP (transport · auth) | API / CLI to ride | Lane(s) | Notes |
|---|---|---|---|---|
| **n8n** | MCP Server Trigger (your workflows as tools, bearer URL) + n8n management MCP; MCP Client Tool node consumes *our* server | Public REST API (self-host/cloud, API key) | 1 (+4 for API key) | Two directions: agents call workflows; n8n workflows can call **our** `mogging mcp serve` tools |
| **Make** | Make MCP server / MCP Toolboxes (cloud, token URL; scenarios as tools) | Make API (token) | 1 | Transitive reach: 3,000+ apps via scenarios |
| **Slack** | **Official, GA 2026-02-17** (remote · OAuth) + Real-time Search API | Web API (app-held OAuth — deferred) | 1 | Chat-ops *by agents* now free via MCP; app-as-Slack-app needs ADR (defer) |
| **Sentry** | `mcp.sentry.dev/mcp` (remote · OAuth; `Sentry-Bearer` header alt; self-hosted OK) | REST + auth token | 1, 2/3 (watcher, telemetry) | Phase 9/04 already authored |
| **PostHog** | `mcp.posthog.com/mcp` (remote · personal API key header) | REST (key) | 1 (+4), 3 | Key via env-ref |
| **AWS** | Managed remote AWS MCP (GA 2026-05-06; 15k+ API ops) + `awslabs/mcp` open-source suite (stdio · SigV4/credential chain) | `aws` CLI; SDKs | 1, 2 | Suite has docs/CDK/Terraform/cost servers too |
| **Azure** | Azure MCP (`microsoft/mcp`, stdio · Entra chain, picks up `az login`) | `az` CLI; SDKs | 1, 2 | No general hosted remote; local server is official |
| **GitHub** | `api.githubcopilot.com/mcp/` (remote · OAuth/PAT) + local `github-mcp-server` | `gh` CLI (8/05 ships this) | 1, 2 | Both lanes already in roadmap |
| **GitLab** | Built-in per-instance: `https://<host>/api/v4/mcp` (beta since 18.6 · OAuth) | `glab` CLI; REST | 1, 2 | Self-managed = same URL shape — catalog needs base-URL override |
| **Vercel** | `mcp.vercel.com` (remote · OAuth) | `vercel` CLI; REST | 1, 2 | |
| **Supabase** | `mcp.supabase.com/mcp` (remote · OAuth2, or PAT header for CI) | `supabase` CLI; PostgREST | 1, 2 | OAuth currently all-or-nothing perms; fine-grained coming |
| **Google Workspace / Drive** | Official per-product remotes: `drivemcp.googleapis.com/mcp/v1`, gmail/calendar/chat siblings (OAuth) | Drive API (app-held OAuth — deferred); Gemini CLI `workspace` extension | 1 | Drive-in-our-UI would need ADR 0009-class decision — defer |
| **Google Cloud / gcloud** | Google Cloud MCP servers (docs.cloud.google.com/mcp) | `gcloud` CLI | 1, 2 | "Google CLI" also = Gemini CLI, already a hosted agent |
| **Cloudflare** | Official remote catalog (docs, API ~2,500 endpoints, bindings, observability · OAuth) | `wrangler`; REST | 1, 2 | Multiple purpose-scoped servers — catalog lists each |
| **Stripe** | `mcp.stripe.com` (remote · OAuth) + `@stripe/mcp` local | `stripe` CLI; REST | 1, 2 | Money-moving write tools → workspace grants + reviewer-gate messaging matter here |
| **Notion** | `mcp.notion.com/mcp` (remote · OAuth 2.1/PKCE) | REST (integration token) | 1 | |
| **Tally** | Official, free on all plans (remote · OAuth; read+write forms/submissions) | REST (key) | 1 | |
| **fal.ai** | `mcp.fal.ai/mcp` (remote · `FAL_KEY` header, stateless) | REST (key) | 1 (+4) | 1,000+ gen-media models; key via env-ref |
| **ElevenLabs** | Official `elevenlabs-mcp` (stdio/Python · `ELEVENLABS_API_KEY`) | REST (key) | 1 (+4) | Lane 4 if we ever want app TTS notifications |
| **Higgsfield** | Official hosted MCP (higgsfield.ai/mcp · sign in with your Higgsfield account — no API keys) + official CLI + agent Skills | Credit-billed platform; `higgsfield` CLI | 1 (+2 via CLI later) | 30+ gen-media models (Soul, Cinema Studio, Kling, Veo, Sora 2, …); generation is async — agents poll for results |
| **ClickUp** | `mcp.clickup.com/mcp` (remote · OAuth 2.1/PKCE **only** — no API-key auth; public beta; ~40 tools) | REST API v2 (personal token / OAuth) | 1 | Available on all plans; vetted-client list includes Claude Code |
| *(Linear)* | Official remote (OAuth) — named in 8/05 alongside Slack | REST | 1 | Roadmap-adjacent, same pattern |

## 5. The "plugins" question — three meanings, three answers

1. **A plugin runtime inside our app** — **rejected** (ADR 0008): attacks rendering
   reliability + hardened posture. The control API + hooks + MCP server *are* the
   extensibility surface. UI extensibility revisits post-v1 via **MCP Apps**, never
   npm-in-process.
2. **CLI-side plugins/extensions** (Claude Code plugins + marketplaces; Gemini CLI
   extensions, e.g. the official `gemini-cli-extensions/workspace`; Codex config
   profiles) — these bundle MCP servers + prompts/commands in each CLI's *official*
   channel. **v1.5 candidate:** teach the 8/04 manager to install a CLI's official
   extension where that's the vendor-blessed path, instead of a raw server entry. Same
   surgical-config discipline.
3. **Us building plugins inside *their* ecosystems** (an n8n community node, a Slack
   app, a Make app that talks to the Workspace daemon) — out of scope for the desktop
   product; n8n/Make users already reach us through direction 1 (their MCP client nodes
   can call `mogging mcp serve` tools). Revisit only with a distribution motive.

## 6. Connect/login UX ("log in from our app")

Settings § Integrations, per catalog entry:
1. **Connect** → diff-preview → surgical write of the server entry to the selected CLIs
   (8/04 verbatim; detected-CLI chips; env-ref slots for key-based tools).
2. **Authorize** → per CLI, launch that CLI's own MCP-OAuth step in a managed PTY (the
   `auth-settings.md` orchestration pattern — e.g. drive Claude Code's `/mcp` authorize /
   Codex's MCP login), `shell.openExternal` for the browser consent. The vendor
   authenticates the user; the CLI stores the token; we observe **status only**.
3. **Status chips** read back from config presence + each CLI's own list/status output —
   never token contents. Drift chips as authored.

Each CLI authorizes separately (N CLIs = N consents = N tokens, each held by its CLI).
That is a feature, not a bug — per-CLI revocation, zero shared secret, zero us.

## 7. Recommended implementation plan

1. **Ship Phase 8 as authored** (01→06). Nothing in this research changes a step; 8/04
   is the load-bearing piece for the user's goal.
2. **Phase 8.5 — Integrations Catalog** (new pack, small): preset data for the §4 matrix
   (per-CLI dialect quirks, auth-kind, env-ref slots, base-URL overrides for
   GitLab/Sentry/n8n self-hosted); Connect/Authorize UX (§6); registry-feed refresh;
   MCPCAT smoke on fixture homes; `docs/13-integrations.md` grows a catalog section.
3. **ADR 0009 — service keys as pointers** (Lane 4a): codify ADR 0007's pointer pattern
   for third-party service keys; explicitly defer app-held OAuth (Lane 4b) with the
   Slack/Drive examples and the "MCP covers it" rationale.
4. **Lane 2 providers incrementally** (each its own step, FAKE-first): GitLab → Vercel →
   Supabase → Stripe → clouds, prioritized by board/watcher demand. Phase 9/04 (Sentry
   watcher) as authored.
5. **v1.5+:** CLI-extension installs (§5.2); MCP Apps for UI extensibility when the spec
   settles; app-held OAuth only if a concrete non-agent feature demands it.

## 8. Risks & open questions

- **Codex remote-MCP maturity** varies by version — the catalog needs a per-CLI
  capability table and a tested-version floor; fall back to `mcp-remote` stdio proxy
  only if a CLI can't speak HTTP+OAuth natively (avoid if possible — extra moving part).
- **Tool-catalog bloat / context cost:** 19 servers × dozens of tools would drown agent
  context. Per-workspace grants + registering only what a workspace needs is the
  mitigation; make "scope per workspace" the default UX, not all-CLIs-all-servers.
- **Prompt-injection surface grows** with every third-party tool an agent can call.
  Unchanged boundary: reviewer gate; `approve` never a tool; write-tools opt-in. Stripe
  (money) and Slack (speaking as the user) deserve the loudest grant copy.
- **Self-hosted variants** (GitLab, Sentry, n8n) — base-URL override is a catalog field,
  not a fork.
- **Repo is temporarily public** (until ~Aug 2026) — catalog preset data is fine public;
  keep any vendor-relationship notes out of the repo.

## Sources (verified 2026-07-05)

- Slack: docs.slack.dev/changelog/2026/02/17/slack-mcp/ · docs.slack.dev/ai/slack-mcp-server/ · slack.com/blog/news/mcp-real-time-search-api-now-available
- GitLab: docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/
- n8n: docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger · docs.n8n.io/advanced-ai/mcp/accessing-n8n-mcp-server/ · docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp
- Make: make.com/en/mcp · developers.make.com/mcp-server · make.com/en/how-to-guides/mcp-toolboxes
- AWS: aws.amazon.com/blogs/aws/the-aws-mcp-server-is-now-generally-available/ · awslabs.github.io/mcp/
- Azure: learn.microsoft.com/azure/developer/azure-mcp-server/overview · github.com/Azure/azure-mcp (Authentication.md)
- Google Workspace: developers.google.com/workspace/guides/configure-mcp-servers · developers.google.com/workspace/drive/api/guides/configure-mcp-server · github.com/gemini-cli-extensions/workspace
- Supabase: supabase.com/blog/remote-mcp-server · supabase.com/docs/guides/ai-tools/mcp
- Sentry: docs.sentry.io/product/sentry-mcp/ · github.com/getsentry/sentry-mcp
- PostHog: posthog.com/docs/model-context-protocol · github.com/posthog/mcp
- Tally: tally.so/help/mcp · developers.tally.so/api-reference/mcp
- fal.ai: blog.fal.ai/connect-your-ai-to-1-000-models-with-the-fal-mcp-server/
- ElevenLabs: github.com/elevenlabs/elevenlabs-mcp
- Vercel: vercel.com/docs/agent-resources/vercel-mcp
- Cloudflare: developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/
- Notion: developers.notion.com/guides/mcp
- Codex MCP: developers.openai.com/codex/mcp · developers.openai.com/codex/config-reference
- Gemini CLI MCP/OAuth: google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html
- Higgsfield: higgsfield.ai/mcp · higgsfield.ai/cli · higgsfield.ai/skills
- ClickUp: developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server · help.clickup.com/hc/en-us/articles/33335772678423-What-is-ClickUp-MCP
- MCP registry: registry.modelcontextprotocol.io · github.com/modelcontextprotocol/registry
