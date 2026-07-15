# ADR 0003 — Persistent PTY-host process (separate from the window)

- **Status:** Superseded by [ADR 0006](0006-detached-pty-daemon.md) — the "Later
  (optional)" daemon below shipped as the default and the interim `utilityProcess`
  pty-host was never built (its placeholder `src/pty-host/` has been removed).
  The PRINCIPLE (PTYs never owned by the window) stands and is what 0006 delivers.
- **Context:** Live PTYs die with the process that owns them. BridgeSpace's clearest
  weakness is terminal freezes/crashes; a UI crash that also kills running agents would
  be our worst failure mode. Reliability under many agents is our wedge.

## Decision

PTYs are owned by a **backend process, not the renderer window.** The UI connects to it
and can crash/reload without killing agents; it simply reconnects.

**Rollout:**
- **Phase 0 (now):** PTY lives in the Electron **main** process. Already separate from
  the renderer, so a renderer/UI crash does not kill agents.
- **Phase 1:** extract into a dedicated, persistent **`utilityProcess`** (the PTY-host)
  connected via `MessagePort`. A main-process reload then leaves agents running.
- **Later (optional):** a true always-on daemon that survives full app quit (tmux-style).
  Bigger build; only if the demand is proven.

## Rationale

- Decoupling UI lifetime from agent lifetime is the single most impactful reliability
  decision, and it directly attacks the axis where BridgeSpace bleeds.
- A separate host also gives us a clean seam for the future **control API** (socket +
  `mogging send/list/capture`) and headless/CI operation.

## Consequences

- IPC/serialization overhead between renderer ↔ host (negligible for terminal I/O).
- "Resume across full app/OS restart" is **not** solved by this alone (PTYs still die
  with the host on quit). For restart we restore layout + cwd and relaunch agents via
  their own `--resume`/`resume` flags rather than freezing processes. The survive-quit
  daemon is a separate, later decision.
- Process-tree kill on pane close must be handled per-OS (Windows job objects /
  `taskkill /T`; Unix process-group kill) to avoid orphaned agent children.
