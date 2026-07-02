# 01 — Control API core: `mogging list / send / send-key / capture`

**Prereq:** Phase 2 green. **Shared context:** `README.md` (this folder) +
`src/contracts/daemon/protocol.ts` + `bin/mogging.mjs` + ADR 0006.

## Goal
tmux-grade scriptability from ANY shell: enumerate panes, write input, send named keys,
and capture scrollback — over the daemon's existing authed socket. This is the wedge's
"scriptable" leg: an agent (or the user) can drive the fleet without touching the UI.

## Steps
1. **Protocol** (`src/contracts/daemon/protocol.ts`): bump `DAEMON_PROTOCOL_VERSION`;
   extend `ClientMessage` with `{ type:'list' }` (exists — enrich reply), `{ type:'input',
   id, data }` (exists), `{ type:'send-key', id, key }` and `{ type:'capture', id,
   lastLines? }`. `ServerMessage`: `panes` gains `{ id, cols, rows, title?, cwd?,
   state }` per pane; add `{ type:'captured', id, data }`. Keys map to control bytes in
   the DAEMON (`enter`→`\r`, `c-c`→`\x03`, `escape`, `up/down/left/right`, `tab`) — an
   allowlist, never arbitrary escape synthesis from the CLI arg.
2. **Daemon** (`src/pty-daemon/`): implement the new messages. `capture` returns the
   daemon's retained scrollback tail (cap `lastLines` ≤ 10000). All messages require the
   existing token handshake — no new auth surface.
3. **CLI** (`bin/mogging.mjs`): subcommands `list` (table: id, size, state, title),
   `send <pane> <text...>` (appends `\r` unless `--no-enter`), `send-key <pane> <key>`,
   `capture <pane> [--lines N]` (stdout). Discover the endpoint exactly like
   `mogging notify` does (`%LOCALAPPDATA%/MoggingLabs/run/v1/endpoint.json`).
4. **Docs:** `docs/06-control-api.md` — verbs, key names, exit codes, and the auth model
   (local socket + token file; nothing listens on TCP).
5. **Smoke** (`MOGGING_CONTROL`, wired in `src/main/index.ts` + `scripts/qa-smokes.sh`):
   boot isolated → create a workspace via dev handles → run the real `bin/mogging.mjs`
   as a child process: `list` shows pane 1; `send 1 "echo CTRL_7788"` → pane text
   contains the marker; `send-key 1 c-c` interrupts a `ping -t`/`sleep`; `capture 1`
   stdout contains the marker. Write `out/control-result.json`; exit 0/1.

## Files
- `src/contracts/daemon/protocol.ts` · `src/pty-daemon/*` (message handlers)
- `bin/mogging.mjs` · `docs/06-control-api.md`
- `src/main/control-smoke.ts` + `src/main/index.ts` + `scripts/qa-smokes.sh`

## Definition of Done
- From a plain terminal: `mogging list` → real panes; `send`/`send-key`/`capture` work
  against a live agent pane; wrong/absent token → refused.
- Works against a SURVIVING daemon after app restart (ADR 0006 posture intact).

## Checks that must be green
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean.
- `MOGGING_CONTROL` smoke green (isolated); `MOGGING_NOTIFY` still green (same socket).

## Guardrails
- One control plane: the daemon socket. No TCP, no second server, no UI bypass of auth.
- `capture` output goes to the CALLER's stdout only — never into telemetry, state, or
  logs (it is terminal content).
- Key names are an allowlist; reject unknown keys with a clear error.
