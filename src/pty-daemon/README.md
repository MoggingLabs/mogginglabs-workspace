# `src/pty-daemon` — detached PTY daemon

The independent, detached process that **owns the PTYs** and survives a main-process crash
**and** an app restart (incl. auto-update). The Electron app is a thin **client** that
reconnects to it on each launch. See `docs/adr/0006-detached-pty-daemon.md`.

## Why a separate process (not a utilityProcess)
A `utilityProcess` is a *child* of main and dies with it — it can't survive a main crash.
Only a truly detached process can. This daemon is spawned `detached` + `unref`ed via
**Electron-as-Node** (`ELECTRON_RUN_AS_NODE=1`, `process.execPath`), so it needs no system
Node and reuses the app's `@lydell/node-pty` prebuilt.

## Files
- `index.ts` — entry: single-instance lock, endpoint, idle auto-shutdown, wiring.
- `session.ts` — `SessionManager` + `PaneSession`: owns node-pty, per-pane scrollback ring
  buffer, multi-client fan-out, id-guard.
- `transport.ts` — socket/named-pipe server: framing + version + auth-token handshake.
- `lifecycle.ts` — per-user/per-version runtime dir, atomic lock (stale takeover),
  endpoint discovery file, logging.
- Protocol contract lives in `@contracts/daemon` (shared with the app client).

## Hardening (ADR 0006)
- **Versioned** socket/pipe + protocol → an app update starts its own daemon; never speaks
  an incompatible protocol to an old one (no tmux "kill-server").
- **Secured** transport: OS perms (unix `0700`/`0600`) / current-user named pipe + a random
  **auth-token** handshake; unauthenticated connections dropped in ~3s.
- **No zombies:** single-instance lock, stale takeover, idle auto-shutdown.
- **No live-fd transfer across versions:** recovery across an update uses agent `--resume` +
  scrollback snapshots (ties to Phase-1/03 persistence).

## Status
Survival core proven (Windows). Remaining per ADR 0006 §Staged: app client + integration,
app-level survival smoke, Windows pipe SID / unix perms audit, version-skew migration, macOS.
