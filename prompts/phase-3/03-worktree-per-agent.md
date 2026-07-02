# 03 — Worktree-per-agent isolation

**Prereq:** `01` green (02 independent). **Shared context:** `prompts/phase-3/README.md`
+ `src/backend/features/git/` (read-only status machinery) + the wizard Agents step.

## Goal
Parallel agents on ONE repo trample each other. Give each agent pane its own **git
worktree** (own branch, own working dir) so N agents work the same repo safely — the
roadmap's first orchestration pillar, and the setup for 04's diff review.

## Steps
1. **Backend** (`src/backend/features/worktrees/`, Electron-free): `createWorktree(repo,
   { branchPrefix })` → `git worktree add <repo>/.mogging/worktrees/<slug> -b
   mogging/<slug>` (slug = short random; NEVER task text); `listWorktrees(repo)`;
   `removeWorktree(repo, path, { force:false })` → refuses when dirty unless forced.
   Shell out via `execFile` (no shell-string interpolation).
2. **Contracts**: `WorktreeChannels = { create:'worktrees:create', list:'worktrees:list',
   remove:'worktrees:remove' }` + payload types (`WorktreeInfo { path, branch, dirty }`).
   Register a main handler module (`src/main/worktrees.ts`) like `registerGit`.
3. **Wizard** (Agents step): per-agent toggle **"Isolate in a git worktree"** (enabled
   only when the Start folder is a repo — reuse the `git:query` probe). On launch, for
   each isolated agent pane: create the worktree first, then launch the agent with the
   worktree path as its cwd (extend `AgentLaunchRequest`/`TemplateWorkspaceSpec` with
   `cwd` per-slot overrides — assignments stay provider ids; the worktree path is
   runtime state, not a persisted assignment).
4. **Pane surface**: the existing branch chip already shows the worktree branch via the
   git port — assert it. Pane ⋯ menu gains **"Remove worktree…"** (guarded: confirm +
   refuses dirty without an explicit second confirm). Workspace close does NOT delete
   worktrees (work survives — 04 reviews it).
5. **Persistence**: `WorkspaceStateMeta.paneCwds?: string[]` (per-slot cwd override) so a
   restored workspace re-attaches panes to their worktrees. Metadata only.
6. **Smoke** (`MOGGING_WORKTREE`): temp repo → wizard-path open with 2 isolated shell
   panes (via `__mogging.templates.open` extension or dev handle) → assert: two
   worktrees exist under `.mogging/worktrees/`, each pane's git chip shows its
   `mogging/<slug>` branch, `git -C <repo> worktree list` agrees, removal refuses while
   dirty and succeeds clean. Result JSON + qa-smokes entry.

## Files
- `src/backend/features/worktrees/` · `src/contracts/ipc/worktrees.ipc.ts` + channels
- `src/main/worktrees.ts` + `src/main/index.ts` · wizard + agents feature touches
- `src/main/worktree-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- Two agents on one repo, each in its own worktree/branch, visible per pane; restore
  re-attaches; removal is safe-by-default. Repo HEAD/index untouched by setup.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean (git exec stays in @backend).
- `MOGGING_WORKTREE` green isolated; `MOGGING_GIT` still green.

## Guardrails
- Only `git worktree add/list/remove` — never checkout/reset/merge here (04 owns merges).
- `execFile` with arg arrays (no shell injection); slugs random, never user/task text.
- BYO-auth untouched; worktree paths never enter telemetry (they are paths).
