# 02 — Detached PTY daemon (survive main crash + app restart)

**Prereq:** `01` green. **Shared context:** `README.md` + `docs/adr/0006-detached-pty-daemon.md`
(and the correction to ADR 0003).

## Goal
Build a **hardened, detached PTY daemon** so running agents survive a **main-process crash
AND an app restart** (incl. auto-update) — not just a renderer reload. A `utilityProcess`
CANNOT do this (it's a child of main and dies with it); only a detached, independent process
can. Engineer it to avoid tmux's pitfalls (version-skew kill-server, socket security,
zombies). See ADR 0006 for the full design.

## Proven core (already done — the risky part)
A PoC verified on Windows: a **detached** Node process holding a `node-pty` PTY **survives its
client's death**; a fresh client reconnects over a **named pipe** (version + auth-token
handshake) and **re-attaches to the same running pane** (id-guard => no duplicate); the counter
continued across the disconnect. `@lydell/node-pty` runs in plain Node. This de-risks the
approach — the steps below productionize + harden it.

## Steps (staged, each independently verified)
1. **[DONE — PoC]** Survival core: detached daemon + pipe/socket transport + version+token
   handshake + reconnect + id-guard.
2. **Production daemon** `src/pty-daemon/` built by electron-vite; launched via **Electron as
   Node** (`ELECTRON_RUN_AS_NODE=1`, `process.execPath`); single-instance **lock** + endpoint
   file + **idle auto-shutdown**. `@backend`'s `PtyService` runs inside it via a socket
   `BackendContext`.
3. **App client** `src/main/daemon-client.ts` + backend-in-daemon; the app works through the
   daemon (main relays; renderer/preload/UI largely unchanged). Re-verify terminal + all
   existing smokes green.
4. **App-level survival:** an agent is alive after **quit + relaunch** — reconnect + scrollback
   repaint + no duplicate. (New smoke.)
5. **Hardening:** Windows named-pipe **security descriptor** (current-user SID), Unix socket
   perms (`0700`/`0600`), stale-socket detection + cleanup, security audit (token, reject-remote).
6. **Version-skew migration:** per-version daemon; recover across an update via agent `--resume`
   + snapshot repaint (ties to `03` persistence). **No live-fd transfer across versions.**
7. **macOS (forkpty) parity.**

## Files
- `src/pty-daemon/**` (daemon entry, transport, protocol, lifecycle),
  `src/main/daemon-client.ts`, `src/main/index.ts`, `electron.vite.config.ts` (daemon build
  target), `src/backend/core/ipc/registry.ts` (interface unchanged — the point),
  `docs/adr/0006-detached-pty-daemon.md`.

## Definition of Done
- An agent started in the app is **still running after quit + relaunch**; the relaunched app
  reconnects to the daemon and repaints; no duplicate PTYs.
- Hardened: single-instance, idle-reap, secured transport (SD/perms + token), version-skew
  handled via `--resume`/snapshot (no data loss).
- Architecture intact; `@backend` still Electron-free.

## Checks that must be green
- App-level survival smoke (quit+relaunch -> agent alive + reattached + single PTY) -> green.
- `npm run typecheck` -> 0; `npm run build` -> ok (main/preload/renderer + pty-daemon).
- Boundary re-grep clean; **security audit** (no unauthenticated access; no secrets logged).

## Guardrails
- `@backend` stays Electron-free; PTY strictly out of the renderer; **never broker auth**.
- Do NOT transfer live PTY fds across app versions (fragile); use `--resume` + snapshots.
- Belt-and-suspenders: live daemon for same-version survival + persistence for daemon-crash /
  version-change recovery.
