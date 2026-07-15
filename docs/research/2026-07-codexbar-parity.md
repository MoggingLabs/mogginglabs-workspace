# Research — CodexBar feature/provider parity for the usage meters

- **Date:** 2026-07-06 · **Source:** github.com/steipete/CodexBar (MIT) —
  README + docs reviewed for FEATURES and MECHANISMS. Clean-room: we study
  what it does, never its Swift code; ours is TypeScript/Electron on the
  Phase-7 seam.
- **Ask (Pedro):** support everything CodexBar does, provider-wise and
  functionality-wise. This doc is the map; the phase-7 pack (expanded
  2026-07-06) is the route.

## 1. What CodexBar is

The reference menu-bar usage tracker: ~57 providers, session/weekly/monthly
gauges with countdowns, pace + forecasts, cost/spend tracking with local log
scans, usage-history charts, provider status/incident badges, merged-icon
display modes, threshold notifications + reset confetti, account switching,
a bundled CLI, Sparkle updates, 21-language catalog, WidgetKit widgets.

## 2. Provider mechanisms → our five adapter CLASSES (catalog stays data)

One adapter CLASS per mechanism; every provider is a DATA row
(`UsageProviderDef`) on one of them. 50+ providers ≠ 50 adapters.

| Class | Mechanism | CodexBar examples | Our stance |
|---|---|---|---|
| `cli-store` | read the CLI/editor's OWN stored session (files, SQLite, XML, its keychain entry) | Codex, Claude, Gemini, Copilot (CLI-stored token), Zed, Kiro, Kilo, Augment, Grok CLI, JetBrains (IDE XML), Codebuff (`~/.config/manicode`), OpenCode (local SQLite), Windsurf (local cache) | ADR 0007 verbatim — ships freely |
| `api-key` | paste-once → OS-keychain ciphertext, WRITE-ONLY (replace/delete, never view; no plaintext at rest, no read-back channel — CodexBar stores keys in a config file, we deliberately don't); env-ref pointer as the power path | OpenAI Admin, Claude Admin, OpenRouter, DeepSeek, Moonshot, MiniMax, z.ai, Venice, Poe, Chutes, Deepgram, ElevenLabs, GroqCloud, LiteLLM, LLM-Proxy, ClawRouter, Crof, Doubao, Warp (GraphQL token), Alibaba (key mode) | ADR 0007.a (pack step 05) — ships freely |
| `cloud-cli` | ambient cloud credentials via the vendor CLI | Vertex AI (gcloud), AWS Bedrock (aws profile/SSO) | ADR 0007 family — ships freely |
| `web-session` | the user's BROWSER session: manual cookie-header paste, or opt-in cookie-store read (Chrome/Edge/Brave Safe-Storage key via OS keychain; Safari needs FDA on mac) | Cursor, Devin, Manus, T3 Chat, Kimi, Perplexity, Xiaomi MiMo, Sakana, Abacus, Mistral spend, Amp, Command Code, OpenCode workspace, Alibaba (cookie mode), Grok fallback | **Needs ADR 0007.b** (pack step 06): paste-first, store-read opt-in per provider default OFF, read-only usage endpoints, never agent-facing. This is the usage-only cousin of parked Branch B — consciously decided, not drifted into |
| `local` | no auth at all | Ollama (localhost), Antigravity probe (experimental), local JSONL cost scans | ships freely |

**Two honest exceptions (the only "everything" carve-outs):**
1. **StepFun (username+password login)** — CodexBar performs a password
   login itself. That IS brokering auth (ADR 0002's exact line). We refuse;
   StepFun ships only if it grows a key/session mechanism.
2. **App-held device flows** (CodexBar's own GitHub device flow for
   Copilot) — app-held credentials are deferred behind their own ADR
   (0008.d). Copilot ships via the CLI-stored token instead (same data,
   CLI-owned session). Providers reachable ONLY by app-held flows wait.

## 3. Functionality map (CodexBar → pack step)

| CodexBar feature | Ours | Step |
|---|---|---|
| Session/weekly/monthly gauges + countdowns | windows are data; monthly = a third window row | 01 ✓ / 04 |
| Pace, forecasts | pace engine (verdicts, blended burn) | 02 ✓ |
| Menu-bar dropdown | titlebar gauge + popover | 03 |
| ~57 providers | catalog-as-data on five classes | 04–06 |
| Cost scans (Codex/Claude local logs) + spend | local JSONL cost scan, spend column | 07 |
| Usage-history charts (API-backed rows) | local history ring + sparklines | 07 |
| Provider status polling, incident badges | status feed (public endpoints), tile badge + icon overlay | 08 |
| Threshold notifications, reset confetti | house toasts + optional confetti (quiet default) | 09 |
| Account switching | profiles × plans (pointer sets — cleaner than CodexBar's copy) | 09 |
| Merged icons, display config, highest-usage auto-select, reset-time style | titlebar display options | 10 |
| Settings → Providers grid, per-provider toggles, set-api-key | full Usage tab, searchable grid, paste-once keychain slots (write-only) + env-ref | 12 |
| Advanced keychain-access toggles | web-session consent per provider | 06/10 |
| Bundled CLI (`codexbar config/cost/serve`) | `mogging usage` verbs over the APP endpoint (no daemon change) | 11 |
| Sparkle updates | electron-updater — ALREADY SHIPPED (6/06) | — |
| WidgetKit widgets | N/A by design: our titlebar gauge is always on screen; a desktop-widget story is an OS-feature phase, not usage |
| 21 languages | app-wide concern; the app isn't localized yet — deferred to a localization phase, NOT done piecemeal here |

## 4. Risks the expansion inherits

- Web-session tier is the sharp edge: Chromium Safe-Storage decryption
  touches the OS keychain (Windows DPAPI / macOS Keychain / libsecret).
  Paste-first keeps most users off it; the store-read path is per-provider
  opt-in, read-only, loudly consented, and never feeds agents (ADR 0007.b).
- 50+ provider endpoints WILL drift — health `error` + reason, catalog rows
  carry a `verifiedAt` date, books record shapes (the 7/01 discipline).
- Provider sprawl in UI: searchable grid + "detected first" ordering (10);
  popover shows enabled providers only.
- Status endpoints are public but polling 50 of them is rude — status polls
  only ENABLED providers, one shared cadence, jittered (08).
