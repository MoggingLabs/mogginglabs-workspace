# ADR 0006 — Detached PTY daemon (survive main crash + app restart)

- **Status:** Accepted (2026-07-01). Supersedes the Phase-1 "utilityProcess" plan noted in
  ADR 0003 for the *survival* goal. Survival core proven by PoC (below); integration +
  hardening staged.
- **Context:** We want running agents to survive a **main-process crash AND an app restart**
  (incl. auto-update). A `utilityProcess` is a *child* of main and is killed when main dies
  — so it **cannot** deliver this (it only isolates backend/native crashes). Only a
  **detached, independent** process (tmux-style) survives. tmux proves the model but has
  pitfalls we must avoid for an auto-updating app.

## Decision
A **detached PTY daemon** owns the PTYs and long-lived session state. The Electron app is a
**thin client** that reconnects to the running daemon on each launch. `@backend`'s
`PtyService` runs *inside* the daemon with a socket-based `BackendContext` (the interface is
unchanged — only the transport changes).

## Proven core (PoC, 2026-07-01, Windows)
A detached Node process holding a `node-pty` PTY **survived its client's death**; a fresh
client reconnected over a **named pipe** with a **version + random auth-token handshake** and
**re-attached to the same running pane** (id-guard => no duplicate). The counter continued
`7 -> 15 -> 22` across the disconnect. `@lydell/node-pty` (N-API prebuilt) runs in a plain-Node
detached process. (PoC in the session scratchpad; to be productionized as `src/pty-daemon/`.)

## Architecture
- **Daemon runtime:** launch via **Electron's own binary as Node** (`ELECTRON_RUN_AS_NODE=1`,
  `process.execPath`) so there is no system-Node dependency; `@lydell/node-pty` (N-API) loads
  under both. Spawned truly detached (`detached:true`, `stdio`->logfile, `.unref()`; `setsid`
  on Unix; `windowsHide` on Win).
- **Transport, secured:** Unix domain socket on macOS (per-user runtime dir, `0700`/`0600`);
  **Windows named pipe restricted to the current user's SID**; PLUS a random **auth-token**
  handshake (token in a `0600` endpoint file) and a **protocol-version** handshake; drop
  unauthenticated connections within seconds.
- **Discovery:** an endpoint file `{ version, pipe/socket, token, pid }` the client reads.
- **Backend inside the daemon:** `@backend` unchanged; a socket `BackendContext` relays
  requests/events. Renderer/preload/UI largely unchanged.

## Anti-tmux hardening (the point)
- **No "kill-server on upgrade":** socket/pipe name + protocol are **versioned per app
  version**. An update starts its *own* daemon; it never speaks an incompatible protocol to an
  old server.
- **No fragile live-fd transfer across versions.** Belt-and-suspenders: the daemon holds live
  PTYs (so a **same-version** restart is a seamless reattach + scrollback repaint) AND persists
  session **metadata + scrollback snapshots**. A version change or a daemon crash recovers via
  agent **`--resume` + snapshot repaint** — **no data loss** (strictly better than tmux's
  kill-server).
- **No zombies / races:** atomic **single-instance lock**, **stale-socket** detection +
  cleanup, PID/liveness, and **idle auto-shutdown** (no panes + no clients for a grace period).
- **Security:** OS perms/SD + auth token + reject-remote + drop-unauthenticated.
- **Robustness:** uncaught-exception handler persists state before exit; the client detects
  daemon death and restarts + recovers via persistence.

## Consequences
- The app is a client; the backend runs in the daemon. A dev **in-proc fallback**
  (backend-in-main, today's path) stays for fast iteration.
- Ties tightly to Phase-1/03 (persistence + `--resume` + `@xterm/addon-serialize` scrollback).
- More moving parts than a utilityProcess — justified only because it's the *only* way to
  deliver true cross-restart survival, and the hardening above removes the classic risks.

## Staged implementation (each independently verified)
1. **[DONE — PoC]** Survival core: detached daemon + transport + version+token handshake +
   reconnect + id-guard (proven above).
2. Production daemon `src/pty-daemon/` built by electron-vite; launched via electron-as-node;
   single-instance lock + endpoint + idle-reap.
3. App client (`src/main/daemon-client.ts`) + backend-in-daemon; app works through the daemon;
   re-verify terminal + all smokes green.
4. **App-level survival:** an agent is alive after **quit + relaunch**; reconnect + scrollback
   repaint; no duplicate.
5. Hardening pass: Windows pipe SD, Unix perms, stale-socket, security audit.
6. Version-skew migration (`--resume` + snapshot) + persistence (Phase-1/03).
7. macOS (forkpty) parity.
