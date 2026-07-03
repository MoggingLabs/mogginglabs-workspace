Windows regression coverage must stop depending on the dev machine being the lab.
Stand up a `windows-sweep` CI job running the ENTIRE 24-gate sweep on
windows-latest — same script, same gate list, same soft-GPU honesty as Linux (01)
and macOS (02). Zero forks.

## Steps
1. **Runner reality check first**: windows-latest has no GPU — the perf gates run
   under the SAME `MOGGING_CI_GPU=soft` mode Linux uses (frame-timing budgets only,
   loud). Dispatch a `gates`-filtered probe run (MILESTONE,PERCEPTION,FLICKER) before
   building the full job; record which budgets the runner's software GL needs and
   whether the existing factors hold — do NOT invent new relaxations without measured
   evidence from the probe.
2. **Native install path on the runner**: `npm ci` + the Electron-ABI rebuild. The
   @electron/rebuild spawn hang (01) was bisected on ubuntu — VERIFY whether the
   standard postinstall works on windows-latest before reusing the direct node-gyp
   bypass; whichever path is used, cache `node_modules` keyed on
   `runner.os + package-lock + electron version` (the 01 pattern) so iteration
   rounds skip the compile.
3. **The job** (`.github/workflows/ci.yml`): `windows-sweep`, nightly `schedule:` +
   `workflow_dispatch` honoring the existing `gates` input; steps: cache → install →
   rebuild → build → `bash scripts/qa-smokes.sh` (Git Bash is native on the runner —
   the `uname` branches from 01 must Just Work; fix qa-smokes.sh portability gaps in
   place if not, never fork). Then the results gate (zero FAIL/MISSING in SWEEP
   RESULTS) and the always-uploaded `out/*-result.json` + sweep.log artifact, named
   `sweep-results-windows` so parallel OS artifacts never collide.
4. **Schedule hygiene**: stagger the nightly crons (linux 03:30 stays; windows e.g.
   04:30) and keep each sweep job `if:`-gated to schedule/dispatch so pushes still
   run only the fast verify+boot gates. Confirm the concurrency group does not let
   one OS's sweep cancel another's (split groups per job if needed).
5. **Iterate until green** with `gates`-filtered dispatch runs (~10 min each);
   certify with ONE full uncut 24-gate run. Record the windows-runner
   MILESTONE/PERCEPTION/SWARMMILESTONE numbers next to the Linux ones in
   `prompts/phase-6/README.md`, marked as soft-GPU numbers.

## Files
- `.github/workflows/ci.yml` (windows-sweep job) · `scripts/qa-smokes.sh` (only if
  a portability gap surfaces) · `prompts/phase-6/README.md` (numbers)

## Definition of Done
- `bash scripts/qa-smokes.sh` → 24/24 PASS on windows-latest CI (nightly +
  dispatchable), certified by one full uncut run — same script, same gate list as
  local Windows and ubuntu CI.
- Local Windows sweep behavior unchanged (no new env required locally).

## Checks that must be green
- The full certification run's SWEEP RESULTS: zero FAIL/MISSING.
- linux-sweep still green after the workflow changes (one dispatch to prove it).
- Numbers recorded in the pack README, labeled per-OS and soft-GPU where relaxed.

## Guardrails
- Do NOT weaken any assertion — platform-CONDITION probes, never claims. Soft mode
  relaxes ONLY frame-timing numbers, only under `MOGGING_CI_GPU=soft`, always loudly;
  desktop budgets stay byte-identical.
- One qa script; no `qa-smokes-windows.sh` fork; no gate-list drift between OSes.
- Fix product bugs found along the way in the product, not in the smoke.
- Runner minutes are 2x on Windows: iteration via the `gates` filter, certification
  exactly once per green candidate.
