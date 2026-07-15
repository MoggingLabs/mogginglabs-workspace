# Distribution — platforms, signing, install channels

Phase-6/02. What ships on each platform, what stands between today's unsigned
builds and store-grade installs, and the exact playbook for both package
ecosystems. Companion to `docs/RELEASING.md` (the mechanics of cutting a release).

## Platform matrix

| | Windows | macOS | Linux |
|---|---|---|---|
| **Built in CI** | NSIS x64 + blockmap | dmg + zip, arm64 (x64 deferred†) | AppImage + deb, x64 |
| **Swept (128 gates)** | local (windows-sweep CI = Phase-6/03) | `macos-sweep` nightly + dispatch | `linux-sweep` nightly + dispatch |
| **Signed today** | no — config READY, cert pending | no — config READY (hardened runtime + entitlements + notarize wired), cert pending | n/a (GPG sums optional, later) |
| **Auto-update** | GitHub releases feed (electron-updater) | feed wired, **inert until signed** — Squirrel.Mac refuses unsigned updates | AppImage via feed; deb manual |
| **Install channels** | GitHub release · winget (manifest in `packaging/winget/`, not yet submitted) | GitHub release · homebrew cask (`packaging/homebrew/`, not yet submitted) | GitHub release |

The signing **readiness** claim is not aspirational: the dispatchable
`signing-dryrun` job in `.github/workflows/ci.yml` packages win+mac unsigned and
runs `scripts/verify-signing-readiness.mjs`, which fails on any config gap and
prints `SIGNING DRYRUN: READY (config-complete, secrets-pending: …)` when a
signed release is a secrets-only change. No certificate, token, or Apple
credential ever lives in this repo (ADR 0002 applies to our own secrets too).

## Certificate shopping list

### Windows (Authenticode)

| Option | Cost | CI fit | SmartScreen |
|---|---|---|---|
| **Azure Trusted Signing** | ~$10/mo | best — cloud signing, no hardware | reputation accrues to the durable identity; consistently good reports |
| OV certificate | ~$200–400/yr | poor since 2023 — private key must live on a hardware token/HSM | reputation builds slowly with install volume |
| EV certificate | ~$300–500/yr | same HSM problem | immediate reputation |

Our pipeline is wired for the classic `CSC_LINK` (base64 `.pfx`) +
`CSC_KEY_PASSWORD` pair. Azure Trusted Signing would instead use
electron-builder's `win.azureSignOptions` — a small, documented config change,
not a rework.

### macOS (Developer ID + notarization)

One purchase: **Apple Developer Program, $99/yr.** From it:
1. A **Developer ID Application** certificate, exported as `.p12` →
   `CSC_LINK` / `CSC_KEY_PASSWORD` secrets.
2. Notarization credentials for notarytool: `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD` (generated at appleid.apple.com), `APPLE_TEAM_ID`.

Already committed and dry-run-verified: hardened runtime, the entitlements set
Electron + our from-source native modules need (`allow-jit`,
`disable-library-validation`, `allow-dyld-environment-variables` for the
Electron-as-Node daemon), `notarize: true`, and the workflow plumbing for all
five secrets. Signing also unlocks macOS **auto-update**, which Squirrel.Mac
gates on a valid signature.

### The flip, exactly

Add the secrets in repo settings → rerun `Release`. The
`Stage signing env` step exports only non-empty secrets (an empty-string
`CSC_LINK` breaks electron-builder), signing and notarization activate on their
own. Verify beforehand any time with the `signing-dryrun` dispatch.

† **Intel (x64) macOS is still deferred as of v0.12.0.** The 2026-07 macos runner image
regressed into the same `@electron/rebuild` spawn hang the ubuntu/windows
images have (59 min of silence on `preparing better-sqlite3` — run
28756024650), so the mac release uses the direct node-gyp bypass, which builds
only the runner-native arch (arm64). Apple Silicon is the overwhelming majority
of Macs; Intel support returns when the image hang is fixed upstream or a
dedicated x64 runner is added. Dev machines and `npm run dist:mac` still build
dual-arch where the toolchain works.

## What unsigned users see today (the honest story)

- **Windows**: browser + SmartScreen show "Windows protected your PC" → More
  info → Run anyway. Reputation may eventually quiet this even unsigned, but
  only signing makes it deterministic.
- **macOS**: Gatekeeper refuses the unsigned, un-notarized app outright; since
  Sequoia the only path is System Settings → Privacy & Security → "Open
  Anyway" (right-click-Open no longer suffices). A brew-cask install hits the
  same quarantine wall at first launch. macOS distribution is effectively
  gated on the $99 certificate; treat the cask as staged, not shipping.
- **Linux**: no gatekeeping — `chmod +x` the AppImage or `dpkg -i` the deb.

