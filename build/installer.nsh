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
; The daemon is unaffected: it is spawned by the app with ELECTRON_RUN_AS_NODE set
; explicitly on its OWN spawn env (src/main/daemon-client.ts), never inherited.

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
