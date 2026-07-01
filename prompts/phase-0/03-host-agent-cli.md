# 03 — Host a real agent CLI (the actual product test)

**Prereq:** `02` green. **Shared context:** see `README.md`.

## Goal
Run a real coding-agent CLI inside the pane as a full TUI. This is the whole point of
the product — the terminal must host `claude` (and peers) exactly as a native terminal
would, with the CLI authenticating **itself**.

## Steps
1. In the pane, run `claude` (Claude Code). If unavailable, use `codex`, `gemini`, or
   `aider`.
2. Confirm full TUI behavior:
   - alt-screen switches (the agent's full-screen UI takes over and restores on exit),
   - truecolor / 256-color,
   - raw-mode keys (arrows, Ctrl-C, Esc, Enter) behave,
   - scrollback and redraw are correct.
3. Confirm it authenticates as itself (its own login / subscription / key) — **the app
   never brokers or stores provider credentials** (ADR 0002).

## Files
- `src/backend/features/terminal/pty.service.ts` (env passthrough, `xterm-256color`)
- `src/backend/platform/shell.ts` (login shell so the CLI is on PATH)

## Definition of Done
- `claude` (or another agent CLI) runs as a full, interactive TUI in the pane.
- It is self-authenticated; no provider credentials touch the app.

## Checks that must be green
- The agent CLI launches, renders its TUI correctly, and accepts input.
- Manual confirmation: no credential handling in app code paths (ADR 0002 respected).

## Guardrails
Never add provider-auth brokering to make this "easier." Hosting the official CLI is
the design (ADR 0002).
