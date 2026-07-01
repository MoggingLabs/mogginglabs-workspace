# 07 — Packaging: code-signing, notarization, auto-update

**Prereq:** `01`–`06` green. **Shared context:** `README.md` + `electron-builder.yml`.

## Goal
Ship **signed, notarized, auto-updating** installers for `win-x64`, `mac-arm64`, and
`mac-x64` — install-without-warnings, and updates that just work.

## Steps
1. **electron-builder targets** — NSIS (Windows) + DMG (macOS) (already stubbed in
   `electron-builder.yml`); `asarUnpack` native modules (`node-pty`, `better-sqlite3`).
2. **Signing** — Windows **Authenticode**; macOS **notarization** + **hardened runtime**
   (+ entitlements). Certs/secrets come from CI secrets / OS keychain — **never committed**.
3. **Auto-update** — `electron-updater` with a signed release feed (GitHub Releases or a
   bucket); wire an update check + apply flow.
4. **Sourcemaps + crashes** — upload Sentry sourcemaps on build (ties to ADR 0005); confirm
   crash reports de-minify. Enable the real telemetry adapters here (see
   `prompts/observability/`), still opt-in.
5. **Release CI** — extend `01`'s CI with a tag-triggered `release.yml` that builds + signs
   per-OS and publishes artifacts.

## Files
- `electron-builder.yml`, `.github/workflows/release.yml`, `package.json` (`dist` scripts),
  signing/entitlements config (values via CI secrets, not in the repo).

## Definition of Done
- `npm run dist` produces installers; signed + notarized (no install warnings) on Win + Mac.
- Auto-update installs a newer signed build.
- Sentry sourcemaps uploaded; crash reports readable.

## Checks that must be green
- `electron-vite build && electron-builder` succeeds; artifacts verify as signed.
- Release CI builds + signs green per-OS.

## Guardrails
- Signing certs / notarization creds ONLY in CI secrets / OS keychain — never committed.
- Do not disable notarization/signing for a real release. Telemetry stays opt-in (ADR 0005).

## Gate -> Phase 2
Signed MVP shipping on Win + Mac -> Phase 2 (command blocks + OSC hardening) and Phase 2.5
(local **memory graph** — the chosen differentiator). See `docs/02-mvp-and-roadmap.md`.
