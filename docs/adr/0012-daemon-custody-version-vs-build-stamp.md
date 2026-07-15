# ADR 0012 — Daemon custody: a compatibility version, a build stamp, and a janitor

- **Status:** accepted (2026-07-15)
- **Extends:** ADR 0006 (detached PTY daemon) · ADR 0008(h) (the custody rule)
- **Context found live:** updating v0.11.0 → v0.11.1 on the first real machine

## Context

Three failures surfaced in one afternoon, and they are one root cause wearing three masks:
**the daemon is spawned from the installed executable, outlives the app by design, and lives
in a version-named directory nothing ever cleans.**

1. **The stale-code hole.** `DAEMON_PROTOCOL_VERSION` names the runtime dir, so an app update
   reconnects to the surviving daemon whenever the version didn't move — a process still
   running *last release's code*. v0.11.1 fixed a tracker bug that lives inside the daemon and
   changed no wire; without intervention the fix would have reached nobody until reboot. The
   interim fix — bump the version anyway, and widen the wire-fingerprint gate to daemon
   behaviour files — worked once and scaled catastrophically: it turned the protocol version
   into a build counter, minting an immortal `run/v<N>` per tracker edit.
2. **The graveyard.** Nothing deleted a retired version's runtime dir, ever. The first machine
   audited carried eight of them — 31 MB — each holding a dead daemon's 48-char auth token
   (a secret with no lifecycle; ADR 0008(h) forbids exactly this shape) and a `sessions.db`
   of stale terminal scrollback.
3. **The update lock.** A running process holds a Windows lock on its own exe. The daemon runs
   from the installed exe, so the installer closed the app, found one more unclosable process
   on that exe, and stalled forever on "cannot be closed … Retry" — about a windowless
   process the user cannot see.

## Decision

**(a) The version answers compatibility; the stamp answers currency.** `DAEMON_PROTOCOL_VERSION`
moves only when an old daemon *cannot speak* to the new app (a state it cannot emit, a message
it cannot answer) — each move mints a new dir and runs the migrate-and-retire hand-off. The
**build stamp** (`backend/platform/build-stamp.ts`) is a content hash of the daemon bundle,
self-taken by the daemon at startup into `endpoint.json` and compared by the app against the
bundle it would spawn. A mismatch — including a missing stamp, which is definitionally old
code — retires the daemon **in place**: graceful shutdown (`persistNow` flushes the store),
fresh spawn, cold-start restore, same dir. Bytes, not a bumpable constant: the failure mode
this removes is a human forgetting to bump.

**(b) The janitor sweeps at every boot, after migration.** Dead, strictly-older, same-channel
`run/v<N>` dirs are deleted whole — token, store, logs. Three refusals, each absolute: never
the current or a future version, never a foreign channel, never a live pid (that is a running
older release; ADR 0006's anti-kill-server stance protects it). Liveness errs toward keeping.
Deleting the whole dir is deliberate (Pedro's call): after migration its sessions were carried
forward, and for never-migrated orphans nobody will ever read them; a downgrade to that
version was already degraded the moment its daemon was retired.

**(c) The installer never meets a live daemon.** Primary: the updater retires the app's own
daemon (gracefully, losslessly) before `quitAndInstall`, and quiescence stops the reconnect
loop from resurrecting it — covering both the restart click and `autoInstallOnAppQuit`.
Second line, for hand-run installers: `customCheckAppRunning` closes windowed instances
gracefully, then force-stops whatever remains on the exe name. Hard, bounded loss (~2s of
scrollback tail, the store's write coalescing) — an install that cannot proceed is strictly
worse.

## Consequences

- Daemon *behaviour* fixes ship without burning versions or minting dirs; the stamp delivers
  them automatically, including to daemons predating the stamp.
- The wire-fingerprint gate returns to guarding wire *shape* only, with two documented
  resolutions: bump (incompatible) or re-pin with justification (additive-tolerant).
- Dev daemons restart on next launch after any rebuild that changes the daemon bundle —
  sessions restored via the store, agents via resume. More correct, slightly more churn.
- A machine's run root converges to: the live dir, plus any dir a live older daemon still
  owns. The 31 MB graveyard (and its dead tokens) is reclaimed on first boot.
- Gated by `MOGGING_DAEMONCUSTODY`: the stamp function, the sweep's full refusal matrix, and
  the real lifecycle — spawn, doctored-stamp retire-in-place, pre-install quiescence.
