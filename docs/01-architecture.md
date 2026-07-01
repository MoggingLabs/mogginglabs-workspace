# 01 · Architecture

## Stack

**Electron + xterm.js (WebGL addon) + node-pty**, with a persistent PTY-host process
and a platform-agnostic TypeScript engine. This is VS Code's exact terminal stack.
See [ADR 0001](adr/0001-electron-over-tauri.md) for the Electron-over-Tauri decision.

## Three tiers

### 1. Renderer (Chromium window) — UI only
- **xterm.js** per pane with `@xterm/addon-webgl` (GPU), plus `addon-fit`,
  `addon-search`, and later `addon-unicode11` / `addon-serialize` (scrollback
  snapshots) / `addon-web-links`. DOM renderer as fallback.
- Layout tree (splits/tabs) + a light state store.
- **Security hardening:** `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, no `@electron/remote`. All privileged ops go over typed IPC through
  the preload's single `window.pty` surface.

### 2. PTY-host / engine process — owns everything stateful
> Phase 0 runs the PTY in the **main** process (still separate from the renderer, so
> a UI crash can't kill an agent). Phase 1 moves it into a dedicated, persistent
> `utilityProcess` so even a main reload leaves agents running. See
> [ADR 0003](adr/0003-persistent-pty-host-process.md).

- **PTY spawning (node-pty):** one PTY per pane. Spawn the **login shell**
  (`$SHELL -l` on macOS; `pwsh`/`powershell`/`cmd` on Windows) so the user's config +
  PATH load, then optionally auto-send an agent command. Preserves TUI behavior
  (alt-screen, raw mode, 256/truecolor) that agent CLIs need.
- **Lifecycle:** track pid, cwd, exit code; forward resize (SIGWINCH); kill the whole
  process tree on pane close (Windows: job objects / `taskkill /T`; Unix: process-group
  kill).
- **OSC parser** (`src/engine/osc-parser.ts`) on the raw PTY stream: OSC 9/99/777 →
  "attention"; OSC 133 A/B/C/D → command boundaries + exit code (busy↔idle, command
  blocks); OSC 7 → cwd. Because not every CLI emits OSC, add a fallback quiescence
  heuristic in Phase 2.
- **First-party hook channel (deep integrations):** for Claude Code / Codex, optionally
  install lightweight hooks (`SessionStart`/`Stop`/`Notification`) that call a bundled
  `mogging notify` helper over a local socket / named pipe — the pattern cmux uses.
  OSC works for *any* CLI; hooks give *reliable* signals for the ones we integrate
  deeply. **Never** put provider credentials in hooks.
- **Persistence (SQLite via `better-sqlite3`, Phase 1):** workspaces, layout tree,
  per-pane cwd + agent command, command-block history, optional serialized scrollback.
- **Resume:** live PTYs die with their host, so restore layout + cwd and relaunch
  agents via their own `--resume`/`resume` flags rather than freezing processes.

### 3. Main process
Window/lifecycle, IPC broker, updater, tray, deep links (`mogging://`, `mogging .`).

## Windows / ConPTY specifics to plan for
node-pty uses ConPTY (Win10 1809+) with a winpty fallback. Budget time for resize
races, signal semantics, the occasional TUI that misbehaves under ConPTY, and
**AV/SmartScreen** friction on spawned children + unsigned dev builds — **sign early**.

## Build & distribution
- Native modules (`node-pty`, later `better-sqlite3`) → `electron-rebuild`/prebuilds for
  **win-x64, mac-arm64, mac-x64**. If building native is painful, use a prebuilt node-pty
  fork (`@lydell/node-pty`, `@homebridge/node-pty-prebuilt-multiarch`).
- `electron-builder` (see `electron-builder.yml`); **Apple notarization + hardened
  runtime** and **Windows Authenticode** are mandatory for install-without-warnings;
  `electron-updater` for signed auto-update.
- Sentry crash reporting from Phase 1; a hard **perf budget** (e.g. 16 panes @ 60 FPS,
  capped RAM); throttle/virtualize background panes; cap scrollback.
