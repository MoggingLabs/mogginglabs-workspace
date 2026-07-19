Clean code can still be wasteful. This step hunts inefficiency and
re-establishes the perf floor on the MERGED product (core + accounts +
Brain, sixteen panes). The budgets are the veto: a feature that's correct
and clean but costs frame time is not done.

## Steps
1. **Poller + timer census**: enumerate every `setInterval`/`setTimeout`/
   `fs.watch`/tick in the app + daemon (the 2.5s git porcelain tick, the
   6-hour entitlement/updater cadences, the Brain freshness tick, the
   explorer watchers, any Brain/scroll rAF). Confirm each is (a)
   necessary, (b) coalesced, (c) **zero-cost when its surface is hidden or
   idle** (the phase-11 law: a collapsed dir, a hidden window, a closed
   panel each cost nothing). Any redundant or always-on poller is a
   finding — merge onto an existing tick or gate it behind visibility.
2. **Algorithmic + allocation hunt**: N² over panes/nodes/rows, work
   repeated per-frame that could be memoized, per-keystroke re-layout,
   needless renderer re-renders, string/Buffer churn in the PTY→xterm
   path, unbounded caches (confirm the LRU caps: Brain dbs=4, watchers=64).
   Route each to FINDINGS with a measurement, not a hunch.
3. **Re-measure both budgets** on the composed surface — MILESTONE
   (fps/worst-gap/heap under 16 live panes) and PERCEPTION — WITH the
   Brain indexing and the account/entitlement machinery live. Capture the
   numbers into the pack README's table. A forced Brain full re-index
   under 16 panes must hold the gap ceiling (worker isolation).
4. **Fix S1/S2 inefficiencies** (a per-frame regression, an always-on
   poller, an unbounded cache) in the local idiom; **defer** S3 with the
   measured cost noted. No new gate unless a whole budget class is
   uncovered — MILESTONE + PERCEPTION are the instruments.

## Files
- The poller/hot-path product files fixed · `FINDINGS.md` (with
  measurements) · `INVENTORY.md` (efficiency grades) · pack README (the
  measured numbers table) · `CHECKLIST.md` (mark 06)

## Definition of Done
- Every poller/timer accounted for and proven zero-cost when idle/hidden;
  no always-on waste survives.
- Both budgets GREEN on the merged surface with Brain + accounts live, the
  numbers recorded (fps avg, worst gap, heap, index time, freshness
  latency); a forced re-index under load holds the ceiling.
- Every efficiency finding has a verdict backed by a measurement.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static battery; LAUNCHAUDIT; MAINT;
  MILESTONE + PERCEPTION on the composed surface; any smoke touching a
  changed hot path.

## Guardrails
- Measure, don't guess — a "perf fix" without a before/after number is a
  finding, not a fix.
- A budget regression is a stop-ship; never widen a budget to pass —
  docs/05 unchanged is the freeze criterion.
- Correctness and structure are frozen here — this step only changes cost,
  never behavior or shape.
