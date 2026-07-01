# 01 — CI + repo hygiene

**Prereq:** `00` done. **Shared context:** see `README.md`.

## Goal
Every push/PR is auto-verified on Windows **and** macOS, and line endings stay stable
across OSes — set up now so later steps land on a green, cross-platform baseline.

## Steps
1. **`.gitattributes`** — normalize text to LF in the repo (Git flagged CRLF on Windows):
   ```
   * text=auto eol=lf
   *.png binary
   *.ico binary
   *.icns binary
   *.woff2 binary
   ```
   Then `git add --renormalize .` and commit.
2. **CI workflow** `.github/workflows/ci.yml`: on push + PR, matrix
   `[windows-latest, macos-latest]` -> `npm ci` -> `npm run typecheck` -> `npm run build`.
   `@lydell/node-pty` is prebuilt, so no VS/Xcode toolchain is needed for typecheck/build.
3. *(Optional)* run the env-gated smokes headlessly where feasible. NOTE: the
   `MOGGING_SMOKE`/`MOGGING_AGENT` smokes currently use cmd.exe syntax — make them
   shell-aware first (see `prompts/phase-0/macos-parity-checklist.md`) before running on
   the macOS runner; `MOGGING_STATE`/`MOGGING_RELOAD` are already cross-platform.
4. *(Optional)* branch protection: require CI green to merge to `main`.

## Files
- `.gitattributes`, `.github/workflows/ci.yml`, `package.json` (scripts if needed)

## Definition of Done
- CI runs on push/PR and is green (typecheck + build) on both Windows and macOS runners.
- `.gitattributes` normalizes LF; a fresh clone shows no spurious CRLF diffs.

## Checks that must be green
- CI workflow passes on Win + Mac runners.
- Locally: `npm ci && npm run typecheck && npm run build` green.

## Guardrails
- Do not require signing certs for typecheck/build (signing is step 07 / release-only).
- No secrets in the workflow except via GitHub Actions secrets.
