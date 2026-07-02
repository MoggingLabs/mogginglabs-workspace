# Phase 3 — Orchestration

Sequenced task prompts for Phase 3 of **MoggingLabs Workspace**: stop just *watching* a
wall of agents — **direct** it. Script the fleet from any terminal, isolate each agent in
its own git worktree, review every diff before it ships, and drive work from a board that
launches agents with task context. Same format as `prompts/phase-1/` and `prompts/phase-2/`
(each step is self-contained + pasteable as a `/goal`). Execute in order; each step file
is < 4000 chars.

> Scope per `docs/02-mvp-and-roadmap.md` → **Phase 3 — Orchestration**: worktree-per-agent
> + pre-ship diff review, Kanban → agent-in-pane, and the Control API (tmux/cmux parity).
> The Phase-2.5 **memory graph** is a separate track and NOT a prerequisite here.

## Where Phase 2 (+ the UI redo) left us
- Detached PTY daemon (authed socket, `mogging notify`, deterministic pane ids
  `ordinal*100+slot`); OSC 9/99/777/133/7 parsed; per-pane state + git chips; command
  blocks; managed WebGL with a hard 16-pane perf budget (`MOGGING_MILESTONE`).
- Launcher-first UI: Home → wizard (Start·Layout·Agents) → live grid; workspace rail with
  numeric attention counts; per-terminal top bar (agent task title via OSC 0/2, branch
  chip, expand modes, close); command palette; Settings; opt-in Sentry/PostHog telemetry.
- Boundaries: `@contracts` ← `@backend`/`@ui`; composition roots only in
  `main`/`preload`/`renderer`; BYO-auth (ADR 0002); daemon protocol in
  `src/contracts/daemon/protocol.ts`.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-control-api-core.md` | `mogging list / send / send-key / capture` drive real panes over the daemon socket (control smoke green) |
| 02 | `02-control-layout-ops.md` | `mogging open / layout / focus / expand / close-pane` drive the UI via a main-process control relay (smoke green) |
| 03 | `03-worktree-per-agent.md` | Wizard/launcher "isolate in worktree" → one git worktree per agent pane, badge shows it, safe cleanup (smoke green) |
| 04 | `04-preship-diff-review.md` | Per-worktree Review surface: secret-redacting, injection-resistant diff + explicit apply/merge guidance (smoke green) |
| 05 | `05-kanban-board.md` | Board view: cards → "Start agent" launches into a pane with task context; card state follows pane attention (smoke green) |
| 06 | `06-orchestration-milestone.md` | End-to-end demo asserted: board card → worktree agent → notify → review → merge, with the Phase-2 perf budget still green |

## Overall Definition of Done
- A scriptable fleet: everything the UI can do to panes/layouts is reachable from a
  shell (`mogging …`), token-authed, never echoing credentials.
- Agents work isolated (worktree each) and NOTHING lands without a human-reviewed diff.
- The board makes "what should the fleet do next" a first-class surface.
- `MOGGING_MILESTONE` + `MOGGING_FLICKER` stay green throughout; boundaries intact.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok.
- Boundary re-grep: backend no `@ui`/electron; ui no `@backend`/node-pty/electron/node.
- The step's env-gated smoke green **via `scripts/qa-smokes.sh` isolation**
  (`MOGGING_USERDATA` + `LOCALAPPDATA` at temp dirs).
- No PTY output, paths, or credentials in any control response, board state, or telemetry.

## Guardrails
- **The daemon socket is the one control plane** — don't invent a second server; extend
  `ClientMessage`/`ServerMessage` in `@contracts/daemon/protocol.ts` (version-bump it).
- Worktrees are the ONLY place the app writes to a repo — and only `git worktree
  add/remove` + guarded merges. Review rendering must be injection-resistant (no HTML
  from diff content) and secret-redacting (deny-pattern pass before display).
- Never freeze the main thread: review diffs + board render off the hot path; the perf
  budget gates every feature.
- Never broker provider auth (ADR 0002). The board stores task text locally — it is
  user content: keep it out of telemetry entirely.
