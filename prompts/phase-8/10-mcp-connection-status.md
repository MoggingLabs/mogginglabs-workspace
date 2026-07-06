The app must KNOW, not assume: is each connected tool actually LIVE for
each CLI — and does the terminal reflect it? 06/07 observe one-shot;
this step makes connection state a continuously-known, pushed signal —
registered → connected → needs-auth → error → drift — surfaced where the
user works, with one-click repair. Observation only: the CLIs own their
connections and tokens; we read their status output, never their stores.

## Steps
1. **The connection registry** (`@backend/features/integrations/
   status.ts`): per (server × CLI), `McpConnStatus { serverId, cli,
   state, detail?, checkedAt }`. Sources, cheapest first: config
   presence + drift hash (06); the CLI's OWN list/status command
   (execFile, headless, timeout, parsed per-server — Claude Code's
   `mcp list` prints it; per-CLI parse = capability-table data,
   dev-verified, 7/01); vault/env slot presence for key servers (08).
   NO interactive-TUI scraping; NO vendor-endpoint probing.
2. **The poller**: the usage-seam discipline — jittered cadence (default
   15m), refresh on Settings-open, after every Authorize/apply, on
   demand; per-CLI backoff; paused while hidden. Snapshots pushed over
   IPC like usage — grid and chips repaint, never re-fetch.
3. **Propagate to the terminal**: each pane knows its CLI → a quiet MCP
   chip in the pane header (connected count; needs-auth/error flips the
   attention treatment). The workspace view aggregates. RESTART-NEEDED
   is first-class: MCP configs are read at CLI launch — a pane whose
   spawn predates the last config write gets "restart to pick up {n} new
   tools"; one click restarts via the existing relaunch path.
4. **Stays-signed-in honesty + one-click repair**: a successful
   Authorize lands persistent copy — "Connected — stays signed in for
   future sessions; the token lives with {cli}; revoke there or remove
   the server here." `needs-auth` (read from the CLI's own output) shows
   ONE button: Re-authorize → 07's flow. No silent re-auth — a browser
   consent is the user's to give.
5. **MCPSTATUS smoke** (`MOGGING_MCPSTATUS`, env-gated, in qa-smokes.sh):
   FIXTURE CLI shims (scripted executables echoing list output):
   (a) registered-only → `registered`; (b) shim ok → `connected`, chip
   count right; (c) shim auth-failure → `needs-auth` + attention chip +
   Re-authorize rendered; (d) out-of-band edit → `drift`; (e) pane
   spawned THEN a server applied → restart nudge, restart clears it;
   (f) hidden window pauses the poller; (g) grep: no token, tool list,
   or server URL in any log/telemetry — states + counts only. Verdict
   `out/mcpstatus-result.json`; zero network.

## Files
- `@backend/features/integrations/status.ts` · pane-header chip
  (`src/ui/features/workspace/`) · `settings/integrations.ts` ·
  `src/contracts/` (state union) · mcpstatus-smoke.ts · qa-smokes.sh ·
  gallery (chip states, both themes)

## Definition of Done
- Dev-verified (books, dated): real Claude Code + one OAuth server — the
  grid shows `connected` from the CLI's own output; revoking at the
  vendor flips `needs-auth` on the next poll; Re-authorize repairs it;
  no other login ever repeated.
- A pane opened before a Connect shows the restart nudge; after restart
  the agent lists the new tools (frames).
- MCPSTATUS gate green; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; MILESTONE + PERCEPTION rerun.

## Guardrails
- OBSERVATION only: the CLIs' own status commands + our config hashes —
  never a vendor endpoint, a token store, or a TUI scrape (0002).
- States and counts are the whole vocabulary: no server URL, tool name,
  or token detail in telemetry, logs, or events (ADR 0005).
- The poller costs nothing at rest: jitter, backoff, hidden-pause;
  PERCEPTION is the proof.
- Repair is always a USER action: needs-auth renders a button, never an
  auto-spawned browser.
