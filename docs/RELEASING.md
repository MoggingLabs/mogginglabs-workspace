# Releasing (packaging, signing, notarization, auto-update)

Phase-1/07. Signed, notarized, auto-updating installers for `win-x64`, `mac-arm64`, `mac-x64`.

## Cut a release
1. Bump `version` in `package.json`.
2. Tag + push: `git tag v1.2.3 && git push origin v1.2.3`.
3. `.github/workflows/release.yml` fires: it first ensures the GitHub Release exists (creating a
   **draft** if you didn't hand-create one — `gh release upload` needs a release to exist, and
   electron-builder never creates it), then per-OS it rebuilds native modules from source, packages
   (NSIS on Windows, DMG + zip on macOS), **signs + notarizes**, uploads to the release, and
   uploads sourcemaps to Sentry. If it drafted the release: curate the body (house format — bold
   thesis line, `## Highlights`, `## Install`, docs line) and **publish** it; electron-updater
   only sees published releases.
4. Refresh the install manifests from the published artifacts (winget + homebrew cask —
   see `docs/10-distribution.md`):
   `gh release download vX.Y.Z -D /tmp/rel && node scripts/update-manifests.mjs /tmp/rel`

## Local (unsigned) build
`npm run dist:win` / `npm run dist:mac` → installers in `dist/`, **unsigned** (no cert in the
env). Use this to verify packaging only; a real release must be signed (CI).

## Required CI secrets (never committed — ADR guardrail)
| Secret | Purpose |
|---|---|
| `CSC_LINK` | base64 of the signing cert — `.pfx` (Windows Authenticode) / `.p12` (macOS Developer ID) |
| `CSC_KEY_PASSWORD` | password for that cert |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization (notarytool) |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | sourcemap upload (optional; step skips if absent) |
| `SENTRY_DSN` | (build/run env) enables the opt-in crash reporter |

`GITHUB_TOKEN` is provided by Actions (publishes the Release). Encode a cert:
`base64 -w0 cert.pfx` (Linux) / `base64 -i cert.p12` (macOS) → paste into the secret.

## Auto-update
`electron-updater` checks the GitHub Releases feed (`electron-builder.yml` `publish`) on launch
(packaged builds only — see `src/main/updater.ts`), downloads a newer **signed** build in the
background, and installs it on quit. It verifies the update signature, so an unsigned/tampered
build is rejected.

## Telemetry (opt-in — ADR 0005)
Sourcemaps are emitted (`electron.vite.config.ts`) and uploaded on release. The real Sentry
adapter (`src/main/sentry-telemetry.ts`) activates only when the user has consented **and**
`SENTRY_DSN` is present — default is the no-op adapter. A `beforeSend` scrubber is the backstop:
telemetry never receives terminal output, paths, env, or credentials (ADR 0005 / ADR 0002).
