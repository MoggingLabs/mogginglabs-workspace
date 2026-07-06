Now the pen: the write half of the catalog — send, mail, claims, card
updates — behind the per-workspace grant (default OFF). A prompt-injected
agent must not drive its neighbors just because a server is registered;
the grant gates the CATALOG, the reviewer gate stays the boundary, and
`approve` remains a human verb forever.

## Steps
1. **Grant storage + IPC** (`@backend/features/integrations`): persist
   `WorkspaceIntegrationsGrant` (this step enforces `writeTools`, default
   `'none'`; 04 enforces `web`/`actOrigins`) with the other workspace
   settings, migrating 6/05b's consent boolean into `web`; IPC
   `integrations:grant:get/set` + a push event. Editing UI lands in 06's
   section — this step ships storage and a minimal toggle only if free.
2. **Grant enforcement in the server**: on session start, resolve the
   workspace via the daemon (pane identity → its workspace; `human`
   sessions outside a pane → no write tools, period). `tools/list`
   includes a write tool ONLY if granted (ungranted = invisible, not
   listed-but-refused); `tools/call` re-checks the LIVE grant per call so
   a revoke lands mid-session; emit `notifications/tools/list_changed` on
   flips. The wire is the APP endpoint (`grantGet`/`grantChanged` — 6/05b's
   transport, ours to extend); the daemon stays v3, grant-blind.
3. **The write tools** (dispatch from catalog data, as in 02):
   `send_to_pane {pane, text, noEnter?}` and `send_key {pane, key}` → the
   daemon's send/send-key (closed key allowlist verbatim — the server
   never synthesizes escapes); `mail_send {to, body}` → the mailbox (16 KB
   cap, sender = pane identity); `claim_files`/`release_files` → the
   ledger, denial names the owner exactly like exit-5; `update_card
   {card, column?, note?}` → the board verb the daemon already speaks.
   Tool errors mirror CLI wording.
4. **Receipts through the house notify system**: a granted write lands a
   subtle attention event on the TARGET pane's header/card ("MCP: sent by
   pane 102"). The same emission feeds 05's trail once it lands — one
   receipt, two sinks: instrument via a thin `recordTrail()` stub, no-op
   until 05. Counts only in telemetry (ADR 0005); args/bodies never.
5. **MCPWRITE smoke** (`MOGGING_MCPWRITE`, env-gated, in qa-smokes.sh):
   fixture world + scripted frames — write tool INVISIBLE and refused with
   grant `'none'`; visible + working with `'all'` (send → text arrives,
   pipelined-ping confirmed; claim → second session denied, owner named);
   revoke mid-session → next call refused + list_changed; `approve` absent
   from every tools/list frame; human session gets no write tools. Verdict
   via `out/mcpwrite-result.json`.

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
  smoke greps structurally (docs/09: humans own the review gate).
- Write tools add NO daemon capability: same verbs, allowlists, caps as
  the CLI — if a tool wants more, it's out of scope (protocol v3).
- The grant is workspace-scoped and revocable live; no global "allow all
  workspaces" switch in v1.
- Every write is attributable: pane identity travels with the call and
  lands in the receipt — anonymous writes don't exist.
