# Windows installer audit — why it freezes, and what "best" looks like

**Date:** 2026-07-31 · **Status:** implemented same day (Tiers 1–3) — measured results in §9;
Tier 4 (the `nsis.script` fork) deliberately not taken
**Subject:** `MoggingLabs-Workspace-0.16.0-win-x64.exe` (NSIS assisted installer, electron-builder 26.15.6)
**Method:** the shipped 0.16.0 artifact + the resulting install tree on a real machine, read against
electron-builder's own NSIS templates in `node_modules/app-builder-lib/templates/nsis/`. Every number
below is measured or read off a template line, not estimated — estimates are labelled as such.

---

## 0. The verdict

The installer is slow for one reason and *feels* broken for four others, and they are separable.

It is **slow** because it places **618 MB across 1143 files** on disk, of which **~137 MB and ~865
files are build debris that has no business shipping** — MSVC link intermediates, MSBuild logs, a 9.5 MB
copy of `sqlite3.c` (twice), ~57 MB of `.pdb` debug symbols, arm64 and darwin binaries inside an x64-only
installer, and `prebuild-install`'s own npm dependency tree. And it writes that payload **three times**
(installer → `%TEMP%`, decompress → `%TEMP%`, copy → install dir) before deleting 773 MB of temp.

It *feels* broken because electron-builder's template **turns the details log off by construction**
(`SetDetailsPrint none`), calls the **no-progress** variant of the 7z extractor (`Nsis7z::Extract`, not
`ExtractWithDetails`), and this repo's own `customCheckAppRunning` **blocks the wizard's UI thread for
2.24 s of PowerShell startup on a fresh install** — measured, with the app not running — and for up to
**15.5 s** when it is.

And it ends on MUI's stock finish page: a *checkbox* labelled "Run MoggingLabs Workspace" and a button
labelled "Finish". There is no Launch button, no shortcut choice, and a desktop shortcut that is created
silently on fresh install and **never restored on update** if the user ever deleted it.

None of this is exotic. All of it is fixable, and most of it is fixable in config.

---

## 1. What was measured

| | |
|---|---|
| Shipped installer | `MoggingLabs-Workspace-0.16.0-win-x64.exe` — 162,653,481 B = **155 MiB** |
| Install tree | `%LOCALAPPDATA%\Programs\MoggingLabs Workspace` — **618 MB, 1143 files** |
| Full copy of that tree, this machine, warm cache | **5,675 ms** |
| `customCheckAppRunning`, app **not** running | **2,241 ms** of blocked UI thread |
| `customCheckAppRunning`, app running | PowerShell startup + up to 15 s poll + 500 ms sleep ≈ **17 s** worst case |

The 5.7 s copy is a *floor*, not the real cost: it is one pass, warm, with no decompression and without
Defender treating the destination as a fresh executable drop. The installer does that pass twice, plus a
decompression pass, plus a 773 MB delete.

---

## 2. What actually happens when you click Install

Read top to bottom from `templates/nsis/installSection.nsh` and the includes it pulls in.

**`installSection.nsh:5-7`**
```nsis
${IfNot} ${Silent}
  SetDetailsPrint none
${endif}
```
Every `DetailPrint` in the entire install section is discarded. The log pane is empty **by design** —
not because nothing is happening, but because electron-builder decided the assisted installer should be
quiet. This is the direct answer to "it doesn't know what's going on": nothing is permitted to say so.

**`include/allowOnlyOneInstallerInstance.nsh:38` → `build/installer.nsh:53`**
This repo's `customCheckAppRunning` fires here, via `nsExec::Exec` — a **blocking** call with no message
pump. It spawns `powershell.exe -NoProfile -NonInteractive` unconditionally, even on a machine where the
app has never run. PowerShell 5.1 cold start alone is ~1.7 s; plus the pinned `Start-Sleep -Milliseconds
500` at the end, that is the **2.24 s measured freeze the moment you click Install**. The window is
already ghosted before a single byte is written.

