# Phase 7 — usage meters: the campaign report

Receipts for the usage pack (steps 01–13, commits `4f6b881` → the freeze).
Sweep grew 30 → **35 gates** (USAGE · USAGEUI · WEBUSAGE · USAGECLI ·
USAGESET), same list on four environments. Certification: dispatch run
**28789330898** (linux + macos + windows full uncut sweeps) on `1a0d5a2`,
plus the local Windows sweep. Per-step mechanics live in
`IMPLEMENTATION.md`; this file keeps the finds worth remembering.

## Environmental finds (the 6/0x pattern, continued)

| Find | Evidence | Standing lesson |
|---|---|---|
| **Any `MOGGING_*` env reads as a smoke world** — adapters empty, cost scan disabled. A `MOGGING_USERDATA`-isolated boot can never show real adapters. | 7/11 dev check: `mogging usage` printed "no usage sources"; cost said "disabled under smoke" | Real-session verification must run env-clean; the smokes are unaffected (qa-smokes always sets the full env). Recorded in IMPLEMENTATION §11. |
| **Windows conhost-teardown lock window** can fail `git worktree remove` (clean AND `--force`) right after a marathon sweep. | WORKTREE FAIL×2 post-marathon (7/08), then 4/4 isolated + full-sweep green on identical code | Marathon contention FAILs/MISSes gates, it has never false-passed one. The worktree smoke now echoes `cleanRemoved`/`forcedRemoved` verbatim so the next flake names itself. |
| **Marathon-tail collisions surface as MISSING** (no result JSON), not FAIL. | PERCEPTION MISSING on the 7/11 marathon; green isolated immediately after | Re-run the missing gate isolated; treat MISSING as contention until proven otherwise. |
| **Anthropic's status page 302s** (`status.anthropic.com` → `status.claude.com`); OpenRouter/Perplexity/DeepSeek expose no plain statuspage JSON at all. | curl matrix, 2026-07-06 (IMPLEMENTATION §08) | Catalog rows carry the FINAL url; providers without a plain https JSON get no `statusUrl` — the catalog-integrity smoke refuses anything else. |
| **Both Claude and OpenAI had live `minor` incidents on verification day** — the "observed incident" DoD happened for real. | status bodies normalized `degraded` with the pages' own wording | Status endpoints drift and flap; `unknown` (never error) + per-provider backoff is the right posture. |
| **Codex cli 0.133 session logs carry NO model id; current Claude Code writes no `costUSD`.** | real-log parse, 2026-07-06 (IMPLEMENTATION §07) | The cost scan under-reports honestly (`reason: spend under-counts`) rather than inventing prices; an older log's own `costUSD` is trusted verbatim. |

## Product bugs found by the gates (fixed in the product)

| Bug | Found by | Fix |
|---|---|---|
| `configGet` was adapter-scoped (a 7/03 stub legacy): a saved key on a catalog row could never render its saved state in a fixture world, and api-key rows DISPLAYED enabled while the seam's class-aware default treated them as off. | USAGESET's masked-key ladder (`chip:false` after a proven save), bisected raw-IPC → click-trace → value-survival | configGet now serves catalog∪adapters with the seam's own enable rule (7/12). |
| The gallery's usage states silently rendered an EMPTY world when launched without `MOGGING_GALLERY=1` (the fixture-world arm). | the 7/09 popover shot showing "No usage sources yet" | Gallery invocations documented; shots re-taken. Not a product defect — an invocation contract worth writing down. |

## The numbers (certification, run 28789330898)

| Environment | MILESTONE stress | Popover open | Key vault |
|---|---|---|---|
| Windows local (strict) | 49.8fps / 111.1ms / 32MB | 15.6–22.7ms | DPAPI round-trip |
| windows-latest (soft) | 27.5fps / 171.9ms / 26MB | 17.2ms | DPAPI round-trip |
| macos-26 (soft) | 25.8fps / 152.4ms / 39MB | 18.8ms | Keychain round-trip |
| ubuntu-latest (soft) | 23.5fps / 116.7ms / 30MB | 31.1ms | **no keyring → refusal path certified** |

All four: 35/35 gates green. The Linux row is the best line in the table:
a keyring-less machine proved "never plaintext at rest" by REFUSING —
the vault-conditioned probes weakened nothing.

- Verified-real citizens per class (books, 2026-07-06): Claude + Codex
  (cli-store, real logins), OpenRouter (api-key, 401-boundary +
  DPAPI-at-rest), Vertex/Bedrock (cloud-cli absent-ladder), Cursor
  (web-session paste path end-to-end), the local JSONL cost scan over real
  Codex/Claude logs (local; USD 3490.17 window total on this box).
