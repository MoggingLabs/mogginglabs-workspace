# backend/features/agents (Phase 1/06)

Agent-CLI adapters — how to detect + launch each hosted CLI (Claude Code, Codex, Gemini,
Aider, OpenCode). Pure + Electron-free; shared with the settings-driven auth feature
(`prompts/features/auth-settings.md`).

- `adapters.ts` — the `AgentAdapter` registry (`AGENT_ADAPTERS`): `{ id, name, bin, resumeFlag }`.
- `detect.ts` — `detectAgents()` / `isOnPath()`: which CLIs are installed (PATH scan; sees the
  process PATH, so a login-shell-only rc entry may be missed — the PTY's login shell still runs it).
- `launch.ts` — `buildLaunchCommand(agentId, cwd, resume)`: the `cd <cwd> && <cli>` command
  string (platform/shell-aware).

**Never** put provider credentials here — adapters build the *command* only; each CLI
authenticates the user's own account itself (ADR 0002). Main exposes `detect` + `command` over
IPC (`src/main/agents.ts`); the launcher UI (`src/ui/features/agents`) writes the returned
command into the focused pane, where the CLI takes over as a self-authenticated TUI.
