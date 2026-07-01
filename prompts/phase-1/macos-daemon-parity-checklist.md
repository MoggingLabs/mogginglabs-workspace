# Phase 1 — Detached daemon: macOS (forkpty) parity checklist (tracked gap)

**Status (2026-07-01):** the daemon is verified on **Windows** (survival, OSC parity, auth,
comprehensive terminal smoke) and **builds green on macOS in CI**. Runtime verification on a
Mac is pending (no Mac at build time). Run this on Apple Silicon (arm64) and, if possible,
Intel (x64) before shipping the daemon as default on macOS. See ADR 0006.

## Why it should already work on macOS (code review)
- **Runtime:** launched via `ELECTRON_RUN_AS_NODE` off `process.execPath` — same on macOS.
- **Transport:** on non-Windows the daemon uses a **unix domain socket** in the per-user
  runtime dir (`$XDG_RUNTIME_DIR` or `~/Library/Application Support/MoggingLabs/run/v1`),
  dir `0700`, socket `chmod 0600`, endpoint `0600`.
- **Shell:** `PaneSession` uses `$SHELL` with `-l` (login) on non-Windows.
- **PTY:** `@lydell/node-pty` ships a Darwin (forkpty) prebuild — no toolchain needed.
- **Detach:** `detached:true` + `unref` + stdio→logfile; on Unix a detached child in a new
  session survives the parent (no Windows job-object concern).

## Checklist (run on a Mac)
1. `npm ci` (pulls the Darwin `@lydell/node-pty` prebuild).
2. **Build:** `npm run typecheck` (0) + `npm run build` (emits `out/main/daemon.js`).
3. **App-level survival:** `MOGGING_SURVIVE=A <electron> .` then `MOGGING_SURVIVE=B <electron> .`
   -> result JSON `pass:true`, `had:true`, `sameDaemon:true` (agent outlives quit+relaunch).
4. **OSC parity:** adapt `scratchpad/oscparity.cjs` (use the mac endpoint path + `$SHELL`) ->
   states `idle,attention,busy,idle`.
5. **Auth boundary:** adapt `scratchpad/securitytest.cjs` -> wrong token `error:auth`+closed,
   right token `welcome`. Also confirm the socket is `0600` and the dir `0700` (`ls -l`).
6. **Terminal parity:** `MOGGING_SMOKE=1 npm run dev` (daemon default) -> `pass:true`
   (reflow/scrollback/copy/webgl). And `MOGGING_INPROC=1` forces in-proc.
7. **No orphan:** after tests, no stray daemon (`pgrep -fl daemon.js`); it self-idle-shuts-down.

## Divergences to watch
- Login-shell startup files (`.zprofile`/`.zshrc`) can print noise / slow spawn — confirm the
  terminal smoke still measures the grid.
- `$XDG_RUNTIME_DIR` may be unset on macOS -> falls back to `~/Library/Application Support`.
- If any check fails, note it here and revisit before flipping the daemon default on macOS.
