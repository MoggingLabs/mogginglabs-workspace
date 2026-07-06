# Phase 7 — implementation notes (the best-path decisions)

Surveyed 2026-07-06 against shipped code (post-v0.4.0), before any step
runs. Same contract as phase-8's IMPLEMENTATION.md: steps default to these
choices and deviate only by recording why here. House rules assumed: no new
deps, daemon v3 frozen, smokes network-free, no subagents.

## Readiness verdict

**Phase 7 can start NOW.** Everything it stands on shipped: profiles +
failover (phase 4), the settings full-app page with left section nav
(phase 5), the titlebar right icon cluster, the toast system with
action/secondaryAction (6/06), `agents:detect` IPC (6/06 first-run), the
settings KV, and the 30-gate sweep. Nothing in this pack touches phase 8's
seams; ADR 0007 and docs/12 are both unclaimed. The pack runs BEFORE phase
8 by design — 8 and 9 consume its patterns, not the reverse.

## What the pack stands on (verified in source)

| Shipped piece | Where | What the phase reuses |
|---|---|---|
| Settings page: left section nav, sections array, complex sections as own modules | `src/ui/features/settings/index.ts` (~158), `profiles-hosts.ts` | the Usage tab = a nav entry + `usage.ts` module (06) |
| Titlebar right cluster | `src/ui/shell/titlebar.ts`, app-shell returns `titlebarRight` | gauge icon mount (03) |
| Toast with `action`/`secondaryAction` | `src/ui/components/toast.ts:13-15` | threshold + failover toasts (05) |
| CLI detection + per-adapter data (`installHint` pattern) | `src/backend/features/agents/adapters.ts`, `agents:detect` IPC | provider detected-chips; the per-adapter home tables live beside it |
| Profile pointer mechanism (env at spawn; usage-limit failover) | `agents/launch.ts` + settings-store | popover/tab switch action + 05's suggestion (one failover path, two triggers) |
| Settings KV | `settings-store.ts` `getSetting`/`setSetting` | cadence, thresholds, baseline, re-arm state |
| Typed IPC slice pattern | `contracts/ipc/browser.ipc.ts`, `update.ipc.ts` (6/05-06) | `usage.ipc.ts` + channels entry copies it |

## 01 — seam + ADR

- IPC: `src/contracts/ipc/usage.ipc.ts` + a `UsageChannels` entry —
  `usage:list` (snapshot), `usage:refresh`, one push event. Copy the
  browser.ipc.ts shape verbatim.
- Poller visibility: main pushes window focus/hide into the backend (the
  `initAutoUpdate(winGetter)` pattern) — the poller never asks the
  renderer.
- FAKE adapter reads its fixture from `MOGGING_USAGE_FIXTURE` (a JSON
  path); every smoke sets it. When ANY `MOGGING_USAGE*` env is present the
  registry registers ONLY the FAKE adapter — real adapters are physically
  absent under smoke (the milestone's zero-network assert becomes
  structural).
- **Clock is a parameter.** Poller and pace both take `now` injected —
  fixtures pin it; nothing calls `Date.now()` in a code path a smoke
  asserts.

## Claude adapter mechanics (01) — the honest ladder

- Credential home per OS: win/linux `~/.claude/.credentials.json`; macOS
  stores in the **Keychain** — read via
  `security find-generic-password -s "Claude Code-credentials" -w`
  (execFile, output straight to memory). That is still "the CLI's own
  store" (ADR 0007); it is exactly how the reference app does switchable
  accounts.
- macOS Keychain reads can raise a user prompt: fetch ONLY on explicit
  enable/refresh or timer — never speculatively at boot.
- The usage endpoint is the one the CLI itself polls (the OAuth usage/
  rate-limit route). **Dev-verify the exact URL + response shape first and
  record both in the books with the date** — then hardcode. Any shape
  drift at runtime = health `error` with a human reason, never a throw.
- **Dev-verified 2026-07-06 (7/01, this machine, real logged-in CLI):**
  `GET https://api.anthropic.com/api/oauth/usage` with the store's
  `claudeAiOauth.accessToken` (+ `anthropic-beta: oauth-2025-04-20`) →
  200 with `five_hour` / `seven_day` / `seven_day_opus` (each
  `{ utilization: number, resets_at: ISO }`) among others; adapter parses
  exactly those three, defensively. Live read: Session 43%, Weekly 9%,
  health fresh.

