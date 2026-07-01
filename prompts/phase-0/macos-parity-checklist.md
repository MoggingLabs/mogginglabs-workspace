# Phase 0 — Cross-platform parity: Windows results + macOS checklist (tracked gap)

**Status (2026-07-01):** Windows (ConPTY) verified — steps 01–05 all green this session.
macOS (forkpty) is a **documented, tracked gap** (no Mac available at verification time).
Run this checklist on a Mac before any broad release; note any rendering/input/resize
divergence.

## Windows (ConPTY) — VERIFIED
| Step | Check | Result |
|---|---|---|
| 01 | `npm run dev` launches, zero console errors, `window.bridge` = {invoke,send,on}, shell renders | PASS |
| 02 | Login shell + env/PATH, echo I/O, 132 streamed lines, window-resize reflow (46x166→33x121), pty resize, scrollback (75>33), WebGL active, copy, paste | PASS |
| 03 | Real Claude Code v2.1.197 as a full TUI (alt-screen enter+restore, truecolor, raw keys), self-authenticated on the user's Claude Max, zero credential brokering | PASS |
| 04 | OSC agent-state chip: OSC 9→attention, 133;C→busy, 133;D;0→idle, OSC 7 no-op/no-error | PASS |
| 05 | Renderer reload does not kill the agent (counter survived MARK_5→MARK_18, no duplicate spawn, remounted) | PASS |
| — | `npm run build` (out/main+preload+renderer), `npm run typecheck` (0), boundary grep clean | PASS |

Windows shell = `cmd.exe` (via `COMSPEC`); node-pty = prebuilt `@lydell/node-pty` (ConPTY
binaries), no VS toolchain needed.

## macOS (forkpty) — TO RUN
Do this on Apple Silicon (arm64) and, if possible, Intel (x64). For each, launch the app
and confirm the same behaviours; record PASS/FAIL + any divergence.

- **Prereq:** `npm install` (the `postinstall` runs `electron-builder install-app-deps`,
  which pulls the mac `@lydell/node-pty` prebuilt — no Xcode toolchain needed).
- **01 launch:** `npm run dev` opens the window, both consoles error-free, `window.bridge` present.
- **02 terminal core:** shell spawns as a **login shell** (`$SHELL -l`) with `.zshrc`/`.bashrc`
  + PATH loaded (`echo $PATH`); typing/streaming; **window resize reflows**; copy = **Cmd+C**,
  paste = **Cmd+V** (our handler already maps `metaKey`); **WebGL active** (real GPU — expect
  no fallback).
- **03 agent CLI:** run `claude` — full TUI (alt-screen, truecolor, raw keys), self-authed.
- **04 OSC state:** `printf '\033]9;hi\007'` → attention; `printf '\033]133;C\007'` → busy;
  `printf '\033]133;D;0\007'` → idle; `printf '\033]7;file://host/tmp\007'` → no-op/no-error.
  (macOS `printf` emits OSC natively — no `node -e` needed.)
- **05 reload survival:** start a long process, `Cmd-R` (or `webContents.reload()`), confirm it
  survives and no duplicate spawns.

### Running the automated smokes on macOS
- `MOGGING_STATE=1` and `MOGGING_RELOAD=1` smokes use `node -e` (cross-platform) — expected to
  run **as-is** on macOS.
- `MOGGING_SMOKE=1` (step 02) and `MOGGING_AGENT=claude` (step 03) currently drive the pane with
  **cmd.exe** syntax (`echo %PATH%`, `for /L`, `set "X="`, `cd /d`). To run these on macOS,
  either (a) do the checklist **manually**, or (b) make the smokes shell-aware (Phase-1 nicety):
  `echo $PATH`, a POSIX loop, `unset`, `cd`.

## Gate
- Windows verified + all build/typecheck/boundary checks green -> **Phase 0 passes** (macOS
  tracked here as a follow-up).
- If macOS shows rendering/input divergence or WebGL is unusable -> **STOP** and revisit
  `docs/adr/0001-electron-over-tauri.md` before continuing Phase 1.
