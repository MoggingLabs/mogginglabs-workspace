The outbound direction: a board card linked to a GitHub PR or issue shows
live state — without the app holding a single credential. The service-adapter
seam from 8/01 gets its FAKE-first implementation and its first real
provider, riding the session the user's own `gh` CLI already owns (the
ADR 0007 pointer philosophy, restated for services in ADR 0008).

## Steps
1. **Backend seam** (`@backend/features/integrations/services/`): adapter
   registry + poller, cloned from the usage discipline — per-link cadence
   (manual · 1m · 5m · 15m, default 5m), jittered, exponential backoff on
   error, paused while the window is hidden; cache the LAST GOOD
   `LinkStatus` with `fetchedAt` (stale is a state, not an error). IPC:
   `integrations:links:get/set` per card + `integrations:status` snapshot +
   a push event on change.
2. **The FAKE adapter first**: deterministic fixtures — open PR checks
   green, checks failing, changes-requested, merged, closed issue, stale,
   error, unconfigured (no `gh`). Smokes and gallery run ONLY this adapter;
   zero network in smokes, ever.
3. **GitHub adapter**: `detect()` finds the `gh` binary; token via
   `gh auth token` at request time — in memory for the one request, never
   persisted, logged, or displayed. Fetch PR/issue state + check rollup +
   review state (REST or `gh api`, one bounded call per refresh; send
   ETag/If-None-Match so unchanged polls cost a 304, not quota), normalize
   to `LinkStatus`. Degradation ladder: no gh → `unconfigured`, logged-out/
   expired → `error` with a human reason, rate-limited (403/429) →
   `stale` + long backoff. Never a throw into the UI.
4. **Card linking UI** (board): a card's ⋯ menu gains "Link GitHub PR/
   issue…" — paste a URL or `owner/repo#123`, parsed to a `ServiceLink`;
   the card face gets one status chip (state glyph + checks summary,
   verdict-colored by token, stale dims it) and the card's detail view the
   full rows + "as of {age}" + manual refresh. House tokens; no new colors.
5. **INTEG smoke** (`MOGGING_INTEG`, env-gated, in qa-smokes.sh): FAKE
   adapter world — assert link parse (URL + shorthand + rejects), snapshot
   shape per fixture, chip class per state, stale-after-error transition,
   poller pauses when hidden, and that unlinking stops the poll. Verdict
   via `out/integ-result.json`.

## Files
- `src/backend/features/integrations/services/` (registry, poller, fake +
  github adapters, per-OS `gh` path notes) · `src/ui/features/board/`
  (link menu, chip, detail rows) · `src/contracts/ipc` additions ·
  `src/main/integ-smoke.ts` · `scripts/qa-smokes.sh` (gate row) ·
  `src/main/gallery.ts` (chip states, both themes)

## Definition of Done
- A card linked to a real PR shows live state on the dev machine (books:
  the link, the chip, a check flip observed); logged-out `gh` degrades to
  the labeled state, not an error dialog.
- Every adapter state has a FAKE fixture, a gallery state, and a smoke
  assertion.
- INTEG gate green; sweep count bumped everywhere the books mention it.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean (adapters are
  backend-only; UI sees contracts + IPC exclusively).
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- ADR 0002/0008: token in memory for one request; nothing written to gh's
  store; no OAuth flow of our own — GitHub-via-gh is the ONLY provider in
  this phase (Slack/Linear each want app-held OAuth → their own ADR later).
- Read-only v1: the adapter never mutates the PR (no comments, no merges) —
  outbound writes are a different trust conversation.
- Poll politely: one request per link per tick, ETags, backoff; a 429 dims
  to stale, never a retry storm.
- Repo names, URLs, and PR titles never enter telemetry (ADR 0005) —
  counts and booleans only.
