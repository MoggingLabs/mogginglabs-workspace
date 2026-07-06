The service direction: a board card linked to a GitHub PR or issue shows
live state — the app holding no credential — and, per the WEBSITE,
"review lands back in the pane that wrote it." The 8/01 service seam gets
its FAKE-first implementation and first real provider, riding the session
the user's own `gh` already owns (0008.d).

## Steps
1. **Backend seam** (`@backend/features/integrations/services/`): adapter
   registry + poller, cloned from the usage discipline — per-link cadence
   (manual · 1m · 5m · 15m, default 5m), jittered, exponential backoff,
   paused while hidden; cache the LAST GOOD `LinkStatus` + `fetchedAt`
   (stale is a state, not an error). IPC: links get/set per card + a
   status snapshot + a push event.
2. **The FAKE adapter first**: deterministic fixtures — checks green,
   checks failing, changes-requested, approved, merged, closed issue,
   stale, error, unconfigured (no `gh`). Smokes + gallery run ONLY this
   adapter; zero network, ever.
3. **GitHub adapter**: `detect()` finds `gh`; token via `gh auth token`
   at request time — in memory for one request, never persisted, logged,
   or displayed. ONE bounded GraphQL call per refresh (PR state +
   reviewDecision + statusCheckRollup — see IMPLEMENTATION), normalized
   to `LinkStatus`. Ladder: no gh → `unconfigured`, logged-out → `error`
   + human reason, 403/429 → `stale` + long backoff. Never a throw into
   the UI.
4. **Review lands back in the pane**: a `reviewDecision` or merged/closed
   TRANSITION on a linked card lands a house notify on the owning pane
   ("PR #123: changes requested") — attention chip, the shipped path —
   and emits the bridge's `review-changed` (a no-op stub if 08 hasn't
   landed). Observed state only; the adapter never mutates GitHub.
5. **Card linking UI** (board): the card ⋯ menu gains "Link GitHub
   PR/issue…" — paste a URL or `owner/repo#123` → `ServiceLink`; the card
   face gets one status chip (state glyph + checks summary, token-
   colored, stale dims) and the detail view full rows + "as of {age}"
   (the ONE relative formatter) + manual refresh. House tokens only.
6. **INTEG smoke** (`MOGGING_INTEG`, env-gated, in qa-smokes.sh): FAKE
   world — link parse (URL + shorthand + rejects), snapshot shape per
   fixture, chip class per state, stale-after-error, the review-
   transition notify landing on the owning pane (fixture flip), poller
   pauses when hidden, unlinking stops the poll. Verdict
   `out/integ-result.json`.

## Files
- `src/backend/features/integrations/services/` (registry, poller, fake +
  github adapters, per-OS `gh` path notes) · `src/ui/features/board/` ·
  notify wiring · `src/contracts/ipc` · integ-smoke.ts · qa-smokes.sh ·
  gallery (chip states, both themes)

## Definition of Done
- A card linked to a real PR shows live state on the dev machine (books:
  the link, the chip, a check flip, a review decision landing a notify on
  the owning pane — the site's sentence demonstrated, dated); logged-out
  `gh` degrades to the labeled state.
- Every adapter state has a FAKE fixture, a gallery state, a smoke assert.
- INTEG gate green; sweep count bumped everywhere stated.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean (adapters backend-
  only; UI sees contracts + IPC exclusively).
- Full local sweep; MILESTONE + PERCEPTION re-run.

## Guardrails
- ADR 0002/0008: token in memory for one request; nothing written to gh's
  store; no OAuth of our own — GitHub-via-gh is the ONLY provider this
  phase (GitLab/Vercel/Supabase/Stripe extend the seam later, FAKE-first,
  research §3 Lane 2).
- Read-only v1: the adapter never mutates the PR — agents create PRs with
  their OWN `gh` in their panes; the app observes and notifies.
- Poll politely: one request per link per tick; a 429 dims to stale,
  never a retry storm.
- Repo names, URLs, PR titles never enter telemetry (ADR 0005) — counts
  and booleans only.
