macOS compiles in CI but has NEVER run a gate. Close the third platform: the full
sweep on macos CI, the signing/notarization path verified as far as it can be without
paid certs, and install manifests (winget + homebrew cask) so distribution is a PR
away on both ecosystems.

## Steps
1. **macOS sweep job** (`.github/workflows/ci.yml`): `macos-sweep`, nightly +
   `workflow_dispatch` (mirror 01's linux-sweep). Full native `npm ci` (Xcode CLT is
   preinstalled), build, `bash scripts/qa-smokes.sh`. Expect and fix: the default
   shell is zsh (`-l` args + prompt assertions via 01's `smoke-shell.ts` — extend it,
   don't fork), `pkill` cleanup, endpoint discovery under
   `~/Library/Application Support` (verify `bin/mogging.mjs` matches `lifecycle.ts`),
   PATH probe (`/usr/bin`), and pty behavior diffs (forkpty vs ConPTY: resize/reflow
   assertions should hold — investigate, don't relax, if not).
2. **Signing/notarization dry run**: the release workflow already reads `CSC_LINK`/
   `APPLE_*` secrets. Add a `signing-dryrun` job (dispatch-only): packages mac + win
   UNSIGNED, then runs a verifier step that reports what WOULD block a signed release
   (entitlements file present, hardenedRuntime config, identity lookup) — so the day
   certs arrive is a secrets-only change. Document the exact cert shopping list in
   `docs/10-distribution.md` (OV/EV Authenticode tradeoffs vs SmartScreen; Apple
   Developer ID + notarytool).
3. **Manifests**: `packaging/winget/` — a winget manifest set (version-templated,
   pointing at the GitHub release NSIS exe + its sha256); `packaging/homebrew/` — a
   cask formula (dmg). A small `scripts/update-manifests.mjs` fills version + hashes
   from `dist/` after a release build. Neither is submitted yet — they must VALIDATE
   (`winget validate`, `brew style`) in CI where the tooling exists.
4. **Docs**: `docs/10-distribution.md` — platforms matrix (what's built, signed,
   swept, distributed where), the manifest submission playbook, and the SmartScreen/
   Gatekeeper story users see today.

## Files
- `.github/workflows/ci.yml` (+ dry-run job) · `scripts/qa-smokes.sh` +
  `src/main/smoke-shell.ts` (zsh awareness) · `packaging/winget/` ·
  `packaging/homebrew/` · `scripts/update-manifests.mjs` · `docs/10-distribution.md`

## Definition of Done
- 24/24 PASS on macos CI (nightly + dispatchable) — same script, same gate list as
  Windows and Linux.
- `signing-dryrun` reports READY (config-complete, secrets-pending) for both OSes.
- Both manifests validate in CI and regenerate from a release build with one command.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Windows + Linux sweeps still green after any smoke-shell change.
- MILESTONE + PERCEPTION numbers recorded for macOS in the pack README.

## Guardrails
- Same as 01: platform-condition the PROBE, never the CLAIM; no forked qa script;
  product bugs get fixed in the product.
- No certificates, tokens, or Apple credentials in the repo — the dry run must prove
  readiness WITHOUT them (ADR 0002 discipline applies to our own secrets too).
- Manifests point ONLY at official GitHub release artifacts with pinned hashes.
