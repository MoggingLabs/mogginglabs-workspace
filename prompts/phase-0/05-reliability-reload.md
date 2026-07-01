# 05 — Reliability: renderer reload must not kill the agent

**Prereq:** `04` green. **Shared context:** see `README.md`.

## Goal
Prove the core wedge: because the PTY lives in the **main** process (not the renderer),
a UI crash/reload must not kill a running agent. This is the exact axis where
BridgeSpace bleeds.

## Steps
1. In the pane, start a long-running command or agent (e.g. `claude` mid-task, or
   `ping -t` on Win / `ping` on mac, or a `for`-loop printing every second).
2. Reload the renderer: **Ctrl-R** (or `webContents.reload()` via the menu).
3. Confirm the process **survives**: after the reload, output from the still-running
   process continues to appear in the fresh pane, and it eventually completes/responds.
4. Confirm no **duplicate** shell was spawned — `PtyService.spawn` guards on pane id, so
   reloading and re-mounting pane id 1 must reattach to the existing PTY, not fork a
   second one.

## Known Phase-0 limitation (document, do not "fix" here)
- The reloaded renderer starts with a **blank** scrollback — prior output is not
  repainted (the PTY already streamed it to the old renderer). Restoring scrollback on
  reconnect is Phase 1 (via `@xterm/addon-serialize` snapshots).
- Full **app/OS restart** is NOT covered by this (PTYs die with the host). Phase 1 uses
  each agent's own `--resume` and/or a persistent pty-host process (ADR 0003).

## Files
- `src/main/index.ts` (PTY owned by main; backend composed here)
- `src/main/electron-context.ts` (emit path to the current window)
- `src/backend/features/terminal/pty.service.ts` (`spawn` id-guard = reattach, not duplicate)
- `src/ui/features/terminal/terminal-pane.ts` (re-mount behavior on reload)

## Definition of Done
- After a renderer reload, the previously-started agent/command is **still running** and
  its continued output appears in the new pane.
- No duplicate shell/agent is spawned.

## Checks that must be green
- Reload-survives test passes (process alive post-reload; single PTY).
