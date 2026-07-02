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
| 02 | `02-file-ownership-ledger.md` | **DONE**: protocol v3 += claim/release/owners (+`claimed`/`claim-denied {owner}`/`released`/pushed `owners`); daemon `Ledger` scoped per workspace ordinal, CONSERVATIVE glob-overlap (only pure-literal divergence separates), auto-release on pane exit, pattern validation (no `..`/absolute/drive, ≤256); CLI `mogging claim` (exit **5** denied w/ owner on stderr) / `release [--all]` / `owners [--json]`, humans-can't-claim (exit 2); push-fed `.pane-claims` chip + ⋯ "Show claims…" modal (zero polling); `docs/09-swarm.md` w/ the agent contract; MOGGING_LEDGER green (grant→deny→disjoint→owners→release→re-grant→exit-auto-release→chip→human/traversal/absolute refused) + SWARM & CONTROL still green |
| 03 | `03-reviewer-gate.md` | **DONE**: protocol v3 += approve/approvals/unapprove (`Approval` memory-only; role resolved DAEMON-side from the pane binding — no payload role field exists); `mergeBranch` gate param checked FIRST (`ungated` refusal; everything else — clean/--no-ff/conflict-pause — unchanged); main consults the daemon fail-CLOSED for diff `approved` flag + merge; worktree removal clears its branch's sign-off; CLI `mogging approve` (exit **6** notreviewer) + `approvals [--json]`; Review modal gate chip + "Override & merge…" demanding the verbatim typed word `override`; REVIEW smoke → human path, ORCHESTRATION loop now includes ungated→role→approve→merged; board ✓-chip deferred to 06 polish (needs branch↔pane plumbing); MOGGING_GATE green (ungated, exit-6, approve, merged, removal-clears, wrong-word stays ungated, verbatim override lands) + REVIEW & ORCHESTRATION still green |
| 04 | `04-profiles-and-failover.md` | **DONE**: `AgentProfile` pointer sets — save boundary enforces env-name allowlist + shell-safe values + THE deny-list (reuses the review redactor: secret-shaped values cannot be SAVED); `app_profiles` table; launch commands gain a platform-aware env prefix (cmd `set "X=…" &&` / pwsh `$env:X=…;` / posix `X=… `), profileId resolved main-side; default = order 0, palette gets per-profile entries when >1; `usage-limit` notify → distinct `terminal:limit` push → manual failover toast / per-workspace auto (palette toggle, in-memory) → ^C + relaunch SAME pane w/ resume, one hop per event; wizard picker deferred (palette/pane-menu cover choice); MOGGING_PROFILES green (deny-list refusal, env A in pane, toast, auto-failover to B, scrollback survives) + NOTIFY green + AGENTLAUNCH green after INTENTIONAL modernization for Claude Code 2.1.19x (renders on the normal buffer now: TUI detected via protocol signals — alt-screen OR kitty-keyboard OR sync-output — plus onboarding auto-answer resilience) |
| 05 | `05-remote-runtimes-ssh.md` | **DONE**: `RemoteHost` pointers (`app_remotes`; shape-validated host/user/port — no shell metachars, no auth material EVER); spawn spec carries the MAIN-resolved row (renderer names an id; daemon stays db-free) → daemon spawns `ssh -tt [-p port] [user@]host` as the pane process (arg array; exit of ssh = pane exit; `MOGGING_SSH_SHIM` batch/sh stand-in for networkless smokes); per-slot `remotes` manifest published BEFORE apply (spawn-time), persisted, restored; honesty: git-cwd seed SKIPPED for remote slots (chip absent — a local probe would lie), `.pane-remote` host chip (distinct tint), pane-menu reason note; wizard "Runs on" host select (local folder mutually exclusive); `mogging list` REMOTE column; docs/09 remote §; MOGGING_REMOTE green (argv -tt/-p/user@host, chips, git honesty local-vs-remote, list column, exit semantics) + SMOKE & GIT still green |
| 06 | `06-swarm-milestone-and-linux.md` | **DONE**: `MOGGING_SWARMMILESTONE` asserts the WHOLE swarm on an isolated temp repo — 2 workers (own worktrees) + reviewer, roles set → ledger denies the overlap (owner named) → PING/ACK mailbox handshake (from+role asserted) → each worker commits in ITS territory via real `mogging send` → gate holds (ungated → `mogging approve` from the reviewer → merged; branch 2 via the verbatim typed override) → both changes landed, HEAD clean, approval died with its worktree; Phase B with the swarm up + board visited: **134.7 fps avg · 41.7 ms worst · 21 MB · 11 live panes** vs the unchanged 150/30/300 budget; Linux target (electron-builder AppImage+deb + CI `linux-boot` job: full native install, headless SMOKE under xvfb, package) — built on Linux hosts only (no cross-build from Windows, noted); docs/09 completed (demo + full wire table), roadmap checkboxes, README status |

## Overall Definition of Done — MET (2026-07-02)
- A 3-agent swarm on ONE repo coordinates through the mailbox, never edits the same
  file (ledger-enforced), and NOTHING merges without the reviewer gate. ✅
- Profiles switch/fail over without the app ever seeing a credential (ADR 0002). ✅
- A remote pane behaves like a local one at a glance (state, attention, title, host). ✅
- `bash scripts/qa-smokes.sh` green end to end, including the new gates; the machine
  AND perception budgets unchanged. ✅

## Phase-close sweep record (2026-07-02, `bash scripts/qa-smokes.sh`, fresh isolated state)
**24/24 PASS**: SMOKE · MULTIPANE · ATTENTION · BLOCKS · GIT · NOTIFY · MILESTONE ·
FLICKER · PERCEPTION · PANEOPS · CONTROL · CONTROL2 · WORKTREE · REVIEW · BOARD ·
ORCHESTRATION · SWARM · LEDGER · GATE · PROFILES · REMOTE · SWARMMILESTONE ·
TEMPLATE_A · TEMPLATE_B.
Key numbers: swarm milestone Phase B **134.7 fps avg / 41.7 ms worst / 21 MB heap /
11 live panes** (budget 150 ms / 30 fps / 300 MB, unchanged); perception + machine
gates re-passed in the same sweep — mailbox/ledger/gate chatter costs nothing on the
hot path (pull-based mail, delta ledger pushes, lazy gate checks). Privacy greps
clean: no mail bodies, claim paths, profile values, or hostnames anywhere near
telemetry/logs; daemon coordination modules never log or persist.

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