## Codex adapter mechanics (04) — dev-verified 2026-07-06

- **Codex usage is LOCAL, zero-network** — the cleanest source on the whole
  catalog. The newest rollout under `~/.codex/sessions/**/*.jsonl` carries a
  `rate_limits` object: `primary` (window_minutes 300 = the 5h session) and
  `secondary` (window_minutes 10080 = weekly), each
  `{ used_percent, window_minutes, resets_at }` with `resets_at` in epoch
  SECONDS; `plan_type` names the plan. Real read this machine: primary 22%,
  secondary 42%, plan "prolite", source mtime 2026-05-29 (honest age — as
  fresh as Codex last ran).
- The reader walks the CLI's OWN session tree (a known location, not a
  crawl), scans the newest file from the end for `rate_limits`, and drops
  the token (never touches auth.json's access_token for a local read). The
  smoke unit-tests it on a fixture session log AND asserts the token can't
  ride the normalized shape.
- Only **Codex** and **Claude** are installed on the dev machine, so those
  two are `verifiedAt: 2026-07-06`; the other cli-store rows ship
  catalog+fixture and read `unconfigured` honestly (`notWired`) until a real
  login verifies each shape — the catalog is data, one row per verification.

## Key store mechanics (05) — dev-verified 2026-07-06

- `safeStorage` on this machine (DPAPI) round-trips: paste → base64 cipher in
  the KV, plaintext ABSENT from the settings DB bytes (WAL included),
  adapter-path decrypt returns it, replace changes the cipher, clear kills
  resolution. The forced-unavailable path refuses with the env-ref hint.
- **Linux honesty**: `basic_text` is obfuscation, not encryption —
  `isKeyVaultAvailable()` counts it UNAVAILABLE and storage refuses (the
  smoke platform-conditions its cipher PROBES on real vault presence; the
  never-plaintext-at-rest CLAIM holds everywhere via refusal).
- **OpenRouter live check** (one bounded dev request): `GET /api/v1/credits`
  answers 401 to a bogus bearer → our exact "key rejected — replace it in
  Settings" mapping. A 200-path `verifiedAt` awaits a real key — the paste/
  replace/delete/decrypt path is fully proven without one.
- api-key specs implemented from documented APIs: OpenRouter (credits),
  DeepSeek (balance), Moonshot (balance), ElevenLabs (subscription chars),
  Deepgram (projects). The other 15 rows ship catalog+honest-pending reader
  (`API_KEY_PENDING`) — a saved key stays ready and the row lights up when
  its spec is dev-verified.
- api-key/cloud-cli/web-session rows default DISABLED (class-aware default
  in the seam) — a real session must not poll 20 unconfigured endpoints;
  saving a key auto-enables its provider.
- cloud-cli: presence probed via where/which FIRST (a missing binary must
  read 'absent' on every OS; shell-mode exit-1 and Node's EINVAL-on-.cmd
  both mislabel otherwise); gcloud's .cmd shim runs under a shell only
  after a positive probe. Neither CLI is on this machine — the absent
  ladder is what's live-verified (fixture bins keep it deterministic in
  the smoke).

## web-session mechanics (06) — the sharpest class, security-first

- **Paste is the headline and rides the SAME write-only 0007.a store** — a
  pasted cookie IS a key (`resolveKey`); no separate secret path. Most users
  never touch the browser store.
- **Store-read is structurally gated**: `resolveSession` calls the cookie
  backend ONLY when `storeReadEnabled(id)` is true. The WEBUSAGE smoke wraps
  the backend in a SPY and asserts `reads === 0` while off — the guarantee is
  the code path, not a promise.