**`include/extractAppPackage.nsh:1-4, 73`**
```nsis
!ifdef COMPRESS
  SetCompress off
!endif
...
File /oname=$PLUGINSDIR\app-64.${COMPRESSION_METHOD} "${APP_64}"
```
The 155 MB `app-64.7z` is stored **uncompressed** inside the installer (correctly — it is already 7z) and
copied byte-for-byte into `%TEMP%\…\PLUGINSDIR`. One `File` op, ~155 MB, and NSIS emits **one** progress
tick for the whole thing.

**`include/extractAppPackage.nsh:97`**
```nsis
Nsis7z::Extract "${FILE}"
```
Not `Nsis7z::ExtractWithDetails`. The plain `Extract` export takes no callback string, publishes no
per-file progress, and **does not pump the message loop**. 618 MB of LZMA2 decompression happens inside
this one call with a dead progress bar and a "Not Responding" title bar. This is the long freeze.

(For the record: electron-builder's *older* templates used `Nsis7z::ExtractWithDetails "…" "Installing
%s..."`. The export exists in the pinned `nsis-resources-3.4.1` bundle. The switch to the silent variant
was made to buy the atomic retry below — progress was the price.)

**`include/extractAppPackage.nsh:108`**
```nsis
CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" $OUTDIR
```
A **second full 618 MB write**, 1143 files, into the install directory. `/SILENT` suppresses even the
shell's own copy dialog. This exists so a locked file can be retried (lines 104-135) — a real problem for
this app specifically, because the PTY daemon deliberately outlives the app and holds a lock on its own
executable (ADR 0006). The cost of that safety is doubling every byte.

**On exit** NSIS auto-`RMDir /r`s `$PLUGINSDIR`: **773 MB deleted** (155 MB archive + 618 MB extracted).

### The I/O ledger

| Step | Bytes written | Bytes read | Files touched | Progress shown |
|---|---|---|---|---|
| `File` → `%TEMP%\app-64.7z` | 155 MB | 155 MB | 1 | one tick |
| `Nsis7z::Extract` → `%TEMP%\7z-out` | 618 MB | 155 MB | 1143 | **none** |
| `CopyFiles /SILENT` → `$INSTDIR` | 618 MB | 618 MB | 1143 | **none** |
| `RMDir /r $PLUGINSDIR` | — | — | 2287 | none |
| **Total** | **~1.39 GB** | **~0.93 GB** | **~4600** | ~1 tick |

**≈2.3 GB of disk traffic to place 618 MB.** And every executable byte crosses Defender's real-time
scanner **twice** — once in `%TEMP%`, once in the install dir. The two worst shapes for that scanner are
both here: a 201 MB `MoggingLabs Workspace.exe` and an 88 MB `mogging-node.exe`.

---

## 3. Root cause 1 — 137 MB and 865 files of the payload are build debris

This is the largest and cheapest win, and it is pure config.

### 3a. `resources/app.asar.unpacked/node_modules` — 73 MB, 369 files

`buildDependenciesFromSource: true` (electron-builder.yml:5) is correct for ABI safety, but it leaves a
complete MSVC build tree in `node_modules`, and `asarUnpack` ships that tree whole.

| File | Size | What it is |
|---|---:|---|
| `better-sqlite3/build/Release/better_sqlite3.iobj` | 14.6 MB | MSVC incremental-link intermediate |
| `better-sqlite3/deps/sqlite3/sqlite3.c` | 9.5 MB | C source — compile-time only |
| `better-sqlite3/build/Release/obj/global_intermediate/sqlite3/sqlite3.c` | 9.5 MB | **the same file again** |
| `better-sqlite3/build/Release/sqlite3.lib` | 7.1 MB | static lib — link-time only |
| `node-pty/build/Release/winpty-agent.iobj` | 4.1 MB | intermediate |
| `better-sqlite3/build/Release/better_sqlite3.ipdb` | 3.5 MB | incremental PDB |
| `node-pty/build/Release/{winpty,conpty,pty}.iobj` | ~6.0 MB | intermediates |
| `node-pty/build/…/winpty-agent.tlog/CL.read.1.tlog` | 1.15 MB | **MSBuild log file** |
| `node-pty/prebuilds/win32-arm64/**`, `third_party/conpty/*/win10-arm64/**` | ~5 MB | **arm64 binaries in an x64-only installer** |

