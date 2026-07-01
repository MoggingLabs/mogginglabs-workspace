# `ui/features/templates` — provider-mix workspace templates (06b)

Open a whole workspace from a **template** — a named mix of providers ("2× Claude + 1× Codex +
1× Gemini"). The total pane count picks the 05 grid; each slot launches its assigned CLI via 06,
self-authenticated (BYO — ADR 0002).

- `templates.client.ts` — IPC: `list` (presets + custom), `resolve` (mix → grid + assignments),
  `save`; reuses 06 `detect` to disable uninstalled providers.
- `index.ts` — the `UiFeature`: a "Templates" dialog (presets + a count stepper per provider,
  live grid preview); "Open workspace" resolves the mix and hands a spec to the workspace-open
  service.

## How it composes 05 + 06 (decoupled)
It **reuses**, never reimplements:
- `resolveLayout(mix)` (backend) picks the grid + pads with `shell` — 05's grid sizes.
- `openWorkspaceFromTemplate(spec)` (`@ui/core/workspace/open-service`) → the **workspace**
  feature creates the workspace, persists the per-slot assignments, and launches each slot's CLI
  via the **agent-launch port** (`@ui/core/agents/launch-port`) → the **agents** feature (06).
- On relaunch, the workspace feature restores the assignments and re-launches the lineup (resume).

Templates never import `workspace` or `agents` internals — only `@contracts` + those ports.
Persistence is metadata only (providers + counts + per-slot provider) — never credentials.
