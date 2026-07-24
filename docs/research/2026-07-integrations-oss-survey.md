# Integrations OSS survey — what to copy, from whom, and why (2026-07-23)

Seven repos were cloned and read (shallow clones, scratchpad `oss/`): NangoHQ/nango,
Klavis-AI/klavis, activepieces/activepieces, metorial/metorial, webrix-ai/mcp-s-oauth,
ComposioHQ/composio, modelcontextprotocol/servers. This document records each project's
strengths (what we copy), weaknesses (what we avoid), the license boundary for each, and
the synthesized architecture that feeds the phase-tools rewrite.

The one-line verdict: **our ADR 0014 hold-and-proxy architecture is the industry-proven
shape** — Nango, Metorial, and Klavis all converge on it. What we're missing is not
architecture, it's **declarative provider data**: auth config, verification endpoints,
identity (profile) fetchers, refresh quirks, and human-readable scope names as CATALOG
DATA instead of code. Every mature project has this; our `presets.json` is an embryo of it.

---

## 1. Nango — `NangoHQ/nango` · 11.2k★ · **ELv2 (ideas yes, verbatim content no)**

**What it is.** Unified auth/integrations platform: 919 providers in ONE declarative
`packages/providers/providers.yaml`, a proxy, token refresh, and a connect UI.

**Strengths to copy (as schema ideas, re-authored by us):**
- **The provider file taxonomy.** 18 auth modes with real-world coverage: `OAUTH2` (280),
  `API_KEY` (294), `BASIC` (95), `OAUTH2_CC` (client credentials, 91), `TWO_STEP` (58),
  **`MCP_OAUTH2` (21) — they model MCP-native OAuth as its own mode**, plus JWT/SIGV4/APP
  oddballs. Lesson: auth-mode is an enum with a long tail; design the schema so a new mode
  is data + one strategy class, never a per-provider fork.
- **`verification` blocks per provider** (`method` + `endpoints` + headers/body): a cheap
  declarative liveness probe for non-OAuth credentials — exactly our heartbeat's missing
  piece for API-key connections (today we can only `initialize`+`tools/list`).
- **`proxy.retry` metadata per provider** (`at: x-ratelimit-reset`,
  `remaining: x-ratelimit-remaining`, retryable codes): rate-limit-aware retries as DATA.
  Our bridge proxy retries blind today.
- **Refresh discipline** (`refresh.ts` + `crons/refreshConnections.ts`): per-connection
  lock keyed `refresh:{env}:{provider}:{connection}` so concurrent callers never
  double-refresh (the exact failure ADR 0014 §refresh-rotation predicted); a
  `REFRESH_MARGIN_MS` freshness window; failure **cooldown** so a broken provider isn't
  hammered; the cron walks a *stale-connections cursor* with a hard time budget and
  re-checks staleness after lock acquisition. Copy all five behaviors.
- **`connection_config` interpolation** (`${connectionConfig.domain}` in URLs) — one
  mechanism for every self-hosted/instance-URL case (our `needsBaseUrl` is a boolean
  hack; theirs generalizes to N fields with types and prompts).
- **`providers.scopes.yaml`** — default scopes per provider *with a source-URL comment
  per entry*. Provenance-per-row is a house-compatible honesty pattern.
- **`docs_connect` / `setup_guide_url` per provider** — the "how do I register my own
  OAuth client" page as catalog data. Our no-DCR client-id form (Google/GitHub/Slack)
  should carry exactly this link.

**Weaknesses / what we avoid:** server-first (Postgres+Redis+workers — wrong footprint
for a desktop app; we keep main-process + keychain); no desktop loopback-redirect story;
ELv2 license means **we re-author provider entries from the providers' own docs** and
never bulk-copy the YAML.

## 2. Metorial — `metorial/metorial` · 3.3k★ · **FSL-1.1 (Apache-2.0 after 2 yrs; treat like ELv2: ideas yes, verbatim no)**

**What it is.** "Identity and access layer for AI agents": 1,136 integrations, each a
typed **slate** (`integrations/<key>/src/{auth,config,spec}.ts` + `slate.json`).

**Strengths to copy — this is the closest match to our phase-tools decisions:**
- **`getProfile` PER AUTH METHOD.** Every auth method implements
  `getProfile → { id, email, name, imageUrl }` (GitHub: `GET /user`). This is our step-03
  probe ladder, already normalized across 1,136 services. The shape
  `{ id, email, name, imageUrl }` is the right contract for our `account` field —
  richer than our email-string, still secret-free.
- **Multiple named auth methods per service**, typed: GitHub ships FOUR — OAuth
  (github.com), OAuth (Enterprise), PAT (github.com), PAT (Enterprise) — under one
  service spec with per-method input schemas (zod). Validates our 3-way chooser and
  shows the enterprise/self-hosted axis is a *variant of a method*, not a new service.
- **Human-readable scopes**: every scope carries `{ title, description, scope }` —
  "Full access to public and private repositories", not `repo`. Our "Can: repo · gist"
  line should render THESE, with the raw scope in the title attribute.
- **`handleTokenRefresh` that tolerates non-rotating providers** (returns the old
  refresh token when the response omits one — GitHub does this) and **normalizes
  expiry at exchange time** (`expires_at` computed from `expires_in` immediately).
- **Docs links typed per purpose** (`docs.auth.oauth`, `docs.auth.oauth_scopes`).

**Weaknesses:** young; auth executors are `as any`-loose behind the nice schemas; the
control-plane (RBAC/audit) is the hosted product; FSL restricts competing use — same
rule as Nango: re-author, don't copy.

## 3. Klavis — `Klavis-AI/klavis` · 5.4k★ · **Apache-2.0 (copy-friendly with attribution)**

