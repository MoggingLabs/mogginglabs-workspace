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

## 08 — status feed

- Public statuspage endpoints only (no auth/cookies); poll ENABLED
  providers on one shared jittered cadence; an outage relabels a failing
  tile "provider outage" so red reads as "they're down," not "you're out".

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