What the app actually loads: `better_sqlite3.node` (1.9 MB), `pty.node`, `conpty.node`,
`conpty_console_list.node`, `winpty.dll`, `winpty-agent.exe`, x64 `OpenConsole.exe`, and the `lib/*.js`.
**~9 MB of the 73 MB is live. ~64 MB is dead.**

The `prebuilds/` trees are provably dead here — `node-pty/lib/utils.js:18-19` resolves in the order
`build/Release` → `build/Debug` → `prebuilds/<platform>-<arch>`, and `build/Release` is populated because
we build from source. It never reaches `prebuilds/`.

### 3b. `resources/node-helper/node_deps` — 78 MB, 696 files

`scripts/build-node-helper.mjs:184` runs a plain `npm install --omit=dev` and renames `node_modules` →
`node_deps`. There is no prune step, so the raw npm tree ships.

`prebuilds/win32-x64/` is representative — the useful half is 1.3 MB, the rest is symbols:

| Live (1.3 MB) | Dead (28.6 MB) |
|---|---|
| `conpty.node` 312 KB · `pty.node` 303 KB · `conpty_console_list.node` 135 KB · `winpty-agent.exe` 308 KB · `winpty.dll` 256 KB | `conpty.pdb` 6.5 MB · `pty.pdb` 6.3 MB · `winpty-agent.pdb` 6.1 MB · `winpty.pdb` 5.4 MB · `conpty_console_list.pdb` 4.3 MB |

And `prebuilds/` contains **four** platform trees — `win32-x64`, `win32-arm64`, `darwin-x64`,
`darwin-arm64`. Three of them cannot execute on the machine the installer just ran on. Alongside that:
`better-sqlite3/deps/sqlite3/sqlite3.c` (9.5 MB again), and `prebuild-install`, `tar-fs`, `bl`,
`readable-stream`, `buffer`, `minimist`, `semver`, `node-addon-api` — install-time npm tooling and C++
headers, shipped to end users.

The helper needs roughly `mogging-node.exe` + `node-pty/{lib,prebuilds/win32-x64/*.node,*.exe,*.dll,
build/Release/conpty}` + `better-sqlite3/{lib,build/Release/better_sqlite3.node}` ≈ **5 MB**.
**~73 MB of the 78 MB is dead.**

### 3c. What is *not* debris

`LICENSES.chromium.html` (15 MB) is a redistribution obligation — it stays. `electron.exe` at 201 MB and
`mogging-node.exe` at 88 MB are the honest sizes of the two runtimes; the runtime split (ADR 0017) bought
`runAsNode: false`, and that trade is worth 88 MB.

### The arithmetic

| | Now | After prune | Δ |
|---|---:|---:|---:|
| `app.asar.unpacked` | 73 MB / 369 files | ~9 MB / ~40 files | −64 MB / −329 |
| `node-helper/node_deps` | 78 MB / 696 files | ~5 MB / ~90 files | −73 MB / −606 |
| **Install tree** | **618 MB / 1143 files** | **~481 MB / ~208 files** | **−137 MB / −935 files** |

The byte cut is 22%. The **file-count cut is 82%**, and that matters more: per-file syscall overhead and
per-file Defender dispatch dominate the `CopyFiles` and `RMDir` passes for a tree of this shape.

Download: the debris is highly compressible (two copies of `sqlite3.c`, five `.pdb`s, `.tlog` text), so
at the configured `dictSize=1MB, solid=false` expect roughly **155 MB → ~115-125 MB** *(estimate)*.

---

## 4. Root cause 2 — the progress bar is disconnected, not merely slow

Two template lines, quoted in §2, do all the damage: `SetDetailsPrint none` and `Nsis7z::Extract`.

Worth being precise about what *cannot* be fixed:

- **NSIS is single-threaded.** While `Nsis7z::Extract` or `CopyFiles` is running, no timer, no marquee
  style, and no `BgImage` will animate, because nothing pumps the message queue. "Not Responding" is a
  truthful report of the process state. The only cures are a shorter blocking phase (§3) or an extractor
  that pumps (`ExtractWithDetails`).