**What it is.** 105 self-hostable MCP server implementations (Python+TS) + an OAuth
wrapper layer + Strata (progressive tool discovery).

**Strengths:** the **permissive-licensed reference corpus** — when our proxy needs to
know how service X's MCP server names tools, expects auth, or paginates, the answer is
here in runnable code; `MCP_SERVER_GUIDE.md` tool-design rules (atomic tools, natural
names, "would the LLM know when to use this from the description alone?") — directly
applicable to our house server's `brain.*`/write verbs; per-server Dockerfiles define
the env-var contract (`GITHUB_TOKEN` etc.) that our vault `${VAR}` slots should mirror
name-for-name (users recognize them).

**Weaknesses — the cautionary tale:** the OAuth layer is a **wrapper that phones the
hosted Klavis API** (`oauth_acquire.sh` → api.klavis.ai, poll, inject `AUTH_DATA`) —
"open-source OAuth" that doesn't work without their cloud. Their weakness is our moat:
**our OAuth runs entirely on the user's machine** (PKCE + loopback + keychain). Say so
on the page. Also: no unified provider catalog (105 bespoke servers), no drift concept.

## 4. Activepieces — `activepieces/activepieces` · MIT core (community pieces MIT) · 724 pieces

**Strengths:** **`validate` on every auth definition** — `PieceAuth.CustomAuth`/OAuth2
carry an async validator that must PROVE the credential before it saves (GitHub App:
sign the JWT, exchange it, only then `valid: true`) with a human error on failure —
this is our submitKey "prove before claiming success" law generalized; copy-friendly
**auth prop schemas** (typed fields with display names + help text per provider — our
client-id/base-URL forms as data); `createCustomApiCallAction` (an escape-hatch "raw
authed request" per service — a power feature our bridge could expose to agents later).

**Weaknesses:** workflow-engine-shaped (pieces = actions/triggers, not MCP; a mapping
layer we don't need); UI/embedding features gated enterprise; auth validation exists
but no ongoing heartbeat — validate-once-then-trust. Ours re-verifies (TOOLPULSE) —
keep that edge.

## 5. mcp-s-oauth — `webrix-ai/mcp-s-oauth` · MIT · small

**Strengths:** the **Connector interface** is the minimal correct abstraction —
`{ authUrl, tokenUrl, scopes, codeExchangeConfig }` + a generic-oauth2 fallback; ~20
connectors prove most providers fit 4 fields (keep our schema's mandatory core tiny;
quirks optional). Its **credential-normalization mapping** (JSONata-style: raw token
response → `{ access_token, expires_at, refresh_token, refresh_token_expires_at }`)
names a real problem: token responses are NOT uniform (GitHub returns
`refresh_token_expires_in`!). Normalize at exchange, store one canonical shape. MIT =
we may lift connector configs directly.

**Weaknesses:** Express-middleware footprint (server-side), no refresh locking, no
verification story. A parts bin, not a blueprint.

## 6. Composio — `ComposioHQ/composio` · SDK MIT, **runtime closed** · ideas only

**Strengths (API-shape only):** the SDK's 3-verb ergonomics — `authorize(user, toolkit)
→ redirect URL → waitForConnection() → tools are live` — is the cleanest developer
narrative for exactly our connect flow; validates "toolkit" (=tool) as the user-facing
unit, auth as a property of it.

**Weaknesses:** every credential lives in their closed cloud; May-2026 security incident
forced customer key rotation. The anti-pattern we advertise against: **our tokens never
leave the machine**. Nothing to clone; nothing to depend on.

## 7. modelcontextprotocol/servers · Apache-2.0/MIT · 7 reference servers

Canon, not catalog: the official reference implementations (filesystem/git/fetch/
memory/…) define idiomatic MCP server behavior our proxy must interop with; the repo's
README is the de-facto registry the community indexes. Strength: correctness baseline
+ the registry feed our Library's "community" search already rides. Weakness: none
relevant — it deliberately isn't an integrations platform.

---

## Synthesis — the architecture we build (proven pieces only)

**Keep (already proven right by this survey):** ADR 0014 hold-and-proxy; landed-grant =
connected (CONNPURE); keychain custody; workspace scoping; TOOLPULSE heartbeat (nobody
else re-verifies continuously — it's a differentiator).

**Adopt:**
1. **`providers/` catalog as declarative data** (Nango's taxonomy + Metorial's methods):
   per service — auth methods[] (mode, endpoints, scopes-with-descriptions, input
   fields, setup-guide URL), `profile` fetcher spec (url/tool + JSON paths →
   `{id,email,name,imageUrl}`), `verification` spec, refresh quirks, retry metadata,
   `connection_config` fields. Re-authored from provider docs (license-clean),
   schema-validated in CI, one file per service.
2. **Refresh discipline** (Nango): per-connection lock, margin window, failure cooldown,
   budgeted background sweep. Ours runs in main, not a cron fleet.
3. **Token normalization at exchange** (mcp-s-oauth): one canonical credential shape.
4. **Prove-before-save** (Activepieces): every method's submit runs its validator.
5. **Identity as `getProfile` data** (Metorial): step 03 reads the catalog, not code.
6. **Scope humanization** (Metorial) and **setup-guide links** (Nango) on the cards.

**License lanes:** copy code/config verbatim ONLY from MIT/Apache (mcp-s-oauth, Klavis,
Composio SDK, activepieces community, servers). Nango (ELv2) and Metorial (FSL): schema
ideas and behavior lists only — every provider entry re-authored from primary docs.

**Feeds phase-tools:** step 01 gains the catalog schema (this doc §Synthesis-1); step 02
gains Nango's refresh discipline + declarative verification; step 03 becomes
catalog-driven `getProfile`; step 04 renders humanized scopes + setup links. The pack
rewrite happens after the user reviews this survey.
