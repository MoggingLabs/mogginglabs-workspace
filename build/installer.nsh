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
;   2. whatever remains on this exe name is the daemon (or a hung instance): Stop-Process.
;      Hard, not graceful — NSIS cannot speak the daemon's authed socket. The cost is
;      bounded by the session store's write coalescing (~2s of scrollback tail at worst);
;      the sessions themselves restore on next launch from sessions.db, exactly as after
;      a crash. An install that cannot proceed at all is strictly worse.
;
; No dialogs on any path (silent updates run this too). Every PowerShell `$` is `$$` — NSIS
; interpolates `$` in strings.
; (One physical line, deliberately: NSIS line continuation inside a quoted string is dialect-
; fragile, and an installer is the worst possible place to discover a parser disagreement.)
!macro customCheckAppRunning
  nsExec::Exec 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$n = [IO.Path]::GetFileNameWithoutExtension(\"${APP_EXECUTABLE_FILENAME}\"); $$ps = Get-Process -Name $$n -ErrorAction SilentlyContinue; foreach ($$p in $$ps) { if ($$p.MainWindowHandle -ne [IntPtr]::Zero) { $$null = $$p.CloseMainWindow() } }; $$deadline = (Get-Date).AddSeconds(15); while ((Get-Date) -lt $$deadline -and (Get-Process -Name $$n -ErrorAction SilentlyContinue | Where-Object { $$_.MainWindowHandle -ne [IntPtr]::Zero })) { Start-Sleep -Milliseconds 300 }; Get-Process -Name $$n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500"'
  Pop $0
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
