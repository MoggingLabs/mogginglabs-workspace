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
| 01 | `01-control-api-core.md` | **DONE**: protocol v2 (send-key/capture + enriched PaneInfo + closed key allowlist); `mogging list/send/send-key/capture` w/ exit codes + well-known endpoint discovery; `docs/06-control-api.md`; MOGGING_CONTROL green (incl. auth exit 4 / badkey exit 2 / nopane exit 1), NOTIFY still green, survival probe verified against a closed app |
| 02 | `02-control-layout-ops.md` | **DONE**: closed `ControlCommand` union + `sanitizeControl` gate in main; verbs ride `mogging://control` through the existing deep-link/single-instance relay (cold + running app); CLI `open/layout/focus/expand/close-pane` (+`--no-launch`); MOGGING_CONTROL2 green (open→expand→focus→close asserted on the real grid + 5 hostile payloads dropped at the gate); ATTENTION + PANEOPS still green |
| 03 | `03-worktree-per-agent.md` | **DONE**: `@backend/features/worktrees` (execFile arg-arrays; add/list/remove ONLY; random slugs; dirty-safe removal + path-containment guard); wizard repo-gated "Isolate each agent in its own git worktree" toggle; per-slot `paneCwds` spec→controller→persistence (restore re-attaches, agents launch in their worktree, chips show distinct `mogging/<slug>` branches); pane ⋯ "Remove worktree…" with force-confirm toast; MOGGING_WORKTREE green (porcelain agrees, dirty refused, HEAD untouched) + GIT still green |
| 04 | `04-preship-diff-review.md` | **DONE**: `@backend/features/review` (merge-base→working-tree diff of committed+uncommitted work, 2 MB cap, base recorded by 03 in the worktree git dir); pure `redact.ts` (PEM/AWS/GCP/GitHub/sk-/Slack/JWT + key=value scrub) runs BEFORE anything leaves the backend; Review modal renders hunks as text nodes only (never innerHTML) with typed-"merge" confirm; merge --no-ff clean-repo-gated, conflicts left paused for a terminal; pane ⋯ + palette entries; MOGGING_REVIEW green (redaction units, planted ghp_/sk- never reach the DOM, `<script>` line stays inert text, dirty→refused / clean→merged / conflict→paused all asserted) + WORKTREE still green |
| 05 | `05-kanban-board.md` | **DONE**: `app_board` table (main-owned sqlite; card text = user content, local db ONLY — grep-verified zero telemetry/notify/log touches); view union +'board' with titlebar Board button (rail stays workspaces-only per user directive), palette `board:open`, Ctrl+Shift+G; four dnd lanes + card editor; card menu "Start <agent> on this…" → worktree-isolated 1-pane workspace via the open/worktree seams, task written as the agent's FIRST prompt over terminal:write, card binds paneId/workspaceId; live state via attention + pane-cwd ports (attention → orange "needs you" chip → jump; close → unbind, persisted); MOGGING_BOARD green (db round-trip across reload, bind, prompt-in-PTY, attention flag, unbind) + ATTENTION + MILESTONE still green |
| 06 | `06-orchestration-milestone.md` | **DONE**: `MOGGING_ORCHESTRATION` asserts the WHOLE loop on an isolated temp repo — card → shell-provider start (worktree created, task = first prompt in the PTY) → scripted `mogging send` edits + plants a fake secret + commits → in-pane `mogging notify` flags card AND rail → `review:diff` shows the change with the secret `«redacted»` → `review:merge` lands the branch → card to done; Phase B re-runs the Phase-2 sampler with board visited + 12 live panes (3 isolated): **130.3 fps avg · 62.5 ms worst gap · 21 MB heap** vs the unchanged 150 ms/30 fps/300 MB budget; `docs/08-orchestration.md` (07 taken by the perception budget) + roadmap checkboxes; full qa sweep green (see below) |

## Overall Definition of Done — MET (2026-07-02)
- A scriptable fleet: everything the UI can do to panes/layouts is reachable from a
  shell (`mogging …`), token-authed, never echoing credentials. ✅
- Agents work isolated (worktree each) and NOTHING lands without a human-reviewed diff. ✅
- The board makes "what should the fleet do next" a first-class surface. ✅
- `MOGGING_MILESTONE` + `MOGGING_FLICKER` stay green throughout; boundaries intact. ✅

## Phase-close sweep record (2026-07-02, `bash scripts/qa-smokes.sh`, fresh isolated state)
**18/18 PASS**: SMOKE · MULTIPANE · ATTENTION · BLOCKS · GIT · NOTIFY · MILESTONE ·
FLICKER · PERCEPTION · PANEOPS · CONTROL · CONTROL2 · WORKTREE · REVIEW · BOARD ·
ORCHESTRATION · TEMPLATE_A · TEMPLATE_B.
Key numbers: milestone 16-pane stress ≈118 fps avg / ≤50 ms worst / ~34 MB heap,
16/16 GL lease cycle; perception switch 29 ms · zoom 23 ms · echo 1.4 ms · zero
>100 ms frames; orchestration Phase B (board + 12 live panes, 3 isolated)
130.3 fps avg / 62.5 ms worst / 21 MB heap vs the unchanged 150 ms/30 fps/300 MB
budget; 1 planted secret redacted end-to-end.

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
