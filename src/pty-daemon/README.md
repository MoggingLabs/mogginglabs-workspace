# `src/pty-daemon` — detached PTY daemon

The independent, detached process that **owns the PTYs** and survives a main-process crash
**and** an app restart (incl. auto-update). The Electron app is a thin **client** that
reconnects to it on each launch. See `docs/adr/0006-detached-pty-daemon.md`.

## Why a separate process (not a utilityProcess)
A `utilityProcess` is a *child* of main and dies with it — it can't survive a main crash.
Only a truly detached process can. This daemon is spawned `detached` + `unref`ed on the
**standalone Node helper** (`resources/node-helper/mogging-node`, ADR 0016 — it used to be
Electron-as-Node until the RunAsNode fuse was dropped), so it needs no system Node; the
helper carries its own `node-pty`/`better-sqlite3` built for its ABI
(`@backend/platform/native-require` picks them per host).

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
Shipped and THE DEFAULT since Phase 1: production daemon, app integration, app-level
survival (quit+relaunch, same daemon pid), OSC agent-state parity, version-skew migration
(`src/main/daemon-migrate.ts` — live capture + retire + reseed), the ADR 0012 build-stamp
retire-in-place, and the security audit below. `MOGGING_INPROC` forces the in-proc backend;
a daemon start failure degrades to it automatically (src/main/boot.ts).

### Security audit (step 6, verified)
- **Auth token enforced** — a wrong/absent token is rejected (`error:auth`) and the socket is
  dropped within ~3s; only the correct token gets a `welcome`.
- **Unix** — socket `0600`, runtime dir `0700`, endpoint file `0600`.
- **Windows** — named pipes reject remote clients by default; local access is gated by the
  token, whose endpoint file lives in the per-user ACL-protected `LOCALAPPDATA`. A native
  single-SID pipe DACL is a future nice-to-have (Node exposes no API for it); the token +
  protected file are the security boundary today.
- **Versioned** protocol + per-version socket prevents cross-version confusion.
