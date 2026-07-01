# `ui/features/agents` — agent launcher (BYO auth)

One-click launch of a coding-agent CLI (Claude Code, Codex, Gemini, Aider, OpenCode) into a
pane at the workspace cwd (Phase-1/06). The CLI **authenticates itself** — the app never
touches credentials (ADR 0002).

- `agents.client.ts` — IPC: `detect()` (installed CLIs) + `command()` (build the launch string)
  hit the backend adapters; `launchInto()` writes the command into a pane via the terminal channel.
- `index.ts` — the `UiFeature`: a "Launch agent" picker in the titlebar listing installed CLIs;
  picking one launches it into the **focused pane**.

## How a launch works
The backend (`@backend/features/agents`) builds a **command string** — `cd <cwd> && <cli>` — and
the launcher writes it into the focused pane's shell. The CLI takes over the pane as a TUI and
self-authenticates. No credential is ever built, stored, injected, or proxied.

## Decoupling (guardrail)
Never imports `workspace` or `terminal`. It finds the target pane via the ui-core **focus port**
(`@ui/core/layout/focus`, published by `workspace`) and labels it via the **pane-meta port**
(`@ui/core/layout/pane-meta`, rendered by each `TerminalPane` next to its OSC state chip). The
per-CLI adapters live in Electron-free `@backend/features/agents` and are shared with the
settings-driven auth feature.