## Auto-update (the feed, and the UX)

Packaged builds check the signed GitHub Releases feed
(`electron-builder.yml` `publish`) on launch and every 6 hours via
`electron-updater`, which verifies each update's signature — an
unsigned/tampered build is rejected. A newer build downloads in the
background; `src/main/updater.ts` pushes the lifecycle
(`checking → available → downloading(%) → ready → error`) to the renderer over
`UpdateChannels.state`.

What the user sees: a row pinned to the **bottom of the workspaces rail**, which
walks the lifecycle — "Update is available" → "Downloading… 42%" (the row fills
as a progress track) → "**Restart to update**". It is hidden entirely while idle.
Alongside it: a quiet dot in the titlebar while a build downloads, and exactly
**one** toast when it's ready ("vX.Y.Z is ready — **Restart now** / **Later**").
Restart calls `quitAndInstall(true, true)` — silent reinstall, then relaunch.
Later is a first-class choice: the build installs on next quit via
`autoInstallOnAppQuit`, nothing re-toasts that version this session (no
snooze-nag), and the rail row stays put as the way back. Nothing is lost across
the restart — terminal sessions live in the detached daemon (ADR 0006), which
survives the swap and hands the panes back. Update metadata never enters
telemetry — booleans only (`update.ready`/`restart`/`later`), ADR 0005.

### `artifactName` MUST NOT contain a space

This is load-bearing, and it silently broke every update from v0.3.0 to v0.10.0.

`productName` is "MoggingLabs Workspace". With `artifactName: ${productName}-…`
three different names existed for one file: the build wrote `MoggingLabs
Workspace-x-win-x64.exe`, electron-updater derives its download URL by replacing
spaces with **hyphens** (`GitHubProvider`, "for backward compatibility"), and
GitHub's asset upload rewrites the space to a **dot**. So `latest.yml` pointed at
`MoggingLabs-Workspace-…` while the asset was `MoggingLabs.Workspace-…`, and
every download — and every `.blockmap`, so every differential update — 404'd. The
only symptom was an `error` phase in an app nobody could see.

The names are now hard-coded space-free (`MoggingLabs-Workspace-${version}-…`),
and the Release workflow's **"Verify the update feed resolves"** step cross-checks
every `url:` in `latest*.yml` against the release's actual asset list, failing the
release rather than shipping a dead feed. Do not reintroduce `${productName}`
here, and avoid renaming artifacts at all: electron-updater finds the *previous*
blockmap by string-substituting the version into the current name, so any rename
silently downgrades that one update to a full download.

Practical dependency: mac auto-update is inert until the app is signed +
notarized (Squirrel.Mac refuses unsigned updates) — see the matrix above. Dev
builds don't auto-update; `MOGGING_FAKE_UPDATE=<version>` replays the whole
renderer flow with no network (how the `FIRSTRUN` smoke asserts it).

## Install manifests

Both manifest sets live in `packaging/`, point ONLY at official GitHub release
artifacts with pinned sha256 hashes, and regenerate from built artifacts with
one command — never hand-edit hashes:

```sh
# from a local release build:
node scripts/update-manifests.mjs            # reads dist/
# from a published release:
gh release download v0.12.0 -D /tmp/rel && node scripts/update-manifests.mjs /tmp/rel
```

CI validates both continuously where the tooling exists (`winget validate` on
windows-latest, `brew style` on macos-latest) so submission day is a
copy-paste PR.

**v0.12.0 status:** both manifests regenerated from the shipped v0.12.0 artifacts
and validation-green in CI; the exe sha256 and the arm64 dmg sha256 are pinned
to the release (win exe cross-verified against `latest.yml`'s sha512). The cask
is arm64-only for this release (Intel deferred — see the matrix footnote).
Neither is submitted yet — the checklists below are the copy-paste path when
you choose to.

### winget submission playbook
1. Regenerate manifests for the release being submitted; commit.
2. Fork `microsoft/winget-pkgs`; copy `packaging/winget/*` to
   `manifests/m/MoggingLabs/Workspace/<version>/`.
3. PR. The repo's validation pipeline installs the package in a sandbox —
   NSIS installs silently (`/S`) so no interactivity blockers.
4. Later versions: same three files, new version + hash (or `wingetcreate update`).

### homebrew playbook
1. **Start with our own tap** — create `MoggingLabs/homebrew-tap`, copy
   `packaging/homebrew/Casks/mogginglabs-workspace.rb` into its `Casks/`
   (the layout already matches). Users:
   `brew install --cask mogginglabs/tap/mogginglabs-workspace`. No gatekeeping,
   ships today.
2. `homebrew/cask` core comes later: it expects notability and a signed,
   notarized app — revisit after certificates land.