- **The real Chrome/Edge decrypt is deferred, honestly.** Reading a real
  browser cookie needs the OS keychain Safe-Storage key + AES-GCM over the
  cookie SQLite — a per-OS job Electron's safeStorage can't do (it only
  decrypts what IT encrypted; the DPAPI/keychain unwrap of Chrome's key needs
  more). So `realCookieBackend` returns null (honest degrade to "paste your
  cookie") and the FIXTURE backend (a JSON store) drives the smoke's gating +
  no-leak proofs. Paste-first means this is opt-in and rare — the security
  surface ships fully proven; the convenience decrypt lands when dev-verified
  against a real browser.
- **Endpoint parses are honest-pending** (no accounts for these ~15
  providers): a resolved session reports "session found (via paste|store)"
  and the value is DROPPED — never rides the PlanUsage (grep-asserted). A
  real login upgrades a row's parse + verifiedAt.
- **Sensitive-origin blocklist** (`SENSITIVE_ORIGIN_PATTERNS` in contracts,
  the phase-8/01 concept needed here first): bank/mail/gov origins refuse
  store-read even when opted in AND named — asserted with a chase.com row.
- No-getter is STRUCTURAL and asserted: the allowlist has keySet/keyClear/
  webReadSet (a consent toggle) and NOTHING matching a key/cookie value-
  getter. configGet returns presence (kind + webRead bool), never a value.

## 04–06 — the provider catalog (CodexBar parity, five classes)

- One adapter CLASS per mechanism, every provider a DATA ROW
  (`UsageProviderDef`). ~57 providers ≠ ~57 adapters — dispatch keys on
  `klass`. Adding provider #58 on an existing class is a row + a fixture,
  never a step. Parity map + per-provider mechanism table lives in
  `docs/research/2026-07-codexbar-parity.md`.
- Classes: `cli-store` (04, ADR 0007 verbatim — the biggest tier),
  `api-key` (05, ADR 0007.a — see below), `cloud-cli` (05, gcloud/aws
  ambient), `web-session` (06, its OWN ADR 0007.b — paste-first,
  store-read opt-in/OFF/read-only, NEVER agent-facing), `local`
  (Ollama/Antigravity/cost-scan).
- **Keys (0007.a, Pedro's call 2026-07-06): paste-once is the headline.**
  `safeStorage.encryptString` → ciphertext in the settings KV; decrypt
  backend-side per request. WRITE-ONLY is structural: the IPC/endpoint
  surface has set/clear/presence and NO getter — a saved key is
  replaceable and deletable, never viewable. `isEncryptionAvailable()`
  false (Linux, no keyring) → REFUSE storage, offer env-ref — never
  plaintext at rest. Env-ref pointers remain the power path. CLI parity:
  `mogging usage set-key --stdin` / `clear-key` (stdin, never argv).
- **Two carve-outs from "everything", by design, not omission:** no
  username+password login brokering (StepFun — ADR 0002); app-held device
  flows deferred to their own ADR (Copilot rides its CLI token instead).
  Both are stated in the ADRs and docs/12, so "parity" is honest.
- Each catalog row carries `verifiedAt` — the date its endpoint/shape was
  dev-checked (the 7/01 discipline; books record the shape). A row with a
  stale/absent verifiedAt still ships FAKE-covered but is flagged in review.
- The FAKE adapter grows a fixture per emittable shape (credits, daily
  quota, spend graph, Prometheus metric, SQLite-backed, XML-backed, cookie
  paste) — the USAGE gate exercises every normalization path, zero network.

## 07 — cost/spend/history

- Cost scan parses the LOCAL JSONL logs Codex/Claude already write (known
  path table, on demand, offline — never a watch or a network call).
- History is OUR sampled percentages ringed in the KV (bounded, counts not
  content) — every provider gets a sparkline free, no per-provider endpoint.

## cost/history mechanics (07) — dev-verified 2026-07-06

- **Log shapes read off THIS machine's real logs (the 7/01 discipline):**
  - Codex `~/.codex/sessions/YYYY/MM/**/rollout-*.jsonl`: a `session_meta`
    line (cli 0.133 carries `cli_version`/`model_provider` but NO model id),
    then `event_msg` lines with `payload.type: "token_count"` and
    `payload.info.last_token_usage { input_tokens, cached_input_tokens,
    output_tokens, total_tokens }` PER TURN (ISO `timestamp` per line) —
    summing `last_token_usage` across events equals the session total.
  - Claude Code `~/.claude/projects/<proj>/<session>.jsonl`: `assistant`
    lines carry `message.usage { input_tokens, output_tokens,
    cache_creation_input_tokens, cache_read_input_tokens, cache_creation:
    { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } }` +
    `message.model`; streamed chunks DUPLICATE a message under one
    `requestId` → the scanner dedupes per file. Current CLI writes no
    `costUSD`; when an older log carries one it is trusted verbatim.
- **Spend is an estimate, never invented**: a prefix-matched price table
  (USD/MTok — Claude rows from the claude-api reference cached 2026-06-24:
  fable/mythos 10/50, opus 4.5–4.8 5/25, opus 4.0/4.1 15/75, sonnet 3/15,
  haiku-4 1/5; gpt-5 1.25/10 from OpenAI's public page, knowledge-dated) ×
  documented cache multipliers (read 0.1×, write 1.25× 5m / 2× 1h on the
  input rate). Unknown model → TOKENS still counted, spend contributes 0,
  and `reason` says "spend under-counts". Days bucket on the LOCAL date.
- **Bounded by construction**: 30-day window (file mtime AND record
  timestamp), 400-newest-files cap (flagged in `reason` when it fires),
  depth-6 walk of the CLI's own tree only, malformed lines skipped.
- **Real-machine manual check (this box, 2026-07-06)**: Claude → 7 days,
  $24–$988/day API-equivalent (sweep-heavy days dominate; cache reads are
  most of the tokens), cap fired at 400 of 1093 files and said so; ~1.9s
  per on-demand scan (why it NEVER rides the poll cadence). Codex → logs
  present but older than the window → labeled empty scan, correct.
- **History ring**: `HISTORY_MAX` 96 ints per (provider, window-label slug)
  in the settings KV (`usage.hist.<id>.<slug>`), appended on every FRESH
  poll result inside the seam (stale re-serves are not new points), clamped
  0–100, corrupt value degrades to empty. Counts, not content — ADR 0005.
- **Smoke is TZ-proof**: fixture timestamps are LOCAL-midday, so per-day
  bucketing asserts exactly on any CI timezone; the claude fixture's spend
  golden (0.02125 over 11,800 tokens at opus-4.8 rates) pins the table and
  the multipliers; the codex fixture (no model id) pins honest unpricing.
- `usage:cost` runs the scan on demand behind the poller's FAKE-under-smoke
  rule (fixture world scans only `MOGGING_USAGE_COSTDIR`; other smokes get a
  labeled empty; real dirs in a real session alone); `usage:history` reads
  the KV ring. Neither can return a secret — both are counts/labels.

## 08 — status feed

- Public statuspage endpoints only (no auth/cookies); poll ENABLED
  providers on one shared jittered cadence; an outage relabels a failing
  tile "provider outage" so red reads as "they're down," not "you're out".

## status-feed mechanics (08) — dev-verified 2026-07-06

- **Endpoints dev-verified live (curl, this machine, 2026-07-06)** — all
  plain statuspage.io `{ status: { indicator, description } }` JSON, https,
  no auth, no cookies, no query:
  - claude → `https://status.claude.com/api/v2/status.json`
    (status.anthropic.com 302s here — the FINAL url is the row)
  - codex + openai-admin → `https://status.openai.com/api/v2/status.json`
  - cursor → `https://status.cursor.com/api/v2/status.json`
  - elevenlabs → `https://status.elevenlabs.io/api/v2/status.json`
  - deepgram → `https://status.deepgram.com/api/v2/status.json`
  - OpenRouter/Perplexity/DeepSeek expose NO plain JSON status endpoint
    (404/HTML/next.js pages) → their rows honestly carry no statusUrl.
- **The DoD's observed incident happened for real**: on verification day
  BOTH Claude ("Partially Degraded Service") and OpenAI ("Partial System
  Degradation") status pages reported live `minor` incidents; the shipped
  normalizer read both as `degraded` with the page's own wording as the
  note — a real session would chip both tiles right now. The three healthy
  pages read `operational`.
- **Normalization**: statuspage indicator none→operational, minor→degraded,
  major/critical→outage; generic `{status:"ok"|"down"|…}` and `{ok:bool}`
  health shapes; ANYTHING else (HTML, junk, surprises) → `unknown`, never a
  throw, never an error surface — an absent status page is not an incident.
- **Polling discipline**: ONE shared pass on its own clock (5m default —
  incidents move in minutes), SEQUENTIAL within the pass (50 providers must
  never mean 50 concurrent hammers), ±10% jitter, per-provider exponential
  backoff on fetch failure (capped 1h), hidden-window pause, enabled-only
  re-checked per pass (a provider disabled mid-flight drops from the feed).
- **FAKE-under-smoke is structural**: fixture world registers ONE fake row
  behind `fixture://status` served from `MOGGING_USAGE_STATUS`; any other
  smoke gets a NULL fetcher (no endpoint may be touched at all); real
  public endpoints exist only in a real session. Catalog integrity now
  refuses any statusUrl that isn't plain https (the review guardrail,
  smoke-asserted).
- **"They're down" ≠ "you're out"** is wired in the VIEW seam (main
  enrich): outage + error/stale → reason becomes "provider outage — <the
  page's wording>" and the pace line is muted so the tile leads with the
  outage. Overlay = ONE 6px glyph in the existing badge idiom (opposite
  corner, danger ink) — armed on any enabled outage, never a takeover.
- ADR 0005: the enum state + booleans may enter telemetry; note text and
  urls never do (no status telemetry is emitted at all in this step).
## plans × profiles mechanics (09) — shipped 2026-07-06

- **Fan-out is an adapter property, not a blanket rule**: `perProfile: true`
  on every REAL adapter makes the seam read one home per profile lane
  (three profiles → three tiles); the FAKE adapter stays single-lane
  because its fixture set IS a modeled fan-out — flagging it would square
  the fixtures. Lane failure is per-lane: a capped profile dims stale while
  its siblings stay fresh (single-lane adapters keep the old whole-set
  stale re-serve).
- **"Active" is Phase-4's order 0, nothing new**: the popover switch and
  the failover-toast action are ONE implementation (`switchActive`) that
  swaps `order` values via the EXISTING sanitized `profiles:save` path and
  announces on the Phase-4 profiles port (palette + failover data follow
  live). Pointers flip; nothing re-authenticates; running panes keep the
  env they were spawned with — the popover says so in a one-line hint.
- **Thresholds are a pure module** (`thresholds.ts`): primary-window
  evaluation, state keyed `usage.thr.<provider>.<profile>` with the WINDOW
  EPOCH (resetsAt) inside, persisted in the settings KV → a restart never
  re-fires a spent threshold. A new epoch re-arms and emits ONE quiet
  "fresh window". A 0→97 jump costs ONE toast (both levels spent). Copy is
  composed in the module ONCE; the warn body is the 7/02 verdict line
  VERBATIM (smoke-asserted module-level AND DOM-vs-IPC end-to-end).
- **The suggestion, never a switch**: failover rides the warn alert only
  when the ACTIVE lane crossed AND a sibling sits under 50% (best = idlest);
  the human clicks, the pointers flip (the gate philosophy). Auto-failover
  remains the Phase-4 in-pane behavior, untouched.
- **Identity treatment** mirrors the rail's selection grammar (dense 4px
  left bar + quiet wash, paint only); severity orders tiles runs-out-first,
  hotter-first — ordering is layout, wording never moves out of 7/02.
- Confetti is OPT-IN (default quiet): ~1s of falling flecks anchored to the
  toast corner, `prefers-reduced-motion` disables it entirely.
- ADR 0005: alert telemetry carries kind/level classes + booleans
  (failoverOffered, confetti) — never plan names, percents, or profile
  names; the switch event carries provider id + a boolean.

- **Marathon-tail flake, investigated 2026-07-06 (not a 7/08 defect):**
  WORKTREE failed twice right after the 33-gate marathon (clean AND forced
  worktree removal both refused — the Windows PTY/conhost-teardown lock
  window), then passed 4/4 consecutive runs with the same diff; MILESTONE
  logged one ~1s frame gap on the marathon tail and passed isolated with
  wide margins (49.8fps / 111ms / 32MB). The worktree smoke now echoes
  `cleanRemoved`/`forcedRemoved` verbatim so the next flake names itself —
  the two-FAIL pattern joins 7/06's collision note: marathon contention
  can FAIL/MISS gates, it has never false-passed one.

## 11 — the CLI

- `mogging usage/*` are new REQUEST TYPES on the EXISTING 6/05b app endpoint
  (token-authed) — NOT a new listener, NOT daemon protocol (stays v3).
  Verdict strings come from 02's formatter; the CLI never re-spells them.

## (legacy note) 04 — Codex/OpenAI + Gemini

- Prefer **reading the CLI's own local state** over calling provider
  endpoints: Codex persists rate-limit snapshots in its session state
  (`~/.codex/`), Gemini holds `oauth_creds.json` + quota responses. An
  adapter that can't find usable local state reports `unconfigured` with
  a reason that names the missing thing — no speculative API calls.
- Each adapter carries a tested-version floor (the phase-8 capability-
  table idea, applied per adapter); below it → `unconfigured`, honest.
- The authoring guide (docs/12 §) documents the ladder: local state →
  CLI-owned endpoint → unconfigured. Never our own OAuth.

## 02 — pace engine

- One pure module, `pace.ts`, zero imports: `computePace(windows,
  baseline, now)` → `{ deltaPct, runOutAt?, verdict }`;
  `formatVerdict(p)` is the SINGLE wording source — popover, tab, toasts,
  docs all quote it (05 and 06 smokes assert string equality against it).
- Golden fixtures = an array of (input, expected) pairs in the smoke;
  cover: early-window surplus, dead-on pace, run-out before reset,
  exhausted, fresh reset, zero-baseline weekend.

## 03 — gauge + popover

- Gauge = two DOM bars (divs), class-flip state only, mounted in
  `titlebarRight`; no canvas, no rAF loop — paint-only like the update
  dot (6/06).
- Popover = anchored panel reusing the palette's elevation tokens and
  dismiss grammar (Esc/click-away); opens on the CACHED snapshot
  synchronously, refresh happens in place. PERCEPTION-grade open is free
  if nothing awaits I/O before first paint.
- The settings stub this step ships is three lines — 06 replaces it;
  don't decorate it.

## 05 — plans × profiles + alerts

- Fan-out key is `(providerId, profileId)`; the snapshot is ONE array —
  popover tiles, severity ordering, and 06's table are all views over it
  (no second data path, smoke-asserted in 06).
- Threshold re-arm state: KV key `usage.thr.<provider>.<profile>.<epoch>`
  where epoch = the window's reset timestamp — restart-safe by
  construction, no migration.
- The failover toast action invokes the EXISTING phase-4 failover entry
  point (launch.ts) — if a second implementation appears in review, the
  step failed.

## 06 — the Usage tab

- A `sections` array entry + `usage.ts` module beside `profiles-hosts.ts`
  — the established complex-section pattern; index.ts stays an assembler.
- Detected chips reuse `agents:detect` (already how first-run does it).
- Every knob mutates through the same IPC the popover uses; the tab holds
  ZERO private state beyond focus.

## 07 — milestone

- Gate count goes 30 → 33 (USAGE, USAGEUI, USAGESET). Count from the
  script when updating books.
- Platform suspects, pre-named: Keychain access on macos CI (headless —
  the FAKE adapter means real Keychain is never touched in smokes),
  8.3/canonical paths on Windows for config homes (6/03 helper), XDG
  variance on Linux.

## Execution order (solo)

01 → 02 → 03 → 04 → 05 → 06 → 07. 04 is independent of 03 but there is no
parallel executor — the order above keeps every commit green.

## Risks worth naming now

1. Provider endpoint/shape drift is CERTAIN long-term — health `error`
   with reason + books recording the verified shape and date is the
   contract; adapters fail soft forever.
2. macOS Keychain prompts (first read) — surface a one-line explainer in
   the Usage tab's provider row the first time; never read at boot.
3. Codex local-state format varies by CLI version — version floor +
   `unconfigured` honesty beats parsing heroics.
4. Threshold spam on flapping usage values — single-fire per window epoch
   (05's re-arm rule) is the guard; the smoke stages a flap.
5. The popover must never block on fetch — cached-snapshot-first is a
   DoD-level rule (03), not a nice-to-have.
