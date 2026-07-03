Freeze the usage pack the house way: every new gate green on every platform's
CI sweep, the docs telling the whole story, and the books carrying the
numbers. Usage is DONE when a fresh machine on any OS shows a stranger their
burn rate without a single login.

## Steps
1. **Sweep integration audit**: the new gates (USAGE, USAGEUI) run in
   `scripts/qa-smokes.sh` with proper isolation; every mention of the gate
   COUNT in books/docs/CI comments is updated (the "24" era ends here — count
   from the script, don't hand-wave). Both gates run on the FAKE adapter —
   confirm zero network syscalls under the smoke env (the poller must not
   touch real adapters when `MOGGING_USAGE*` is set).
2. **Three-platform certification**: one dispatch, all three sweeps
   (`sweeps=linux,macos,windows`, full uncut). Fix what breaks where it
   breaks — adapter path tables are the likely suspects (8.3 aliases, XDG
   variance; the 6/03 canonical-path lesson applies). Iterate with the
   `gates` filter; certify with one full run per OS.
3. **`docs/12-usage.md` complete**: what the meter shows and how to read the
   verdicts (the three strings, verbatim), the ADR 0007 privacy story in
   user words ("your sessions, read in place — nothing stored, nothing sent"),
   per-provider notes (which windows each plan type exposes), the settings
   reference (cadence/thresholds/baseline), and the adapter authoring guide
   (04's seed, finished).
4. **Gallery + design-system books**: usage surfaces join the audit ledger in
   `docs/11-design-system.md` (icon states, popover anatomy, severity inks);
   `docs/assets/gallery/after/` refreshed with the usage states.
5. **Pack freeze**: `prompts/phase-7/README.md` sequence rows → DONE with
   commit ranges + certification run IDs; per-OS MILESTONE/PERCEPTION numbers
   re-recorded if any renderer cost moved; REPORT.md if the campaign surfaced
   environmental finds worth remembering (the 6/0x pattern).

## Files
- `scripts/qa-smokes.sh` · `.github/workflows/ci.yml` (only if a gate needs
  runner accommodation — platform-condition probes, never claims) ·
  `docs/12-usage.md` · `docs/11-design-system.md` ·
  `prompts/phase-7/README.md` (+ REPORT.md if earned)

## Definition of Done
- Full uncut sweep — WITH usage gates — green on windows-latest, macos, and
  ubuntu CI, plus the local Windows sweep: same script, same gate list, four
  environments.
- docs/12-usage.md answers every question a new user or adapter author would
  ask; the privacy story is front and center.
- The pack README carries DONE rows, run IDs, and numbers.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- All three CI sweep jobs green on the certification dispatch; nightly crons
  left enabled and passing the following night.
- No telemetry regression: the ADR 0005 grep gate stays clean.

## Guardrails
- Certification is the full uncut sweep — the gates filter is for iteration
  only.
- Do NOT weaken any assertion to pass a runner — platform-condition the
  probe, never the claim; soft mode stays frame-timing-only and loud.
- Fix product bugs found along the way in the product, not in the smoke.
- The freeze commit updates books and code together — no "docs to follow".
