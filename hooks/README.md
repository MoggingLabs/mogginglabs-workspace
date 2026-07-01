# First-party agent hooks — `mogging notify`

These are **opt-in** config snippets that let an agent CLI explicitly raise its pane's attention in
MoggingLabs Workspace — a richer signal than OSC escape sequences alone. When Claude/Codex/Gemini
**finishes** or **needs your input**, it runs `mogging notify`, and the pane's tab starts ringing
(and its badge flips to attention) so you know exactly which of many agents needs you.

OSC-based agent-state stays the baseline for *any* CLI (Phase-2/01); these hooks are the sharper,
first-party layer for the CLIs that support hooks.

## How it works

- The MoggingLabs daemon spawns each pane with two env vars: `MOGGING_PANE_ID` (which pane this is)
  and `MOGGING_DAEMON_ENDPOINT` (the path to the daemon's endpoint file).
- `mogging notify --event <event>` reads those, connects to the daemon over its **authed** local
  socket (same token handshake as everything else), and raises that pane's attention.
- The payload is an **event label** (+ an optional short message) only — **never** credentials or
  terminal/prompt content (ADR 0002). If the pane wasn't spawned by MoggingLabs, `mogging notify`
  detects the missing env and silently no-ops (it never fails the agent).

### Events

| event | pane state | typical trigger |
|-------|-----------|-----------------|
| `needs-input` | attention | the agent is waiting on you (permission / a question) |
| `done` | attention | the agent finished its turn |
| `busy` | busy | long-running work started (softer, non-ringing) |
| `idle` | idle | back to idle |

## Prerequisite

`mogging` must be on your `PATH` (the same requirement as `mogging .`). If it isn't, replace
`mogging` in the snippets with the absolute path, e.g. `node /path/to/MoggingLabs/bin/mogging.mjs`.

## Install (pick your CLI)

Each snippet **merges** into your existing config — don't overwrite the whole file; add the `hooks`
(or `notify`) key. All are user-level and reversible (delete the key to uninstall).

- **Claude Code** → merge [`claude-code/settings.json`](./claude-code/settings.json) into
  `~/.claude/settings.json` (or a project's `.claude/settings.json`).
- **Codex** → add the `notify` line from [`codex/config.toml`](./codex/config.toml) to
  `~/.codex/config.toml` (must be user-level; Codex ignores a project-level `notify`).
- **Gemini CLI** → merge [`gemini/settings.json`](./gemini/settings.json) into
  `~/.gemini/settings.json` (best-effort — requires a Gemini CLI version with hook support).

## Verify

In a MoggingLabs pane, run `mogging notify --event needs-input` by hand — the pane's tab should
ring immediately. Then install a snippet and let the agent trigger it on its next turn.
