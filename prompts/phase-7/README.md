# Phase 7 — Usage meters: know your pace before the limit does

Sequenced task prompts for Phase 7 of **MoggingLabs Workspace**: the swarm burns
plan quota all day — now the app must SHOW the burn. **Full CodexBar parity**
is the bar: steipete's menu-bar app tracks ~57 providers with session/weekly/
monthly gauges, pace + forecasts, cost/spend scans, usage-history charts,
provider status badges, merged-icon display, threshold notifications + reset
confetti, account switching, and a bundled CLI. We match all of it the house
way — provider adapters behind ONE seam, a catalog-as-data of ~57 providers on
FIVE mechanism classes, profile-scoped plans, a titlebar gauge + popover, and
the pace engine that says plainly whether you'll run out early, land on pace,
or leave quota unused. Parity map: `docs/research/2026-07-codexbar-parity.md`.
Same format as `prompts/phase-1..6/` (each step self-contained + pasteable as
a `/goal`, < 4000 chars). Execute in order.

> **Surface decision (binding)**: the primary surface is a POPOVER dropping
> from a titlebar usage icon — usage is a glance ("can I keep going?"), not a
> destination. Configuration gets a FULL Usage tab in Settings (12): its own
> left-nav section, the searchable ~57-provider grid, plans×profiles table,
> display options, and the privacy story. The tab configures and explains —
> it never becomes an analytical dashboard.

> **Auth stance (binding, ADR 0007 + 0007.a + 0007.b)**: usage adapters RIDE
> sessions the user's own tools already own — CLI/editor stores, ambient
> cloud-CLI credentials, or a browser session the user opted in to reading.
> API keys: PASTE ONCE → OS-keychain-encrypted (`safeStorage`), ciphertext
> only at rest, and **write-only forever after** — a saved key can be
> replaced or deleted but never viewed again (no read-back channel exists);
> env-ref pointers stay the power alternative; encryption unavailable →
> storage refused, never plaintext (the divergence from CodexBar's
> config-file keys). Read in
> memory for the one request; never persisted, copied, or displayed. Two
> honest carve-outs from "everything": we do NOT broker a username+password
> login (ADR 0002 — what StepFun would need), and app-held device flows are
> deferred behind their own ADR (Copilot ships via its CLI token instead).
> Web-session reads are their own ADR (0007.b), opt-in, off by default, and
> NEVER exposed to agents (that stays parked Branch B).

