Now the pen: the write half of the catalog — send, mail, claims, card
updates — behind the per-workspace grant (default OFF). A compromised or
prompt-injected agent must not be able to drive its neighbors just because a
server is registered; the grant gates the CATALOG, the reviewer gate stays
the boundary, and `approve` remains a human verb forever.

## Steps
1. **Grant storage + IPC** (`@backend/features/integrations`): persist
   `WorkspaceIntegrationsGrant` (01's contract — this step enforces its
   `writeTools` field, default `'none'`; 04 enforces `web`/`actOrigins`)
   with the other workspace settings, migrating 6/05b's browser-consent
   boolean into `web`; IPC `integrations:grant:get/set` + a push event.
   Editing UI lands in 05's Settings section — this step ships storage and
   a minimal toggle only if free.
2. **Grant enforcement in the server**: on session start, resolve the
   workspace via the daemon (pane identity → its workspace; `human` sessions
   outside a pane → no write tools, period). `tools/list` includes a write
   tool ONLY if granted (catalog hygiene: ungranted tools are invisible, not
   listed-but-refused); `tools/call` re-checks the LIVE grant per call so a
   revoke lands mid-session. Emit `notifications/tools/list_changed` when
   the grant flips.
3. **The write tools** (dispatch from catalog data, as in 02):
   `send_to_pane {pane, text, noEnter?}` and `send_key {pane, key}` → the
   daemon's send/send-key (closed key allowlist verbatim — the server never
   synthesizes escapes); `mail_send {to, body}` → the mailbox (16 KB cap,
   sender = pane identity); `claim_files {globs}` / `release_files {globs|
   all}` → the ledger, denial surfaces the owner exactly like exit-5 does;
   `update_card {card, column?, note?}` → the board verb the daemon already
   speaks. Tool errors mirror CLI wording.
4. **Receipts through the house notify system**: a granted write lands a
   subtle attention event on the TARGET pane's header/card ("MCP: sent by
   pane 102") — the human always has a trail. Counts only in telemetry
   (ADR 0005); args and bodies never.
5. **MCPWRITE smoke** (`MOGGING_MCPWRITE`, env-gated, in qa-smokes.sh):
   fixture world + scripted frames asserting — write tool INVISIBLE and
   refused with grant `'none'`; visible + working with grant `'all'`
   (send → text arrives, pipelined-ping confirmed; claim → second session
   denied with owner named); revoke mid-session → next call refused +
   list_changed emitted; `approve` absent from every tools/list frame;
   human session gets no write tools. Verdict via `out/mcpwrite-result.json`.

## Files
- `src/backend/features/integrations/` (grant store + IPC) · server dispatch
  additions (02's file) · notify wiring · `src/main/mcpwrite-smoke.ts` ·
  `scripts/qa-smokes.sh` (gate row)

## Definition of Done
- Grant `'none'` (the default) reproduces step-02 behavior exactly; flipping
  one workspace on exposes writes THERE and nowhere else.
- A dev-verified real-CLI session (books): agent reads the mailbox, claims a
  glob, sends to its own worktree pane — and a second workspace's server
  session saw none of those tools.
- MCPWRITE gate green; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep including the new gate.

## Guardrails
- `approve` is NEVER in the catalog, the dispatch map, or any frame — the
  smoke greps for it structurally (docs/09: humans own the review gate).
- Write tools add NO daemon capability: same verbs, same allowlists, same
  caps as the CLI — if a tool wants more, it's out of scope (protocol v3).
- The grant is workspace-scoped and revocable live; no global "allow all
  workspaces" switch ships in v1.
- Every write is attributable: pane identity travels with the call and lands
  in the receipt — anonymous writes don't exist.
