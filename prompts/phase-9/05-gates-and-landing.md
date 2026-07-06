Where the work lands is where trust is won or lost. Give every loop Seer-style
STOP-POINTS, make the default stop exactly the Phase-3 human review, deputize
the Phase-4 reviewer gate for supervised autonomy, and keep autoland a typed,
stacked opt-in — never a mood.

## Steps
1. **Stop-points** (per-loop, from the 01 contract): after a green verify the
   run proceeds only as far as the spec allows:
   - `plan` — plan-only mission (plan written to the card, no code
     expected); run ends `awaiting-review`.
   - `review` (DEFAULT) — branch + diff wait in the existing Review modal
     (redacted diff, typed `merge`); the loop card shows "needs you".
   - `pr` — the runner asks the AGENT (next iteration prompt) to open the PR
     with its own `gh`/`glab` auth and captures the URL as a receipt; the app
     never holds forge credentials (ADR 0002). No remote/no `gh` → stated
     fallback to `review`.
   - `autoland` — stacked requirements, ALL of: verify green AND Phase-4
     reviewer sign-off (`mogging approve` from a reviewer-role pane — a
     reviewer mission mails it the diff summary; Phase-4 flow unchanged) AND the spec was saved with the word `autoland` typed
     verbatim (the Phase-3 typed-confirm pattern, moved to spec-save time).
     Then the existing guarded merge runs: `--no-ff`, clean-repo gated,
     conflicts → paused for a human terminal, never auto-resolved.
2. **Review provenance**: loop-born branches appear in the Review modal with
   a provenance strip: loop name, run #, iteration #, origin (schedule/card/
   sentry permalink), verify receipt tail — the reviewer sees WHY this diff
   exists before what it is.
3. **Notifications**: every terminal state routes through house notify:
   `awaiting-review` ("loop X has a green diff"),
   `paused-failing`/`paused-budget`/`paused-quota` (with the receipt line),
   `landed` (branch, sha). Rail + taskbar badge exactly like needs-input.
4. **Post-land hygiene**: after any land, the worktree is removed, the branch
   is kept (history is receipts), approvals clear (Phase-4 semantics), and
   the bound card moves to Done. A `pr` run ends when the human marks the
   card Done — the app does not poll the forge (Phase-8's GitHub adapter may
   upgrade this later).
5. **LOOPGATE smoke** (`MOGGING_LOOPGATE`, env-gated, isolated temp repo,
   shell provider): default `review` → green diff sits unmerged, provenance
   strip data present, typed `merge` lands it; `autoland` without reviewer
   sign-off → refused (`ungated`), with sign-off → lands `--no-ff`, HEAD
   advances exactly one merge commit; conflict fixture → paused, repo
   untouched; `pr` with no remote → fallback to `review` with stated reason.
   Verdict via `out/loopgate-result.json`.

## Files
- `src/backend/features/loops/landing.ts` · Review modal provenance strip
  (`src/ui/features/review/`) · notify wiring · `src/main/loopgate-smoke.ts` ·
  `scripts/qa-smokes.sh` (new gate row)

## Definition of Done
- LOOPGATE green in the sweep on fresh isolated state.
- Loop law 3 is machine-checked: no code path reaches `landing` without
  verify-green AND a sign-off recorded in the ledger.
- A reviewer can answer "why does this diff exist" from the modal alone.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep including the new gate; PERCEPTION budget re-run (modal
  changed).

## Guardrails
- The merge verb stays the ONLY mutating verb; loops add zero new git
  mutations. Conflicts are ALWAYS a human's — no auto-resolution, ever.
- Autoland is per-loop, revocable, and logged on every use; there is no
  global "autoland everything" switch, deliberately.
- Secrets redaction runs on loop diffs unchanged — provenance strips carry
  ids and receipts, never diff content, into cards/notify.
- The app never authenticates to a forge; `pr` mode is the agent's own auth
  or a stated fallback (ADR 0002).
