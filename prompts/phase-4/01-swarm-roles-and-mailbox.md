Agents coordinating through the human is a bottleneck; agents coordinating through
shared state is chaos. Give the fleet a **mailbox**: a daemon-mediated message bus
panes read/write via `mogging mail`, plus a **swarm manifest** that names each pane's
role — the substrate 02 (ownership) and 03 (reviewer gate) build on.

## Steps
1. **Protocol v3** (`src/contracts/daemon/protocol.ts`, version-bump + handshake):
   `SwarmRole = 'architect' | 'worker' | 'reviewer'`;
   `MailMessage { id, from: PaneId, role?, to?: PaneId | 'all', body, ts }`.
   ClientMessage += `mail-send { to, body }`, `mail-read { since? }`,
   `set-role { paneId, role }`; ServerMessage += `mailed { id }`, `mail { messages }`,
   `role-set`. Mail body cap 16 KB; ring buffer of 500 messages per daemon (memory
   only — mail is coordination, not a database; it dies with the daemon by design).
2. **Daemon** (`src/pty-daemon/`): a `Mailbox` owned by the session registry: append,
   read-since (id cursor), per-pane role map (enriches `PaneInfo.role`). `from` is the
   AUTHENTICATED connection's pane binding when present (env `MOGGING_PANE`), else 0
   (external/human). No pane output parsing anywhere.
3. **CLI** (`bin/mogging.mjs`): `mogging mail send [--to <pane>|all] <text...>`,
   `mogging mail read [--since <id>] [--json]`, `mogging role <pane> <role>`.
   Exit codes: 0 ok · 2 usage · 3 no daemon · 4 auth (same table as `send`).
   Inside a pane, `--from` is implicit via `MOGGING_PANE`.
4. **Swarm template**: the wizard's Agents step gains a "Swarm preset" (architect +
   2 workers + reviewer as a `ProviderMixTemplate` with roles); `openWorkspaceFromTemplate`
   spec += optional `roles?: (SwarmRole | null)[]` per slot → daemon `set-role` after
   spawn. Role shows as a small chip next to the pane state dot (`.pane-role`).
5. **Smoke** (`MOGGING_SWARM`): isolated boot → 2-pane workspace with roles set →
   `mogging mail send --to all "PING_4242"` from pane 1 (in-pane, via `mogging send`)
   → `mogging mail read` from pane 2 returns it (assert body + from + role) → role
   chips render (`.pane-role`) → auth: a copied endpoint with a fake token gets exit 4
   → cap: message 501 evicts message 1. Result JSON + qa-smokes entry.

## Files
- `src/contracts/daemon/protocol.ts` (v3) · `src/pty-daemon/mailbox.ts` + `transport.ts`
  + `session.ts` (role in PaneInfo) · `bin/mogging.mjs`
- wizard/template touches + `src/ui/features/terminal/terminal-pane.ts` (role chip)
- `src/main/swarm-smoke.ts` + `src/main/index.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- Two panes coordinate through the daemon: send from one, read from the other, roles
  visible per pane — zero polling, zero pane-output parsing, zero UI injection.
- `mogging mail` works from inside panes (implicit identity) and from outside (human).

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_SWARM` green isolated; `MOGGING_CONTROL` + `MOGGING_NOTIFY` still green
  (same socket, bumped protocol — old-version hello must be rejected cleanly).

## Guardrails
- Mail body is USER/AGENT content: local ring buffer only — NEVER telemetry, logs,
  notify payloads, or persisted state (ADR 0005). Events may count messages, not quote.
- The mailbox never pushes: no writes into any PTY. Agents pull with `mail read`.
- One control plane: extend the existing socket protocol; no new server, no new port.