> **Before executing any step, read `IMPLEMENTATION.md`** — best-path
> decisions surveyed against shipped code. Steps 04–12 expand the pack for
> CodexBar parity; the catalog stays DATA so provider #58 is a row, not a step.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-usage-core-and-adr.md` | **DONE** (2026-07-06): ADR 0007 + `@contracts/usage` + seam (jitter/backoff/hidden-pause/stale-first-class) + FAKE + Claude adapter (endpoint dev-verified); USAGE green, 31-gate sweep green |
| 02 | `02-pace-engine.md` | **DONE** (2026-07-06): pure `pace.ts` (clock injected), projection-gated verdicts, work-day integral, 9 goldens assert verdict+delta+EXACT wording, grep-proven single formatter |
| 03 | `03-titlebar-gauge-and-popover.md` | **DONE** (2026-07-06): two-bar gauge (paint-only flips, warn/stale/off/badge states fixture-driven) + popover opening in 22.7ms measured vs 100ms budget from the CACHED snapshot; verdicts render the backend formatter VERBATIM (DOM==IPC asserted); settings stub live; gallery both themes; USAGEUI green, 32-gate sweep green (PRODUCT re-confirmed isolated: 129fps/76.4ms/32MB), MILESTONE 140fps/27.8ms, PERCEPTION strict green |
| 04 | `04-provider-catalog-and-cli-tier.md` | **DONE** (2026-07-06): `USAGE_PROVIDERS` catalog as data (5 classes, WindowSpec/windowMs) + the `cli-store` class (reader registry); **Codex** shipped real & dev-verified (local `~/.codex` session `rate_limits`, zero-network: Session 22%/Weekly 42%/prolite) + Claude (7/01); 10 fake fixtures cover every shape; USAGE asserts catalog integrity + Codex reader normalizes a fixture log + token can't ride the shape; USAGE/USAGEUI green |
| 05 | `05-apikey-and-cloud-tiers.md` | **DONE** (2026-07-06): ADR 0007.a + write-only key store (DPAPI-verified: cipher-at-rest, DB-bytes clean, replace/clear, refusal w/ env-ref hint, basic_text=unavailable) + 20 api-key rows (5 spec'd from documented APIs, OpenRouter 401-mapping live-verified; 15 honest-pending) + cloud-cli (probe-first ladder, absent live-verified — no cloud CLI on dev box); class-aware enable defaults; keySet/keyClear channels, NO getter (structurally asserted); USAGE green |
| 06 | `06-websession-tier-and-adr.md` | ADR 0007.b + the `web-session` class (Cursor, Devin, Perplexity, Kimi, Mistral spend, …): paste-first, store-read opt-in/OFF, read-only, never agent-facing; WEBUSAGE gate |
| 07 | `07-cost-spend-and-history.md` | Local cost scan (Codex/Claude JSONL) + spend column + history ring/sparklines from the poller's own samples; USAGE grows |
| 08 | `08-provider-status-feed.md` | Provider status/incident feed (public endpoints, enabled-only, jittered) → tile chip + icon overlay; "they're down" ≠ "you're out"; USAGE grows |
| 09 | `09-profiles-plans-and-alerts.md` | Plans × profiles switcher (N per provider), threshold notifications + reset confetti (any provider), failover suggestion feed |
| 10 | `10-titlebar-display-options.md` | Merged/pinned/auto gauge modes + switcher, gauge-content + reset-time style options (CodexBar display parity); USAGEUI grows |
| 11 | `11-usage-cli-verbs.md` | `mogging usage / cost / providers / refresh / set-key(stdin) / clear-key` over the existing authed app endpoint (daemon stays v3; no get-key exists); USAGECLI gate |
| 12 | `12-usage-settings-tab.md` | The FULL Usage tab: searchable ~57-provider grid across 5 classes, plans table, pace/display/alerts, history/cost, privacy; USAGESET gate |
| 13 | `13-usage-milestone.md` | All usage gates green on all 3 CI OSes + docs/12-usage.md (5 classes, parity map, authoring guide); pack freeze + per-OS numbers |

## Overall Definition of Done
- One glance at the titlebar answers "can I keep working, and until when?" for
  the ACTIVE profile; one click answers it for every plan on every provider.
- ~57 providers across five classes (cli-store · api-key · cloud-cli ·
  web-session · local) all load from the user's own sessions/keys — no logins
  the app performs, no secret the app stores, on Windows, macOS, and Linux.
- The pace verdict is computed by one pure fixture-tested module, worded
  identically in popover, tab, CLI, and notifications.
- Cost scans, spend, usage history, provider status, merged-icon display, and
  reset confetti all ship — CodexBar's feature surface, the house way.
- A bundled `mogging usage` CLI reads it all for scripts/CI (daemon still v3).
- The full sweep — WITH every usage gate — is green on all three CI OSes.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean.
- The step's env-gated smoke green via `scripts/qa-smokes.sh` isolation; both
  perf budgets (MILESTONE + PERCEPTION) re-run after any renderer-touching step.
- Gallery states staged for every new visual surface (both themes).

## Guardrails
- **ADR 0002/0007/0007.a/0007.b**: no credential is logged or shown; keys
  live ONLY as OS-keychain ciphertext (write-only: replace/delete, never
  view) or env-ref pointers; web-session store-reads are opt-in/OFF/
  read-only/never agent-facing; no password-login brokering; app-held OAuth deferred. Adapters
  read KNOWN locations only. Smokes run FAKE fixtures exclusively.
- **ADR 0005**: usage numbers, plan names, provider ids, keys, cookies, and
  account identifiers NEVER enter telemetry — counts and booleans only.
- The daemon protocol stays at v3 — usage lives in the app backend and the
  existing authed app endpoint; panes carry zero new wire surface.
- Platform differences live in adapter path resolution + CI config only.
- Poll politely: per-provider cadence presets, jittered, paused when hidden,
  backoff on error; a 429/incident dims to stale, never a retry storm.
- The catalog is DATA: a new provider on an existing class is one row + one
  fixture, never a new step. The FAKE adapter is first-class forever.

## Parallelization
01 → 02 → 03 is the spine (DONE through 02). After 03: the class lanes
04 → 05 → 06 grow the catalog (06 needs its ADR first); 07 (cost/history)
and 08 (status) ride the seam independently; 09 (alerts) needs the fan-out;
10 (display) needs 03; 11 (CLI) needs the seam; 12 (tab) needs 04–10.
13 freezes. One lane is fine; the seam steps (04–08, 11) don't touch the UI
steps (03, 10) beyond contracts.
