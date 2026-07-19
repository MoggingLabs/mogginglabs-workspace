# Control API — scripting the fleet (`mogging …`)

tmux-grade scriptability from any shell (Phase-3/01). The `mogging` CLI talks to the
**local PTY daemon** over its existing authed socket — the same one the app and
`mogging notify` use. One control plane, no TCP, nothing new listens.

## Verbs

| Command | Does | Exit codes |
|---|---|---|
| `mogging list` | Enumerate live panes: `ID SIZE STATE TITLE` (state = idle/busy/attention; title = the launch label, e.g. `claude`) | `0` ok |
| `mogging send <pane> <text…> [--no-enter]` | Type text into a pane; appends Enter unless `--no-enter`. Completion is confirmed via a pipelined ping (ordered stream). | `0` ok · `1` unknown pane |
| `mogging send-key <pane> <key>` | Press a **named** key from the allowlist | `0` ok · `1` unknown pane · `2` unknown key |
| `mogging capture <pane> [--lines N]` | Print the pane's retained scrollback tail (≤ 10000 lines, default 1000) to **stdout** | `0` ok · `1` unknown pane |
| `mogging cwd [path]` | Declare the current pane's primary checkout/worktree (`.` by default). The next shell prompt retires it. | `0` ok · `1` rejected · `2` invalid/outside pane · `3` unavailable · `4` auth refused |
| `mogging map [--budget N]` | Print the workspace brain's ranked repo map for the current checkout to **stdout** — file paths + definition signatures under a character budget (200–16000, default 4000), stamped `[repomap: generation N, X/Y files]`. Rides the app endpoint (the brain lives app-side). | `0` ok · `1` no brain for this cwd |
| `mogging recall [--limit N] <task…>` | Print the team memories ranked against a task's text to **stdout**, one hit per line (`slug` TAB `score` TAB `name — description`, best first, ≤ 20) — the same deterministic `recall_memories` ranking agents get, so scripts and hooks can pre-brief a pane without MCP. Rides the app endpoint. | `0` ok · `1` no brain / no memories for this cwd |
| `mogging [<dir>]` | Open/focus a workspace for a directory (deep link) | `0` |
| `mogging notify --event <e>` | Raise the current pane's attention (Phase-2/04; always exits 0 — a hook must never fail its agent) | `0` |

Shared failure codes for the control verbs: `2` usage · `3` no daemon / timeout ·
`4` auth refused.

## Provider-neutral working directory

Pane context does not depend on a provider adapter. While a foreground command owns a pane,
MoggingLabs combines four ordered signals: an explicit `mogging cwd`/MCP declaration, Git's
path-only setup worktree trace, the foreground process's own cwd, and the shell's prompt cwd.
The prompt retires command-scoped evidence. Unknown executables receive no provider branding,
usage integration, or resume capability merely because their path was observed.

Command lines are used transiently only for strict known-adapter identity and are dropped. Git
setup tracing retains paths, not argv. A program whose intended checkout exists only in its own
memory exposes no OS fact that a terminal can infer; any CLI can cover that case by calling
`report_working_directory` through the bundled MCP server or `mogging cwd <path>`.

## Key names (`send-key`)

`enter` `tab` `escape` `backspace` `space` `up` `down` `left` `right` `home` `end`
`page-up` `page-down` `c-c` `c-d` `c-z` `c-l` `c-u` `c-r`

This is a **closed allowlist** resolved to control bytes inside the daemon
(`CONTROL_KEYS` in `src/contracts/daemon/protocol.ts`). The CLI only ever transmits the
*name*; arbitrary escape-sequence synthesis from a CLI argument is rejected (`badkey`).

## Auth & discovery model

- The daemon writes a discovery record to
  `%LOCALAPPDATA%\MoggingLabs\run\v<PROTOCOL>\endpoint.json` (Windows) /
  `$XDG_RUNTIME_DIR/MoggingLabs/run/v<PROTOCOL>/endpoint.json` or
  `~/Library/Application Support/MoggingLabs/run/v<PROTOCOL>/endpoint.json` —
  file mode **0600**, containing the socket address and a random per-daemon **token**.
- Every connection must open with `hello { v, token }` within ~3s or it is dropped;
  a wrong token gets `error:auth` and a disconnect (CLI exit `4`).
- Inside a pane, `MOGGING_DAEMON_ENDPOINT` (the endpoint **file path**, never the token)
  is pre-set in the environment; from any other shell the CLI uses the well-known path.
- Transport is a **named pipe** (Windows) or a **0600 unix socket** — local only,
  nothing listens on TCP.
- Because the runtime dir is versioned, the CLI pins the protocol version it speaks
  (`PROTOCOL_VERSION` in `bin/mogging.mjs`, kept in sync with
  `DAEMON_PROTOCOL_VERSION`); older daemons keep running untouched (ADR 0006).

## Privacy & safety

- `capture` output goes to the **caller's stdout only** — it is terminal content and
  never enters telemetry, app state, or logs (ADR 0002/0005).
- Control messages carry ids, key *names*, and the bytes you chose to type — the daemon
  never echoes credentials and the CLI never brokers auth.
- The daemon survives app restarts (ADR 0006), so scripts keep working while the UI is
  closed — `mogging list` is also the quickest way to see what's still alive.

## Examples

```sh
mogging list
mogging send 101 "git status"
mogging send-key 101 c-c
mogging capture 101 --lines 200 | grep error
```

Smoke: `MOGGING_CONTROL=1 npm run dev` (isolated via `scripts/qa-smokes.sh`) — drives
the real CLI as a child process and asserts list/send/interrupt/capture plus the
auth/key/pane refusals.

## The MCP server speaks these verbs too

Phase-8/02–03, widened by Board v2. The house MCP server (`bin/mogging-mcp.mjs`)
exposes the same control plane to an *agent* as tools: `list_panes`/
`capture_pane`/`mail_read`/`list_owners`/`list_board`/`get_card` are the reads,
and `send_to_pane`/`send_key`/`mail_send`/`claim_files`/`release_files` plus the
board's full CRUD (`update_card`/`create_card`/`claim_card`/`release_card`/
`comment_card`/`archive_card`) are the writes — the fleet writes byte-identical
to the CLI verbs above (`send_to_pane` *is* `mogging send`), the board writes
funneled through main's one writer (revision CAS + the claim rule, docs/18). The
difference is the boundary: an agent's writes are gated by a per-workspace grant
(`'none'` by default — invisible and refused), where the CLI speaks over the
daemon's already-authed socket. Same daemon, no wire change. See **docs/14 —
Integrations** for the catalog, grants, and scoping.
