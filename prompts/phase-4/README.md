# Phase 4 — Differentiators: the swarm

Sequenced task prompts for Phase 4 of **MoggingLabs Workspace**: from *directing* a fleet
to letting the fleet **coordinate itself** — under rules a human sets and a reviewer gate
a human owns. Roles, a shared mailbox, exclusive file ownership, reviewer-gated merges,
provider profiles with usage-limit failover, and remote (SSH) panes. Same format as
`prompts/phase-1..3/` (each step self-contained + pasteable as a `/goal`). Execute in
order; each step file is < 4000 chars.

> Scope per `docs/02-mvp-and-roadmap.md` → **Phase 4 — Differentiators**: multi-agent
> swarm (roles / exclusive file ownership / shared mailbox / reviewer gate), multi-profile
> switching + usage-limit failover, SSH/remote runtimes, Linux. **Voice** and the
> **built-in browser** stay out of this pack (own packs later, once the swarm holds).

## Where Phase 3 left us
- Scriptable fleet: daemon protocol v2 (`mogging list/send/send-key/capture`) + layout
  verbs over the validated deep-link relay (`open/layout/focus/expand/close-pane`).
- Worktree-per-agent isolation (random `mogging/<slug>` branches, base recorded);
  pre-ship review (backend redaction, text-node rendering, guarded `merge --no-ff`);
  local Kanban board whose cards launch agents (task = first prompt, live attention).
- Budgets enforced: machine (`MOGGING_MILESTONE`, 150 ms/30 fps/300 MB) + perception
  (`MOGGING_PERCEPTION`, ≤100 ms interactions, zero >100 ms frames). Full sweep 18/18.
- Boundaries: `@contracts` ← `@backend`/`@ui`; BYO-auth (ADR 0002); card/mail text is
  user content (ADR 0005: local only).

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-swarm-roles-and-mailbox.md` | **DONE**: daemon protocol v3 (mail-send/mail-read/set-role, PaneInfo.role, 16 KB body cap, 500-msg ring); `Mailbox` on the session registry (roles die with their pane); CLI `mogging mail send/read [--json]` + `mogging role` (implicit in-pane identity via MOGGING_PANE_ID); wizard Swarm preset (architect·2 workers·reviewer) + per-slot `roles` through spec→controller→persistence (restore keeps the manifest) + `.pane-role` chips; MOGGING_SWARM green (chips, in-pane send → as-pane read w/ from+role, bogus-role exit 1, fake-token exit 4, v2-hello refused, 502-flood → exactly 500 retained) + CONTROL & NOTIFY still green (control-smoke's endpoint path now derives from DAEMON_PROTOCOL_VERSION) |
| 02 | `02-file-ownership-ledger.md` | Exclusive path claims per agent: `mogging claim/release/owners`; conflicting claims refused; per-pane chip (smoke green) |
| 03 | `03-reviewer-gate.md` | Merges require a reviewer sign-off (`mogging approve` from the reviewer pane / typed human override); board lanes follow (smoke green) |
| 04 | `04-profiles-and-failover.md` | Named provider profiles (env POINTERS, never secrets); `usage-limit` notify → failover relaunch on the next profile (smoke green) |
| 05 | `05-remote-runtimes-ssh.md` | An SSH pane is a first-class pane: host chip, graceful git/cwd degradation, mixed local+remote workspaces (smoke green) |
| 06 | `06-swarm-milestone-and-linux.md` | End-to-end swarm demo asserted (2 workers + reviewer on one repo: mailbox, ownership, gated merges) + Linux build target; budgets unchanged |

## Overall Definition of Done
- A 3-agent swarm on ONE repo coordinates through the mailbox, never edits the same
  file (ledger-enforced), and NOTHING merges without the reviewer gate.
- Profiles switch/fail over without the app ever seeing a credential (ADR 0002).
- A remote pane behaves like a local one at a glance (state, attention, title, host).
- `bash scripts/qa-smokes.sh` green end to end, including the new gates; the machine
  AND perception budgets unchanged.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok.
- Boundary re-grep: backend no `@ui`/electron; ui no `@backend`/node-pty/electron/node.
- The step's env-gated smoke green **via `scripts/qa-smokes.sh` isolation**
  (`MOGGING_USERDATA` + `LOCALAPPDATA` at temp dirs).
- No mail content, claim paths, profile env values, hostnames, or credentials in
  telemetry/logs (counts + booleans only, ADR 0005).

## Guardrails
- **The daemon socket stays the one control plane** — mailbox/claims/approvals extend
  `ClientMessage`/`ServerMessage` in `src/contracts/daemon/protocol.ts` (bump to v3);
  no second server, no renderer parsing of raw CLI input.
- **Coordination is data, not magic**: the mailbox is a message bus — never inject
  text into a pane the user didn't ask for; agents PULL via `mogging mail read`.
- The reviewer gate extends 3/04's review; merge stays the only mutating repo verb.
- Profiles are pointers (names + env var names/dirs). Storing, copying, or echoing a
  secret anywhere is a hard stop (ADR 0002).

## Parallelization
Three lanes after 01 lands: **A:** 02 → 03 (ledger, then gate) · **B:** 04 (profiles) ·
**C:** 05 (SSH). 06 needs A complete (B/C recommended); it freezes the sweep.
