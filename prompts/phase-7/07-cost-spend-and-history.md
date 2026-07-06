Beyond "how much is left" — "what did it cost, and what's the trend?"
CodexBar scans local Codex/Claude logs for spend and draws usage-history
charts. Ours does the same on the seam: a local cost scan (no network) and a
history ring that turns the poller's own samples into sparklines. Research:
`docs/research/2026-07-codexbar-parity.md`.

## Steps
1. **Local cost scan** (`@backend/features/usage/cost.ts`): parse the local
   JSONL session logs Codex and Claude already write (per-OS log dir path
   table; known location only, ADR 0007). Sum token/cost per day over a
   bounded window; pure parse, ZERO network. Returns `CostScan { providerId,
   days: { date, spend, tokens }[], currency }`. A missing/again-absent log
   dir → empty scan with a reason, never a throw.
2. **Contracts** (`@contracts/usage`): `CostScan` + a `spend?` field on
   `PlanUsage` (current-window spend where the provider exposes it — the
   api-key spend rows from 05). Closed shapes, versioned.
3. **History ring** (`@backend/features/usage/history.ts`): the poller
   appends each good `usedPct` sample per (provider, window) to a bounded
   ring persisted in the settings KV (last N points; counts, not content —
   ADR 0005 safe). This is OUR data, not a provider call — every provider
   gets a sparkline for free, no per-provider endpoint.
4. **IPC + wiring**: `usage:cost` (providerId → CostScan, on demand) +
   `usage:history` (providerId, window → number[]). Cost scan runs on
   request (it reads disk), not on the poll cadence. Both behind the same
   FAKE-under-smoke rule as the poller.
5. **USAGE/COST smoke growth** (`MOGGING_USAGE` grows; no new gate):
   FAKE log fixtures (a seeded JSONL dir) → cost scan sums the known total;
   the history ring accumulates across simulated polls and truncates at N;
   empty log dir → labeled empty scan. Zero network; assertions in the
   existing verdict JSON.

## Files
- `src/backend/features/usage/cost.ts`, `history.ts` + log-dir path table ·
  `src/contracts/usage/` (CostScan, spend) · `src/contracts/ipc` (usage
  channels grow) · `src/main/usage.ts` (wire) · `src/main/usage-smoke.ts` ·
  books (log formats + dates)

## Definition of Done
- A dev machine with real Codex/Claude logs shows a plausible per-day spend
  scan (manual check, books); the history ring produces a sparkline series
  from the poller's own samples for ANY provider.
- Cost scan is pure/offline; the smoke sums a seeded fixture exactly.
- USAGE gate green (grown); sweep count unchanged.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; the cost/history assertions inside USAGE.

## Guardrails
- Cost scan reads KNOWN log locations only, on demand, read-only — no
  crawl, no watch, no network (ADR 0007).
- History is OUR sampled percentages (counts) — never raw provider content;
  the ring is bounded and lives in the KV like other app state.
- No spend figure, token count, or log path in telemetry (ADR 0005).
- Charts are sparklines/rings, not a dashboard — depth stays the popover's
  glance discipline (03); the Usage tab (10) hosts the fuller history view.
