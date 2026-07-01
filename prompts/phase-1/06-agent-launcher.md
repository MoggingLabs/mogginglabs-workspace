# 06 — Agent launcher (CLI roster, BYO auth)

**Prereq:** `04` green (`05` recommended). **Shared context:** `README.md` + `docs/adr/0002-never-broker-provider-auth.md`.

## Goal
One-click launch of a coding-agent CLI (Claude Code, Codex, Gemini, Aider, OpenCode) into
a pane with the workspace's cwd — the agent authenticates **itself** (BYO), the app never
brokers credentials.

## Steps
1. **Adapters** — `src/backend/features/agents/adapters/*` (pure, Electron-free): per CLI,
   `detect()` (installed?), `launchCommand(cwd)`, `resumeFlag`. Shared with the
   settings-driven auth feature (`prompts/features/auth-settings.md`).
2. **Launcher UI** — `src/ui/features/agents/`: a picker of installed CLIs; launching one
   spawns it in the focused/new pane with the workspace cwd; label the pane with its agent.
3. **Per-pane status** — reuse the Phase-0/04 OSC agent-state chip **per pane** so the user
   sees which agents are busy / need attention at a glance ("which agent needs me").
4. **Never broker auth** — the adapter builds the *command only*; the CLI self-authenticates
   (as proven in Phase-0/03).

## Files
- `src/backend/features/agents/**`, `src/ui/features/agents/**` (picker),
  `src/contracts/ipc/agents.ipc.ts` (+ channels).

## Definition of Done
- Pick an installed CLI -> it launches as a TUI in a pane with the correct cwd,
  self-authenticated; the pane shows per-agent state.
- No credential handling in any app code path.

## Checks that must be green
- Agent-launch smoke: drive the picker path to launch `claude`, assert TUI (alt-screen +
  self-auth) -> green.
- `npm run typecheck` -> 0; `npm run build` -> ok; **secret-audit** (no credential handling).

## Guardrails
- **ADR 0002** — never store/inject/proxy provider credentials; adapters build commands only.
- Keep `@backend` Electron-free; the OS-only bits (e.g. opening a browser) live in `src/main`.

> **Complemented by [`06b-provider-mix-templates.md`](06b-provider-mix-templates.md):** provider-mix
> templates ("N panes of provider A, M of provider B") that open a whole workspace and launch each
> pane's CLI via these adapters. 06 stays the single-CLI primitive; 06b composes it (05 + 06).
