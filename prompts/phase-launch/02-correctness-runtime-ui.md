The first correctness sweep: the runtime and UI core — the surfaces a
user touches every second. Grade each INVENTORY row on the six lenses,
enumerate its edge cases, PROVE each one (a regression assertion, not a
claim), and route every finding. EVERY finding is fixed here — severity
orders the queue, it never excuses a drop.

## Scope (INVENTORY rows for this step)
Terminal/xterm rendering, the PTY seam + daemon lifecycle
(spawn/reconnect/quit/relaunch, the KILLFLASH windowless path), the
scroll anchor (`terminal/pane-anchor.ts`), panes/layout/seams/equalize,
workspace tabs + persistence/restore, the titlebar/rail/pane chrome,
tooltips (native-title suppression if built), the updater lifecycle UX
(`src/main/updater.ts` + the rail row), first-run/wizard, Settings shell,
themes/tokens.

## Steps
1. **Enumerate edge cases per row** in INVENTORY: for each, list the
   inputs that break naive code — 0 panes and the cap (16), a pane closed
   mid-write, daemon down at reconnect, a 5MB paste, a resize storm, an
   OSC flood, a workspace restore with a missing cwd, an update arriving
   during a swarm, F11 at a race, motion-calm on. Empty/huge/concurrent/
   malformed/cancel is the checklist.
2. **Verify against the real code** (`file:line`), not memory: trace the
   path, confirm the behavior, and where the guarantee isn't already
   asserted, ADD the assertion to the owning smoke (PANESCROLL, KILLFLASH,
   EQUALIZE, LAYOUT, FIRSTRUN, the pane/daemon gates) or a focused unit.
   No new gate unless a whole class is uncovered — extend, don't multiply.
3. **Route findings** to FINDINGS.md with severity. **S1** (data loss,
   crash, hang, wrong persisted state), **S2** (visible wrong behavior,
   silent degradation) and **S3** (nits) are ALL fixed here, minimally and
   in the surrounding idiom. The only other exit is `invalid` — the
   claimed behavior does not reproduce, disproven.
4. **Grades derive** from FINDINGS (01 §3): a row's lens reaches **A**
   when it carries no unresolved finding. Don't type letters; resolve rows
   until LAUNCHAUDIT computes A.
5. **Re-measure** MILESTONE + PERCEPTION after any renderer-touching fix;
   a budget move is a stop-ship (revert or fix the cost, never footnote).

## Files
- `prompts/phase-launch/INVENTORY.md` (grades) · `FINDINGS.md` (routing) ·
  the specific smokes/units extended · the product files fixed ·
  `CHECKLIST.md` (mark 02 areas)

## Definition of Done
- Every scoped row derives **A** on every lens; every finding (S1–S3)
  fixed with a regression assertion that FAILS on the pre-fix bytes
  (bite-prove it) and passes after, or `invalid` with the disproof.
- No edge case listed without a verdict; FINDINGS has no `open` row for
  this scope.
- The gates touched stay green; MILESTONE + PERCEPTION unmoved.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static battery; LAUNCHAUDIT; every
  smoke this step extended, in isolation; MILESTONE + PERCEPTION if the
  renderer moved.

## Guardrails
- A fix that can't be regression-proven isn't done — find the assertion or
  don't claim it.
- Fix in the local idiom; a correctness fix is never a refactor (05 owns
  refactors) — keep the diff about behavior.
- Zero network; daemon protocol number unchanged.
