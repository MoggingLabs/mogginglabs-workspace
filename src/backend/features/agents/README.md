# backend/features/agents (Phase 1)

Home for agent-CLI adapters — one small module per hosted CLI (Claude Code, Codex,
Gemini, Aider, OpenCode) describing how to launch it, its resume flag, and any
first-party hook wiring for reliable state signals.

**Never** put provider credentials here — adapters only build the *command* to run;
each CLI authenticates the user's own account itself (see docs/adr/0002).

Suggested shape: `registry.ts` (adapter registry) + `<cli>.adapter.ts` per CLI.