- **The single-pass fast path is unreachable from config.** `templates/nsis/include/installer.nsh:9-12`
  has a branch that uses NSIS's native `File /r` — which writes straight to `$INSTDIR`, drives the
  progress bar per-file for free, and eliminates the temp copy entirely. It is gated on `APP_BUILD_DIR`,
  which is only set when `USE_NSIS_BUILT_IN_COMPRESSOR` is true — and that is a **hardcoded `false`
  constant** at `NsisTarget.js:29`. There is no config option. Reaching it requires `nsis.script`
  (a full custom `.nsi`), and it would break `differentialPackage`.
- **`differentialPackage: true` costs download size on purpose.** `differentialUpdateInfoBuilder.js:55-58`
  forces `dictSize = 1 MB` and `solid = false`. That inflates the installer materially versus solid LZMA.
  **Keep it** — delta updates are worth more than one-time download size, and the electron-builder.yml
  comment already says so.

---

## 5. Root cause 3 — the ending is a checkbox, not a door

`build/installer.nsh` defines no `customFinishPage`, so `assistedInstaller.nsh:47-64` falls through to
MUI's stock page: `MUI_FINISHPAGE_RUN` (a checkbox reading "Run MoggingLabs Workspace") and a button
reading **Finish**. `runAfterFinish` defaults to true, so the checkbox is there — but a checkbox next to
"Finish" is not a launch button, and most people click Finish without reading it.

The desktop shortcut is worse. `CommonWindowsInstallerConfiguration.js:34-43` defaults
`createDesktopShortcut` to `FRESH_INSTALL`, and `installer.nsh:216-245` therefore:

- creates the shortcut **silently**, with no choice offered, on first install; and
- on **update**, only renames an existing one. If the user deleted it, `RECREATE_DESKTOP_SHORTCUT` is not
  defined, so **it never comes back** — no update, no reinstall, nothing short of a manual drag.

Also on the wizard path: `allowToChangeInstallationDirectory: true` shows a directory page to every user,
almost all of whom want the default. That is one extra click and one extra decision on the way in.

---

## 6. What "best" looks like

The bar is set by installers people don't complain about: **three screens, one decision, always
narrating, ends on a door.**

```
┌─ 1. Welcome ─────────────┐  ┌─ 2. Installing ──────────┐  ┌─ 3. Done ────────────────┐
│ MoggingLabs Workspace    │  │ ████████████░░░░░  68%   │  │  ✓ Installed             │
│ Version 0.16.0           │  │                          │  │                          │
│ Installs to:             │  │ Extracting resources\    │  │  ☑ Launch MoggingLabs    │
│   %LOCALAPPDATA%\…       │  │   node-helper\…          │  │  ☑ Create Desktop        │
│   [Change…]              │  │                          │  │      shortcut            │
│ Needs ~481 MB · ~20 s    │  │ Roughly 12 s remaining   │  │                          │
│            [ Install ]   │  │                          │  │        [  Launch  ]      │
└──────────────────────────┘  └──────────────────────────┘  └──────────────────────────┘
```

Three principles behind it:

1. **Say the cost before you charge it.** Size and target on screen *before* Install. A 20-second wait
   you were warned about is not a bad experience; a 20-second freeze you weren't is.
2. **Never go quiet.** Something changes on screen at least every second. A filename scrolling past is
   worth more than a smooth bar, because it proves liveness.
3. **End on a door, not a dead end.** The last button should be the thing they came for.

---

## 7. The plan

Ordered by payoff per unit of risk. Tiers 1-3 are config and `.nsh`; only Tier 4 forks anything.

### Tier 1 — prune the payload *(biggest win, zero risk, pure config)*

**1a. `electron-builder.yml`** — negate the build debris. Put arch-specific negations under the platform
key, not the shared `files`, so mac/linux builds are unaffected:

```yaml
files:
  # …existing entries…
  # ── Native-module build debris (docs/research/2026-07-installer-ux-audit.md §3a) ──
  # buildDependenciesFromSource leaves a whole MSVC tree in node_modules and asarUnpack
  # ships it: 73MB unpacked, ~9MB of which the app loads. Link intermediates and MSBuild
  # logs are never read at runtime.
  - '!**/node_modules/**/*.{iobj,ipdb,pdb,lib,exp,ilk}'
  - '!**/node_modules/**/*.tlog/**'
  - '!**/node_modules/*/build/Release/obj/**'
  - '!**/node_modules/*/build/Release/obj.target/**'
  # sqlite3.c is the compile input, 9.5MB, and it ships TWICE (deps/ + the copy under
  # build/Release/obj/global_intermediate/). better_sqlite3.node is the artifact.
  - '!**/node_modules/better-sqlite3/deps/**'
  - '!**/node_modules/better-sqlite3/src/**'
  # node-pty resolves build/Release FIRST (lib/utils.js:18-19). Built from source, so
  # prebuilds/ is never reached — verified on the 0.16.0 install tree.
  - '!**/node_modules/node-pty/prebuilds/**'
  - '!**/node_modules/node-pty/third_party/**'
```

> **Verify before landing:** the last two lines rest on `build/Release` being populated in the packaged
> tree. It is, in 0.16.0. A packaged smoke that opens a pane is the gate — if `build/Release` were ever
> empty, dropping `prebuilds/` would break the terminal outright. Keep `!prebuilds/**` in the *same
> commit* as that smoke.

**1b. `scripts/build-node-helper.mjs`** — prune after the npm install, before the `node_modules` →
`node_deps` rename. This is the bigger half (73 MB, 606 files) and belongs in the script, not in
`extraResources`, so the stamp file reflects what actually shipped:

```js
// prebuild-install and its dependency tree exist only to FETCH the natives during the
// npm install above. Nothing requires them at runtime; node-addon-api is C++ headers.
const INSTALL_TIME_ONLY = ['prebuild-install', 'tar-fs', 'bl', 'readable-stream', 'buffer',
                           'minimist', 'semver', 'node-addon-api', '.bin']
// node-pty ships four platform prebuilds and a .pdb beside every .node — 57MB of debug
// symbols, three-quarters of them for architectures this build cannot execute.
const FOREIGN = readdirSync(join(OUT, 'node_modules', 'node-pty', 'prebuilds'))
  .filter((d) => d !== `${PLATFORM}-${ARCH}`)
```
…then drop `INSTALL_TIME_ONLY`, `FOREIGN`, every `**/*.pdb`, and `better-sqlite3/deps` + `src`.

**Expected:** 618 MB / 1143 files → **~481 MB / ~208 files**; installer **155 MB → ~120 MB** *(estimate)*.
All three I/O passes and the temp delete shrink together.

### Tier 2 — a real finish page *(the Launch button and the shortcut choice)*

Add to `build/installer.nsh`. `customFinishPage` (`assistedInstaller.nsh:47`) replaces the stock page
wholesale:

```nsis
!macro customFinishPage
  !define MUI_TEXT_FINISH_INFO_TITLE "MoggingLabs Workspace is ready"
  !define MUI_TEXT_FINISH_INFO_TEXT  "Your keys, your CLIs. Open it to set up your first workspace."

  ; The wizard's last button IS the launch button — not "Finish" beside a checkbox
  ; nobody reads. MUI still needs the checkbox to gate the action; both agree.
  !define MUI_FINISHPAGE_BUTTON     "Launch"
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT   "Launch MoggingLabs Workspace"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ; ExecShellAsUser: the wizard may be elevated; the app must not inherit that.
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  ; The SHOWREADME slot is the standard NSIS idiom for a second finish-page checkbox.
  ; This makes the desktop shortcut a CHOICE, and — because the finish page also runs on
  ; update — restores one the user deleted. The stock FRESH_INSTALL policy never does
  ; (templates/nsis/include/installer.nsh:216-245).
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a Desktop shortcut"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "CreateDesktopShortcut"
  Function CreateDesktopShortcut
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" \
                   "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  FunctionEnd

  !insertmacro MUI_PAGE_FINISH
!macroend
```

and in `electron-builder.yml`, hand the decision to the checkbox:

```yaml
nsis:
  # The finish page owns this now (build/installer.nsh customFinishPage) — it is a choice,
  # and it is offered on update too, so a deleted shortcut can come back. The uninstaller
  # deletes $oldDesktopLink unconditionally (uninstaller.nsh:194-195), so cleanup is unaffected.
  createDesktopShortcut: false
```

> **Verify at build time:** `MUI_FINISHPAGE_BUTTON` and the `SHOWREADME`-as-checkbox idiom are MUI2
> features, not electron-builder ones — confirm against the NSIS bundle `makensis` resolves
> (`nsis-resources-3.4.1`). Both are long-standing; neither is exotic. `-WX` is on
> (`NsisTarget.js:514`), so a bad `!define` fails the build loudly rather than shipping.

### Tier 3 — stop stalling before the first byte

`build/installer.nsh` currently pays 2.24 s of PowerShell startup on **every** install, including the
fresh ones where there is provably no process to close. Guard it with the native probe — `nsProcess` is
already vendored (`templates/nsis/include/nsProcess.nsh`, plugin in `nsis-resources-3.4.1`):

```nsis
!macro customCheckAppRunning
  ; FAST PATH — a native DLL call, microseconds. On a fresh install there is no process,
  ; and the wizard must not pay PowerShell's ~1.7s cold start to learn that. Measured
  ; 2,241ms of blocked UI thread on a machine where the app had never run.
  nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
  Pop $0
  ${if} $0 != 0        ; 0 == found; anything else == not running
    nsProcess::_Unload
    Return
  ${endif}
  nsProcess::_Unload

  ; SLOW PATH — unchanged. The graceful-close-then-kill logic below is correct and stays
  ; exactly as documented above; it just no longer runs when there is nothing to close.
  nsExec::Exec 'powershell -NoProfile …'   ; existing one-liner, verbatim
  Pop $0
!macroend
```

Then set expectations before the wait, using `customPageAfterChangeDir` (`assistedInstaller.nsh:43`) —
a one-screen "About to install: ~481 MB to `$INSTDIR`, roughly 20 seconds" page. Cheap, supported, and it
converts an unexplained freeze into an announced wait.

### Tier 4 — real extraction progress *(optional; the only tier that forks)*

`nsis.script` (`nsisOptions.d.ts:167`) accepts a full custom `.nsi`. Copy `installer.nsi` and
`installSection.nsh` into `build/` and change exactly two lines:

```nsis
SetDetailsPrint listonly                                          ; was: none
Nsis7z::ExtractWithDetails "$PLUGINSDIR\app-$packageArch.7z" "Extracting %s…"   ; was: Extract
```

`ExtractWithDetails` publishes per-file progress **and pumps the message loop** — the bar moves, filenames
scroll, and the window stops reporting "Not Responding". That is the single change that makes the middle
screen honest.

**The cost is real and should be weighed against Tier 1.** A forked `.nsi` is pinned to electron-builder
26.15.6's template and must be re-diffed on every upgrade, in the one component where a silent
regression means users cannot install at all. **Do Tier 1 first and re-measure.** If pruning takes the
blocking phase from ~15 s to ~7 s, a dead bar for 7 s behind an announced wait may be acceptable and the
fork is not worth carrying.

### Explicitly not doing

- **`oneClick: true`.** It would remove the wizard and the directory page, but it removes the finish page
  too — no Launch button, no shortcut choice. Wrong direction for this product.
- **`differentialPackage: false`.** Would shrink the download meaningfully, and would degrade every
  future update from a delta to a full 120 MB transfer. Not a trade worth making.
- **Chasing the double write.** It is electron-builder's deliberate lock-safety design, and this app —
  with a daemon that outlives it and holds its own exe (ADR 0006) — is precisely the case it protects.
  Shrink the payload instead.

---

## 8. Verification

1. `npm run dist:win`, then `du -s` + `find | wc -l` on `dist/win-unpacked` — assert **≤ 250 files** and
   **≤ 500 MB**. Wire it as a gate; debris regrows silently every time a native dep is bumped.
