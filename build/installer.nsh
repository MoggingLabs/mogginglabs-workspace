; Custom NSIS hooks for MoggingLabs Workspace.
;
; WHY THIS FILE EXISTS — the "installer crashes at the end" bug.
;
; NSIS's finish page runs the app with Exec, so the app inherits the INSTALLER's
; environment, which is the environment of whatever launched the installer. Electron
; hosts (this app's own terminal panes, VS Code, Claude Code desktop) export
; ELECTRON_RUN_AS_NODE=1 into every child shell. Download and run the installer from
; one of those and the app it launches at the end boots as PLAIN NODE — and with no
; script argument, `electron.exe` in node mode simply exits 0 immediately.
;
; The result: the window never appears, nothing is written to the event log, and there
; is no crash dialog. It reads exactly like "the installer died at the very end".
;
; It cannot be fixed inside the app: the app's JS is never loaded, so no guard in
; src/main/index.ts would ever execute. The scrub has to happen in the process that
; does the Exec — this one. SetEnvironmentVariable with a NULL value deletes the
; variable from the installer's block, so every child it spawns is clean.
;
; The daemon is unaffected: it runs on the standalone Node helper (ADR 0016,
; src/main/daemon-client.ts), which ignores the variable like any plain node. The
; PACKAGED app ignores it too now (runAsNode fuse off) — this scrub stays as the
; belt for the braces: dev builds still honor it, and a clean child env is simply
; correct regardless of who reads it.

; ── THE DAEMON vs THE INSTALLER ──────────────────────────────────────────────────────────
;
; The PTY daemon is spawned FROM A BINARY IN THE INSTALL DIR (daemon-client.ts: the
; bundled standalone helper, resources/node-helper — ADR 0016) and deliberately
; outlives the app (ADR 0006). A running process holds
; a Windows lock on its own executable — so electron-builder's stock running-app check closed
; the app, still found a live process on that exe (the daemon: windowless, unclosable, no
; WM_CLOSE to answer), and stalled the install forever on "MoggingLabs Workspace cannot be
; closed. Please close it manually and click Retry" — a dialog about a process the user
; cannot see, with a Retry that can never succeed. Found live, updating v0.11.0 → v0.11.1.
;
; The app's own updater retires the daemon GRACEFULLY before quitAndInstall (updater.ts) —
; that is the lossless, primary path. This macro is the second line, for the installs the
; app never sees coming: a downloaded installer run by hand, exactly the failing case above.
;
;   1. windowed instances get WM_CLOSE (CloseMainWindow) — the same graceful close the stock
;      check performs — and up to 15s to unwind;
;   2. whatever remains on this exe name is a hung instance: Stop-Process. Hard, not
;      graceful — NSIS cannot speak the app's IPC;
;   3. the daemon itself: mogging-node.exe processes running FROM UNDER $INSTDIR get
;      Stop-Process too. The path scope is the whole point — the image name is shared with
;      dev-tree helpers (build/node-helper/…) and those belong to a checkout, not to this
;      install; only the process whose binary this installer is about to overwrite may die.
;      The cost is bounded by the session store's write coalescing (~2s of scrollback tail
;      at worst); the sessions themselves restore on next launch from sessions.db, exactly
;      as after a crash. An install that cannot proceed at all is strictly worse.
;
; STEP 3 WENT MISSING AT THE RUNTIME SPLIT, AND THIS IS ITS RESTORATION. The original
; version of this macro killed "whatever remains on this exe name", which WAS the daemon —
; until ADR 0017 moved the daemon onto the standalone helper, a different image name, and
; the sweep quietly started matching nothing. Observed live on the 2026-07-31 reinstall:
; a daemon from 20:33 sailed through a 23:43 install untouched, held the lock on its own
; mogging-node.exe throughout (forcing extractAppPackage's ignore-errors double-extract
; fallback — a full second write of the payload), and was still serving the NEW app's
; sessions from the OLD binary afterwards. Version skew between a live daemon and the tree
; on disk is exactly the class of bug the updater path retires gracefully; the hand-run
; path has to do it here, bluntly, or not at all.
;
; No dialogs on any path (silent updates run this too). Every PowerShell `$` is `$$` — NSIS
; interpolates `$` in strings.
; (One physical line, deliberately: NSIS line continuation inside a quoted string is dialect-
; fragile, and an installer is the worst possible place to discover a parser disagreement.)
;
; ── THE FAST PATH ────────────────────────────────────────────────────────────────────────
;
; The PowerShell below is correct and stays. What was wrong was paying for it
; UNCONDITIONALLY. nsExec::Exec blocks the wizard's single UI thread with no message pump,
; and `powershell.exe -NoProfile` costs ~1.7s of cold start before it executes a character —
; so a machine where this app has NEVER RUN paid a measured 2,241ms of frozen, ghosted
; window between the Install click and the first byte written. That is the freeze users
; reported, and it happened before anything was installing at all.
;
; nsProcess::_FindProcess is a native DLL call — microseconds — and the plugin already ships
; in the toolchain electron-builder pins (nsis-resources-3.4.1; the header is vendored at
; app-builder-lib/templates/nsis/include/nsProcess.nsh). It returns 0 when a process with
; that image name exists and non-zero when none does. On a fresh install the answer is "no"
; and the wizard proceeds immediately.
;
; ── AND THE ONE PLACE THE LOG CAN BE TURNED BACK ON ──────────────────────────────────────
;
; electron-builder's install section opens with `SetDetailsPrint none`
; (templates/nsis/installSection.nsh:5-7), which discards EVERY DetailPrint for the rest of
; the install. That is why the progress window has nothing to say while it works — not
; because nothing is happening. This macro is expanded at installSection.nsh:36, the only
; hook that runs after that line and before the heavy work (uninstallOldVersion,
; installApplicationFiles, the registry writes, the shortcuts), so it is the only seam from
; which the setting can be undone without forking the template.
;
; Be precise about what this buys: the phases around the extraction narrate themselves
; again, and the status line above the bar stops being blank. It does NOT make the
; extraction itself tick — Nsis7z::Extract publishes no progress and pumps no messages
; (audit §4), and only ExtractWithDetails would, which needs the nsis.script fork we
; deliberately are not taking yet.
;
; NO `Return` ANYWHERE IN THIS MACRO. It expands inside `Section "install"`, not inside a
; Function, so a Return here would return from the SECTION and silently skip the install.
!macro customCheckAppRunning
  ${IfNot} ${Silent}
    SetDetailsPrint both
  ${endif}

  ; Two probes, both native-DLL cheap. The app's image name catches a windowed or hung
  ; instance; the helper's catches the detached daemon, which outlives the app by design
  ; (ADR 0006) and is the usual survivor on a hand-run install — the app was long closed,
  ; the daemon kept the workspace warm. "mogging-node.exe" is HELPER_NODE's shipped name
  ; (scripts/build-node-helper.mjs EXE); a rename there must land here too.
  ; The name probe cannot see paths, so a dev-tree helper trips it — the slow path's
  ; $INSTDIR scope then correctly kills nothing, and only a developer pays the 2s.
  nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
  Pop $0
  ${if} $0 != 0
    nsProcess::_FindProcess "mogging-node.exe"
    Pop $0
  ${endif}
  nsProcess::_Unload

  ; $0 == 0 means at least one of the two images is live — take the slow path. ONE
  ; PowerShell invocation does app-close AND daemon-retire: the ~1.7s cold start is the
  ; dominant cost, so it must not be paid twice.
  ;
  ; The daemon-retire goes through Win32_Process (CIM), NEVER Get-Process .Path — and this
  ; was found the hard way, on the very first live run of this macro (2026-08-01 00:02).
  ; NSIS is a 32-BIT process, so its `powershell` is the WOW64 one, and a 32-bit process
  ; cannot read the module path of a 64-bit process: Get-Process .Path returns $null for
  ; every daemon, the $INSTDIR filter matches nothing, and the retire is a silent no-op —
  ; observed as a 20:33 daemon sailing untouched through a 00:02 install. WMI serves
  ; ExecutablePath regardless of caller bitness; the stock template's FIND_PROCESS uses
  ; Win32_Process for exactly this reason. The path scope stays load-bearing either way:
  ; dev-tree helpers share the image name and must never be touched.
  ${if} $0 == 0
    DetailPrint "Closing ${PRODUCT_NAME}…"
    nsExec::Exec 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$n = [IO.Path]::GetFileNameWithoutExtension(\"${APP_EXECUTABLE_FILENAME}\"); $$ps = Get-Process -Name $$n -ErrorAction SilentlyContinue; foreach ($$p in $$ps) { if ($$p.MainWindowHandle -ne [IntPtr]::Zero) { $$null = $$p.CloseMainWindow() } }; $$deadline = (Get-Date).AddSeconds(15); while ((Get-Date) -lt $$deadline -and (Get-Process -Name $$n -ErrorAction SilentlyContinue | Where-Object { $$_.MainWindowHandle -ne [IntPtr]::Zero })) { Start-Sleep -Milliseconds 300 }; Get-Process -Name $$n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Get-CimInstance -ClassName Win32_Process -Filter \"Name='mogging-node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith(\"$INSTDIR\", [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500"'
    Pop $0
  ${endif}
!macroend

!macro customInit
  ; Runs in .onInit, long before the finish page's Exec — so the app we launch,
  ; and anything it spawns, gets an environment without the poison.
  System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'

  ; Same inheritance channel, same class of bug: the app treats any MOGGING_* gate
  ; var as "I am a smoke test", which skips the single-instance lock and, for the
  ; windowless gates, exits without ever showing a window. A shipped build launched
  ; from a pane must never think it is a test harness.
  System::Call 'kernel32::SetEnvironmentVariable(t "MOGGING_USERDATA", p 0)'
  System::Call 'kernel32::SetEnvironmentVariable(t "MOGGING_GATES", p 0)'
  System::Call 'kernel32::SetEnvironmentVariable(t "MOGGING_PANE_ID", p 0)'
  System::Call 'kernel32::SetEnvironmentVariable(t "MOGGING_DAEMON_ENDPOINT", p 0)'
  System::Call 'kernel32::SetEnvironmentVariable(t "MOGGING_FAKE_UPDATE", p 0)'
!macroend

; ══ THE PAGES ═══════════════════════════════════════════════════════════════════════════
;
; electron-builder's assisted installer already renders four screens — install mode (the
; per-user / all-users radio, multiUserUi.nsh PAGE_INSTALL_MODE, shown because perMachine is
; false), directory, installing, and MUI's stock finish. It offers two hooks
; (assistedInstaller.nsh:9-11 and :47-48) and we take both:
;
;   Welcome  →  Who for  →  Where  →  Installing  →  Done
;   (new, skipped         (skipped              (rebuilt: Launch +
;    on update)           on update)             Desktop shortcut)
;
; Five screens on a first install, two on an update. That is one more than v0.16.0 showed,
; and it buys the two things the audit found missing: "say the cost before you charge it"
; and "end on a door, not a dead end" (docs/research/2026-07-installer-ux-audit.md §6).
;
; The install-mode page is deliberately LEFT ALONE. customInstallMode could force per-user
; and skip it, which would shave a click — but some people do want an all-users install, and
; silently deciding that for them is not a UX improvement, it is a removed capability.

