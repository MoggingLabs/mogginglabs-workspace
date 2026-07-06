The flagship watcher: production errors become missions. A BYOK Sentry
adapter on the Phase-8 service-adapter seam turns qualifying issues into
deduped queue cards — Seer's trigger discipline, our auth stance: the user's
own token, in memory, for one request, never persisted.

## Steps
1. **Adapter on the Phase-8 seam** (`@backend/features/integrations/sentry/`):
   a read-only service adapter (list unresolved issues for a project; fetch
   issue detail: title, culprit, count, first/lastSeen, permalink, top
   frames). Auth: a user-supplied Sentry auth token via
   the profile-style POINTER pattern (env name or documented per-OS path —
   ADR 0007 verbatim: read at request time, in-memory for the one request,
   never persisted, logged, copied, or displayed; values that look like
   secrets are refused at save by the existing redactor patterns). Org/project
   slugs + base URL (self-hosted Sentry supported) live in the spec.
2. **Qualification filter** (Seer's auto-trigger conditions, tuned per loop):
   an issue becomes a mission only if: unresolved AND `events >= N`
   (default 10) AND `lastSeen` within the recency window (default 14 days)
   AND not already missioned (dedupe by issue id across the loop's whole
   ledger — a red run does NOT re-qualify the same issue; a human "retry"
   does).
3. **Mission synthesis**: card title = `[sentry] <issue title>`; body =
   culprit, count, permalink, top frames, and the fix contract ("reproduce if
   possible, fix root cause, add a regression test — one issue, one branch").
   The card lands in the loop's queue column (03) like any queued mission —
   from here the machinery is IDENTICAL to every other loop.
4. **Polite polling**: cadence presets (manual · 5m · 15m · 1h), jittered,
   exponential backoff on errors, paused while the app is hidden, dimmed
   `stale` on the loop card when the last poll failed (the Phase-7 poller's
   exact manners; share code where the seam allows).
5. **FAKE Sentry adapter first**: fixture files covering: fresh qualifying
   issue, sub-threshold issue, old issue, already-missioned issue, API error,
   token-missing (`unconfigured`, human reason, no throw). Smokes and the
   gallery run ONLY this adapter — zero network in smokes, ever.
6. **LOOPWATCH smoke** (`MOGGING_LOOPWATCH`, env-gated): fixture set drives:
   exactly one card created for the qualifying issue (sub-threshold/old/dupe
   produce zero); the card carries the permalink; a second poll with the same
   fixtures creates nothing; error fixture → backoff + stale, no card; token
   never appears in the result JSON, logs, or telemetry (grep-asserted, the
   planted-secret WORKTREE pattern). Verdict via
   `out/loopwatch-result.json`.

## Files
- `src/backend/features/integrations/sentry/` (adapter + fake + fixtures) ·
  `src/backend/features/loops/triggers/watcher-sentry.ts` ·
  `src/main/loopwatch-smoke.ts` · `scripts/qa-smokes.sh` (new gate row)

## Definition of Done
- LOOPWATCH green in the sweep; sweep count grows by one everywhere.
- Dev-machine manual check against a real Sentry project: qualifying issue →
  card with working permalink; revoking the token → `unconfigured`, stated
  reason, zero retries-per-second.
- Grep-clean: no token value anywhere; issue titles/stacks in the app db
  only (ADR 0005).

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean (vendor API calls
  confined to the adapter; loops code sees the seam only).
- Full local sweep including the new gate.

## Guardrails
- Read-only: never writes to Sentry (no resolve, no comment) — closing the
  loop back to Sentry is a later, deliberate step.
- The watcher NEVER launches an iteration directly — it only enqueues cards;
  budgets and one-live-run-per-loop (03) stand between an error spike and a
  pane storm.
- Issue content is user content: local db only, never telemetry/notify/logs.
- No OAuth, no stored secrets, no filesystem crawling for tokens.