2. Packaged smoke that opens a terminal pane and writes to `sessions.db` — proves the `prebuilds/` and
   `deps/` prunes did not remove something load-bearing. **Must land in the same commit as Tier 1.**
3. Fresh-VM install, wall-clock from Install-click to first painted window, before and after.
4. Manual: Launch button launches; shortcut checkbox creates a working, AUMI-tagged `.lnk`; unchecking it
   creates nothing; uninstall removes it.
5. Update path: install 0.16.0, delete the desktop shortcut, install the next build — the finish page
   must offer it back.

---

## 9. Implementation results (same day)

Tiers 1–3 landed 2026-07-31. Every prune was proven before it shipped: the Electron-ABI set by
dlopening every surviving `.node` under `ELECTRON_RUN_AS_NODE=1 electron.exe` plus a real ConPTY
spawn and sqlite round-trip against a pruned copy of the shipped tree; the helper set by
`build-node-helper.mjs`'s own load probe, which runs the helper binary against the pruned
`node_deps` before any stamp is written. The helper prune moved into
`scripts/prune-helper-deps.mjs` (allow-list of the four runtime-reachable packages — the deny-list
draft would have taken `bindings`, better-sqlite3's actual loader, with it) and runs on the
stamp-match path too, so an already-built tree cannot dodge a tightened rule.

| | v0.16.0 shipped | rebuilt, same version | Δ |
|---|---:|---:|---:|
| Install tree | 618 MB / 1143 files | **477 MB / 180 files** | −23% bytes, **−84% files** |
| `app.asar.unpacked/node_modules` | 71.5 MB / 359 files | 3.5 MB / 59 files | −95% |
| `node-helper/node_deps` | 75.5 MB / 694 files | 5.7 MB / 78 files | −92% |
| Installer download | 155.1 MB | **130.6 MB** | −16% |

Wizard verified end-to-end by a UI driver that reads every control's text and presses the buttons
(fresh reinstall over a live 0.16.0, wall-clock 82s of which 26s was Defender opening the
unsigned exe and 22.3s was the close-app + extract + copy phase): Welcome (with the cost warning)
→ install-mode → directory ("Space required: 476.7 MB") → finish page reading **"MoggingLabs
Workspace is ready"** with a **Launch** action and a **"Create a Desktop shortcut"** checkbox —
which restored a deliberately pre-deleted shortcut, the case the stock FRESH_INSTALL policy never
covers. WEIGHT gate (`check-package-weight.mjs`) wired as sweep gate #201 and into both CI
packaging rows.

**Found live during that verification, and fixed:** the daemon-retire step this file's own header
promised had been dead since ADR 0017 — it swept the APP's image name, and the daemon moved to
`mogging-node.exe`. A daemon from 20:33 survived a 23:43 reinstall, held its exe lock through it
(forcing extractAppPackage's ignore-errors double-extract fallback), and went on serving the new
app from the old binary. `customCheckAppRunning` now probes both image names on the fast path and
retires `mogging-node.exe` strictly under `$INSTDIR` on the slow path — dev-tree helpers are out
of scope by construction. Sessions restore from sessions.db, per the original design note.

**And the fix itself needed one more round, caught by the first real-world install (00:02,
operator-run):** the retire's first draft filtered on `Get-Process … $_.Path`, which is a silent
no-op in situ — NSIS is a 32-bit process, its `powershell` resolves to the WOW64 one, and a 32-bit
process cannot read a 64-bit process's module path, so `.Path` is `$null` for every daemon and the
`$INSTDIR` filter matches nothing. Proven from the 32-bit PowerShell directly: `.Path` empty for
all eight live daemons, while `Win32_Process.ExecutablePath` (CIM — the same idiom the stock
template's `FIND_PROCESS` uses, for the same reason) returns full paths and selects exactly the
installed-dir set, dev-tree helpers excluded. The shipped macro goes through CIM.

Still open, by choice: Tier 4 (per-file extraction progress needs the `nsis.script` fork) and the
transient first-launch "Not Responding" ghost — that is Defender scanning a just-written 201 MB
unsigned exe, and the durable fix is Authenticode signing (§ distribution doc), not installer
logic.