; ── 1. WELCOME ───────────────────────────────────────────────────────────────────────────
;
; A wait you were warned about is not a bad experience; a wait you were not warned about is
; the same wait and reads as a hang. So the welcome page states, in plain words, that the
; slow part is unpacking two bundled runtimes and that Windows will scan them — which is
; the literal truth of where the seconds go (audit §2), and it is the last thing the user
; reads before the progress bar goes quiet.
;
; skipPageIfUpdated: an in-app update runs this installer too (updater.ts quitAndInstall).
; Nobody wants a welcome screen for an update they already agreed to. The template applies
; the same macro to the directory page, so both vanish on that path and an update stays a
; two-screen affair.
;
; The text is deliberately NOT parameterised on ${ESTIMATED_SIZE}: it is an optional define
; (Defines.d.ts:42), and MUI welcome text is compile-time, so a runtime number would mean
; poking the control by handle in a SHOW callback. Not worth the coupling for one figure.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Install ${PRODUCT_NAME}"
  ; One physical line, for the same reason the PowerShell above is one physical line: this
  ; file's standing rule is that installer sources do not gamble on NSIS line-continuation
  ; behaviour inside a quoted string.
  !define MUI_WELCOMEPAGE_TEXT "Version ${VERSION}$\r$\n$\r$\n${APP_DESCRIPTION}$\r$\n$\r$\nThis takes under a minute. Most of it is unpacking the bundled Node runtime and terminal components while Windows scans them, so the progress bar can sit still for a stretch — it has not stopped.$\r$\n$\r$\nNothing is installed for other users of this PC, and no reboot is needed.$\r$\n$\r$\nClick Next to choose where it goes."
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ── 2. FINISH ────────────────────────────────────────────────────────────────────────────
;
; What v0.16.0 ended on: MUI's stock page, a checkbox reading "Run ${PRODUCT_NAME}", and a
; button reading Finish. Two things wrong with that. The launch affordance was a checkbox
; most people never read, and the desktop shortcut was never offered at all — it was
; created silently on fresh installs and, on updates, only ever RENAMED, so a user who
; deleted theirs never saw it again (installer.nsh:216-245, and see the createDesktopShortcut
; note in electron-builder.yml).
;
; Now both are explicit, labelled, and checked by default. Two checkboxes over a Finish
; button is the shape Git for Windows, the Node.js installer and VS Code all use; it is
; what people expect to find, which is the whole point.
;
; WHY THIS RE-IMPLEMENTS StartApp: defining customFinishPage suppresses the template's own
; StartApp Function (it lives in the !else arm at assistedInstaller.nsh:49-62), so we owe
; one. It is a copy of theirs, NOT `!insertmacro StartApp` from common.nsh — that macro
; opens with `Var /GLOBAL startAppArgs`, and installSection.nsh:88 already expands it for
; the silent path. Declaring the same global twice is a makensis error.
!macro customFinishPage
  ; MUI_FINISHPAGE_*, not MUI_TEXT_FINISH_INFO_* — the latter are the underlying language
  ; strings that addLangs owns, and overriding those directly fights the language pass.
  !define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} is ready"
  !define MUI_FINISHPAGE_TEXT "Open it to set up your first workspace."

  ; ExecShellAsUser, not Exec: the wizard may be running elevated, and the app must not
  ; inherit that token. `--updated` is the flag the app reads to know it was just upgraded.
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Launch ${PRODUCT_NAME}"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"

  ; The SHOWREADME slot is the long-standing NSIS idiom for a second finish-page checkbox:
  ; an empty MUI_FINISHPAGE_SHOWREADME means MUI opens nothing itself and just calls the
  ; function. $newDesktopLink is used rather than a fresh "$DESKTOP\…" string on purpose —
  ; setLinkVars built it under the resolved shell context, and it is the exact path the
  ; uninstaller later deletes, so a shortcut made here is a shortcut that gets cleaned up.
  Function CreateDesktopShortcut
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  FunctionEnd
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a Desktop shortcut"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "CreateDesktopShortcut"

  !insertmacro MUI_PAGE_FINISH
!macroend
