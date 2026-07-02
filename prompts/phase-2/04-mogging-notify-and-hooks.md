# 04 — `mogging notify` socket + first-party agent hooks

**Prereq:** `01` green. **Shared context:** `README.md` + `docs/adr/0006` (the detached daemon).

## Goal
A richer attention signal than OSC alone: a `mogging notify` command + a socket the daemon
exposes, plus first-party Claude/Codex/Gemini hooks that call it — so an agent can explicitly say
"done" / "needs input" and raise the RIGHT pane's attention.

## Steps
1. **Notify endpoint** — the daemon (ADR 0006) accepts `{ paneId?, event, message? }` over its
   existing named-pipe/unix-socket transport (same version + token handshake). It maps the event
   -> a pane attention/state update -> the state/attention ports from step 01.
2. **Pane-id injection** — the daemon injects `MOGGING_PANE_ID` (+ the socket address) into each
   pane's env at spawn, so a command inside a pane can target itself.
3. **`mogging notify` bin** — a subcommand of `bin/mogging.mjs`: `mogging notify --event
   needs-input [--message ...]` reads `MOGGING_PANE_ID` + sends to the socket.
4. **First-party hooks** — ship Claude Code / Codex hook snippets (Stop / Notification hooks)
   that call `mogging notify` on completion / when input is needed; document opt-in install.

## Files
- `src/pty-daemon/**` (notify endpoint + env injection), `src/contracts/daemon/protocol.ts`
  (notify message), `bin/mogging.mjs` (notify subcommand), `hooks/**` (Claude/Codex snippets + docs).

## Definition of Done
- `mogging notify --event needs-input` from inside a pane raises THAT pane's attention (+ its tab).
- A Claude/Codex hook that calls it flips the pane to attention on the relevant event.
- Auth-gated; the payload carries an event/label only — never credentials or PTY content (ADR 0002).

## Checks that must be green
- Notify smoke: spawn a pane, run `mogging notify` in it, assert the pane's state flips to attention.
- `npm run typecheck` -> 0; `npm run build` -> ok; boundaries clean.

## Guardrails
- Socket auth-gated (reuse the daemon token). Notify payload = primitives only, no PTY content.
- OSC stays the baseline (any CLI); hooks are the richer opt-in for Claude/Codex.
