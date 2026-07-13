# 12 · Usage meters

The titlebar gauge answers one question at a glance — **"can I keep working,
and until when?"** — for every AI provider you already use, across five
credential mechanisms and ~50 catalog providers, **without holding a
credential it doesn't have to**. The one exception is a usage key you paste
yourself — encrypted at rest by your OS, never read back (see below). Frozen
at Phase 7/13; the parity map lives in
`docs/research/2026-07-codexbar-parity.md`, the auth stance in ADR 0007 /
0007.a / 0007.b, per-step mechanics in `prompts/phase-7/IMPLEMENTATION.md`.

## What the meter shows

- **The titlebar gauge**: two bars (session over weekly — the CodexBar icon
  grammar), a ≥90% dot badge, a provider-incident dot (7/08), and optional
  `%` / glyph / label content (7/10). Which plan it mirrors is a display
  mode: **merged** (highest severity — the default), **auto** (highest
  usage), or **pinned** (one provider).
- **The popover** (click the gauge): plan tiles grouped by provider, ordered
  by severity, each with per-window bars, reset lines, the pace verdict, and
  health (`fresh · stale · error · unconfigured`). `stale` means the last
  good reading re-served after an error — old data, honestly aged, never
  dropped. The active profile's plan carries the selection bar; Enter or
  click switches which profile NEW launches use.
- **The Usage tab** (Settings § Usage): where everything is configured —
  the provider grid, plans × profiles, pace baseline, alerts, display,
  history + cost. The popover is the glance; the tab is the home.

## Reading the verdicts (the three strings, verbatim)

One pure engine (7/02) computes pace; ONE formatter words it. Every surface —
popover, tab, toast, CLI — renders these strings verbatim:

| Verdict | The string | Ink |
|---|---|---|
| runs-out | `Ahead of pace — runs out ~Tue 14:00 at this rate` | warning |
| surplus | `Behind pace — ~12% likely unused at reset` | quiet |
| on-pace | `On pace for the Session (5h) window` | neutral |

A plan that can't be paced (no reset time, no window length, warming up)
shows its snapshot age instead — verdicts never speculate past the data.
Reset moments ride ONE formatter too (7/10): countdown (`resets in 2d 4h`),
absolute (`resets Tue 14:00`), or relative (`resets tomorrow 14:00`) — one
setting, applied everywhere a reset renders.

## The privacy story (ADR 0007 / 0007.a / 0007.b, in user words)

- **Your sessions are read in place.** The meters ride the sessions your own
  CLIs already store, in their own homes, with your consent. This app
  performs no logins, copies no credentials, and never writes to any CLI's
  store. Nothing is stored, nothing is sent.
- **Pasted keys are encrypted by your OS immediately** (DPAPI / Keychain /
  libsecret) **and can never be shown again** — replace or delete only. No
  read-back channel exists in the entire IPC/CLI surface, structurally. If
  your OS can't encrypt (a Linux box without a keyring), storage is refused
  — never plaintext at rest. Env-var references (`${OPENROUTER_KEY}`) are
  the power alternative; a secret-shaped literal in that slot is refused.
- **Browser-session reads are opt-in, per provider, OFF by default.** Paste
  a cookie instead any time. When you do opt in, the app decrypts that one
  site's cookie via your OS keychain, uses it for the one usage request, and
  never hands it to an agent (ADR 0007.b — this is the usage-only cousin of
  the parked agent-browser-auth branch, consciously decided).
- **Telemetry never carries usage values** (ADR 0005): no plan names,
  percentages, reset times, keys, cookies, spend figures, token counts, or
  log paths — counts, class enums, and booleans only, and only if you opted
  into telemetry at all.

## The five classes, one catalog

A provider is a **data row** (`USAGE_PROVIDERS` in `@contracts/usage`); a
mechanism is an **adapter class**. Fifty rows share five classes — adding
provider #51 is a row, not a step.

