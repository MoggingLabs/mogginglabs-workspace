# backend/features/agents (Phase 1/06)

Agent-CLI adapters — how to detect + launch each hosted CLI (Claude Code, Codex, Gemini,
Aider, OpenCode). Pure + Electron-free; shared with the settings-driven auth feature
(`prompts/features/auth-settings.md`).

- `adapters.ts` — the `AgentAdapter` registry (`AGENT_ADAPTERS`): `{ id, name, bin, resumeFlag }`.
- `detect.ts` — `detectAgents()` / `isOnPath()`: which CLIs are installed (PATH scan; sees the
  process PATH, so a login-shell-only rc entry may be missed — the PTY's login shell still runs it).
- `launch.ts` — `buildLaunchCommand(agentId, cwd, resume)`: the `cd <cwd> && <cli>` command
  string (platform/shell-aware); an optional session id makes the resume exact (ADR 0013).
- `session-pool.ts` — sessions follow profiles (ADR 0013): before a launch, union the cwd's
  session transcripts from the provider's other config homes into the launch home (whole
  files at the CLIs' documented paths, newer-wins, 30-day bound), so a profile failover
  resumes the same conversation on the next subscription.
- `title.ts` — the pane-title layer: per-CLI map of each provider's OWN "what am I doing"
  title signal (the pane header renders OSC 0/2 titles), plus the codex launch args that
  pin its live-tested item mix; gemini's share rides `geminiSystemSettings` (notify-hook.ts).

**Never** put provider credentials here — adapters build the *command* only; each CLI
authenticates the user's own account itself (ADR 0002). Main exposes `detect` + `command` over
IPC (`src/main/agents.ts`); the launcher UI (`src/ui/features/agents`) writes the returned
command into the focused pane, where the CLI takes over as a self-authenticated TUI.
