Linux boots and packages — now it must pass EVERYTHING. Run the entire 24-gate sweep
on ubuntu CI, fix what breaks, and make the smokes platform-honest instead of
cmd.exe-flavored. One gate list, zero feature forks.

## Steps
1. **Shared shell helper** (`src/main/smoke-shell.ts`): the smokes still speak cmd.exe
   in places (`cd /d`, `if not exist … mkdir`, `echo %VAR%`, `&&` chains typed into
   panes). Centralize: `sh.cd(dir)`, `sh.mkdirWrite(dir, file, text)`, `sh.echoVar(name)`,
   `sh.chain(...parts)` — emitting cmd on win32 and POSIX sh elsewhere. Replace the
   inline strings in orchestration-, swarmmilestone-, profiles-, ledger-, gate-, and
   board-smokes. Windows sweep must stay green after the refactor (run it FIRST).
2. **Linux-specific smoke fixes**: expect and fix, at minimum — prompt/PATH assertions
   (bash `$` prompts, `/usr/bin`), `%FAKE_MARK%` → `$FAKE_MARK`, `taskkill` cleanup in
   qa-smokes.sh (use `pkill -f electron` on non-win), daemon endpoint dir on Linux
   (`XDG_RUNTIME_DIR` path — verify `bin/mogging.mjs` discovery matches
   `lifecycle.ts` there), and the notify/mail in-pane `node` invocations (plain `node`
   exists on runners ✓). Anything GPU-flaky under xvfb: prefer
   `--enable-unsafe-swiftshader`-free settings; the perf gates may need a documented
   CI-relaxed mode — see guardrails.
3. **CI**: extend `linux-boot` in `.github/workflows/ci.yml` into `linux-sweep`
   (nightly `schedule:` + manual `workflow_dispatch`; keep the fast boot gate on every
   push). The sweep job: toolchain, `npm ci`, build, `xvfb-run -a bash
   scripts/qa-smokes.sh`, then a step that fails unless the printed SWEEP RESULTS
   contain zero FAIL/MISSING. Upload the `out/*-result.json` files as an artifact on
   failure.
4. **qa-smokes.sh portability**: `timeout` (coreutils ✓), the `//F //IM` taskkill
   quirk, `mktemp` paths, and the endpoint `run/v3` path — make each branch on
   `$OSTYPE`/`uname` so ONE script serves all platforms.
5. **Iterate on CI until green** (use `gh run watch`; artifact JSONs tell you which
   assert broke). Record the per-gate Linux numbers (milestone/perception/swarm
   milestone) in `prompts/phase-5/README.md`.

## Files
- `src/main/smoke-shell.ts` (new) + the six smokes above · `scripts/qa-smokes.sh`
- `.github/workflows/ci.yml` · `prompts/phase-5/README.md` (numbers)

## Definition of Done
- `bash scripts/qa-smokes.sh` → 24/24 PASS on ubuntu CI (nightly + dispatchable),
  AND still 24/24 on Windows locally — same script, same gate list.
- No smoke contains a bare cmd.exe-ism outside `smoke-shell.ts`.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Windows full sweep BEFORE pushing the refactor, Linux sweep in CI after.
- MILESTONE + PERCEPTION numbers recorded for Linux.

## Guardrails
- Do NOT weaken any assertion to pass Linux — platform-CONDITION the probe (what
  command runs), never the CLAIM (what must be true). If a perf budget genuinely
  can't hold under xvfb/software-GL, add an explicit `MOGGING_CI_GPU=soft` mode that
  relaxes ONLY the frame-gap numbers, is used ONLY by the Linux CI job, and prints
  loudly that it ran relaxed — desktop budgets stay untouched.
- Fix product bugs found along the way in the product, not in the smoke.
- One qa script; no `qa-smokes-linux.sh` fork.