| Class | Mechanism | Dev-verified representative (books) |
|---|---|---|
| `cli-store` | read the CLI/editor's OWN stored session, from its known home | **Claude** (OAuth usage endpoint) + **Codex** (local session log, zero network), real logins, 2026-07-06 |
| `api-key` | paste-once → OS-vault ciphertext, WRITE-ONLY; env-ref pointer alternative | **OpenRouter** (401 boundary live-checked; DPAPI cipher-at-rest proven), 2026-07-06 |
| `cloud-cli` | ambient cloud credentials via the vendor CLI | **Vertex/Bedrock** absent-CLI ladder live-verified (probe-first `where`/`which`), 2026-07-06 |
| `web-session` | manual cookie paste (default) or opt-in cookie-store read | **Cursor** paste path proven end-to-end (ciphertext at rest, spy-asserted gating), 2026-07-06 |
| `local` | no auth at all — loopback probes + the machine's own logs | the **local JSONL cost scan** over real Codex/Claude logs, 2026-07-06 (Ollama row reserves the probe) |

### The catalog (50 rows)

| Provider | Class | Windows | Status feed | Verified |
|---|---|---|---|---|
| Claude | cli-store | Session (5h) · Weekly | yes | 2026-07-06 |
| Codex | cli-store | Session (5h) · Weekly | yes | 2026-07-06 |
| Gemini | cli-store | Daily | | pending |
| GitHub Copilot | cli-store | Monthly | | pending |
| Zed | cli-store | Monthly | | pending |
| Kiro | cli-store | Monthly | | pending |
| Kilo | cli-store | Credits | | pending |
| Augment | cli-store | Monthly | | pending |
| JetBrains AI | cli-store | Quota | | pending |
| Codebuff | cli-store | Credits | | pending |
| OpenCode | cli-store | Monthly | | pending |
| Windsurf | cli-store | Credits | | pending |
| OpenRouter | api-key | Credits | | pending |
| DeepSeek | api-key | Balance | | pending |
| Moonshot / Kimi API | api-key | Balance | | pending |
| ElevenLabs | api-key | Characters | yes | pending |
| Deepgram | api-key | Balance | yes | pending |
| LiteLLM | api-key | Budget | | pending |
| MiniMax | api-key | Balance | | pending |
| z.ai | api-key | Quota | | pending |
| Venice | api-key | Balance | | pending |
| Poe | api-key | Points | | pending |
| Chutes | api-key | Quota | | pending |
| GroqCloud | api-key | Metrics | | pending |
| LLM Proxy | api-key | Quota | | pending |
| ClawRouter | api-key | Budget | | pending |
| Crof | api-key | Credits | | pending |
| Doubao | api-key | Requests | | pending |
| Warp | api-key | Requests | | pending |
| Alibaba (key) | api-key | Quota | | pending |
| OpenAI (admin spend) | api-key | Spend | yes | pending |
| Claude (admin spend) | api-key | Spend | | pending |
| Vertex AI | cloud-cli | Session | | pending |
| AWS Bedrock | cloud-cli | Spend | | pending |
| Cursor | web-session | Requests | yes | pending |
| Devin | web-session | ACUs | | pending |
| Manus | web-session | Credits | | pending |
| T3 Chat | web-session | Messages | | pending |
| Kimi | web-session | Quota | | pending |
| Perplexity | web-session | Queries | | pending |
| Xiaomi MiMo | web-session | Balance | | pending |
| Sakana AI | web-session | Quota | | pending |
| Abacus AI | web-session | Usage | | pending |
| Mistral (spend) | web-session | Spend | | pending |
| Amp | web-session | Credits | | pending |
| Command Code | web-session | Credits | | pending |
| OpenCode (workspace) | web-session | Usage | | pending |
| Alibaba (cookie) | web-session | Quota | | pending |
| Grok (browser) | web-session | Quota | | pending |
| Ollama | local | Local models | | pending |

"Pending" rows ship catalog+fixture and read `unconfigured` honestly until a
real login dev-verifies their endpoint shape (recorded here with the date —
the 7/01 discipline). Endpoint drift at runtime degrades to health `error`
with a human reason, never a throw. Status feeds (7/08) exist only where a
plain public statuspage JSON was dev-verified.

## CodexBar parity — what we match, and two honest carve-outs

We match CodexBar's feature surface the house way: session/weekly/monthly
gauges + countdowns, pace + forecasts, cost scans + spend, usage-history
sparklines, provider status badges, merged-icon display modes + auto-select
+ reset-time styles, threshold notifications + opt-in reset confetti,
account (profile) switching, and a bundled CLI. Two deliberate exceptions:

1. **No username+password login brokering** (what StepFun would need) —
   that is ADR 0002's exact line; StepFun ships only if it grows a
   key/session mechanism.
2. **App-held device flows are deferred** behind their own future ADR —
   Copilot rides its CLI-stored token instead (same data, CLI-owned
   session). Providers reachable ONLY via app-held OAuth wait.

