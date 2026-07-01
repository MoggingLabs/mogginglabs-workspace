# 02 — Terminal core verification

**Prereq:** `01` green. **Shared context:** see `README.md`.

## Goal
The pane is a real, usable terminal: a login shell with the user's environment,
correct I/O, resize, copy/paste, scrollback, and GPU rendering.

## Steps
1. Confirm the shell spawns as a **login shell** with profile + PATH intact:
   - Windows: PowerShell/`COMSPEC`; run `echo $env:PATH` and confirm your tools resolve.
   - macOS: `$SHELL -l`; run `echo $PATH` and confirm `.zshrc`/`.bashrc` ran.
2. Typing echoes; commands run; output streams smoothly.
3. Resize the window — the terminal reflows (cols/rows update; SIGWINCH forwarded).
4. Copy/paste works; scrollback scrolls.
5. Confirm the **WebGL** renderer is active (no `WebGL renderer unavailable` warning),
   or that the logged canvas fallback renders correctly.

## Files
- `src/ui/features/terminal/terminal-pane.ts` (xterm + fit + webgl; spawn/resize wiring)
- `src/ui/features/terminal/terminal.client.ts` (IPC calls)
- `src/backend/features/terminal/pty.service.ts` (node-pty spawn, env, name `xterm-256color`)
- `src/backend/platform/shell.ts` (login shell + args)

## Definition of Done
- Login shell with correct env; input/output/resize/copy-paste/scrollback all work.
- WebGL active, or canvas fallback works and is logged.

## Checks that must be green
- `npm run dev` acceptance: the checklist above passes end to end
- `printf 'hello'` (or `echo hello`) renders; a `top`/`htop` style full-screen refresh is smooth