## The Usage tab

Settings § Usage is the one home for every knob: the searchable five-class
provider grid (enable, cadence, detected chips, paste-once keys, env-refs,
web-read opt-ins, per-row health + refresh), the plans × profiles table
(same snapshot the popover renders, with the switch action), the work-day
pace baseline, alert thresholds + reset confetti, display options, compact
history sparklines + the on-demand cost scan, and the privacy story.

## The `mogging usage` CLI (7/11)

The verbs are CLIENTS of the **existing token-authed app endpoint**
(Phase-6/05b's local socket): one more request type on the same handshake,
**no new listener, no daemon change** (the PTY daemon protocol stays at v3,
untouched). The endpoint file is 0600 and per-user; nothing listens on TCP.

| Verb | What it does |
|---|---|
| `mogging usage [--json]` | The current snapshot — windows, reset lines, THE verdict, health. `--json` = the same enriched `PlanUsage[]` the popover renders. |
| `mogging usage cost [--provider <id\|all>] [--json]` | The 7/07 LOCAL cost scan (known log dirs, offline): per-day spend + tokens + total. |
| `mogging usage providers [--json]` | Catalog rows with enabled state, key presence (kind only), health. Read-only. |
| `mogging usage refresh [--provider <id>]` | Pokes the poller, waits (bounded) for the next snapshot, prints it. |
| `mogging usage set-key --provider <id> --stdin` | Stores a key via ADR 0007.a: stdin only (never argv, never echoed), OS-vault ciphertext, WRITE-ONLY. |
| `mogging usage clear-key --provider <id>` | Removes a stored key. |

There is deliberately **no `get-key`** verb (it exits 2). Exit codes: `0`
ok · `1` rejected · `2` usage error · `3` app not running · `4` auth
refused. The CLI emits no telemetry.

## Authoring guide — adding a provider (a row), adding a class (rare)

**Add a provider on an existing class — one catalog row:**

1. Add the `UsageProviderDef` row to `USAGE_PROVIDERS` (`@contracts/usage`):
   id, label, `klass`, the windows the provider actually HAS (never invent a
   lane), `credits: true` for balance-style meters, plus the class's fields
   (`homePointerEnv` for cli-store; `endpoint` for api-key; `origin` +
   `cookieName` for web-session; `statusUrl` only if a PLAIN public
   statuspage JSON exists — https, no auth, no query).
2. Wire the class's reader/spec: a `CLI_STORE_READERS[id]` entry, an
   `API_KEY_SPECS[id]` parse, or the web-session endpoint parse. Until then
   the row ships honestly `unconfigured` (`notWired` / honest-pending) —
   catalog+fixture first, reader when dev-verified.
3. **Dev-verify before hardcoding**: hit the real endpoint with a real
   login ONCE, record the URL + response shape + date in
   `prompts/phase-7/IMPLEMENTATION.md`, set `verifiedAt`, and update the
   table above. Defensive parse; shape drift = health `error` + reason.
4. **The fixture requirement**: if the provider emits a SHAPE the FAKE
   adapter doesn't cover yet (a new window kind, a new credit form), add a
   fixture plan so the USAGE gate exercises the normalization path with
   zero network. The FAKE adapter is a first-class citizen forever.
5. Run the usage gates (`MOGGING_GATES=USAGE,USAGEUI,USAGESET`); the
   catalog-integrity assertions validate the row automatically.

**Add a class (rare — five exist):** a new mechanism means a new ADR
conversation first (the 0007 family pattern), a `classes/<name>.ts` module
with injected effects (fetchers, stores — smokes must run it on fixtures),
a `buildRealAdapters` branch, a fixture, and smoke growth. If the mechanism
involves any credential the app would hold, stop: that is the line ADR
0002 draws, and it is not crossed for a usage meter.

## Scriptability & CI

`mogging usage --json` + `usage cost --json` are stable contracts
(`PlanUsage[]`, `CostScan[]`) for scripts and CI. The six usage gates
(USAGE, USAGEUI, USAGEGLANCE, WEBUSAGE, USAGECLI, USAGESET) run in the same
114-gate sweep as everything else, on Windows, macOS, and Linux — entirely on
the FAKE adapter: under any usage smoke env the registry holds no real adapter,
the status poller holds no fetcher, and the cost scan reads only a seeded
fixture dir. Zero network is structural, not disciplined.
