# 03 — Per-pane git status (read-only)

**Prereq:** `01` green (OSC 7 cwd). **Shared context:** `README.md`.

## Goal
Each pane shows its repo's **branch + dirty state**, read-only — so you see at a glance which
agent is on which branch and whether it has uncommitted work. NO git mutations.

## Steps
1. **cwd tracking** — from OSC 7 (step 01) the pane's current directory is known; fall back to
   the workspace cwd. Track cwd changes per pane.
2. **Git probe (backend, Electron-free)** — `src/backend/features/git/`: given a cwd, resolve the
   repo root + `{ branch, ahead, behind, dirty }` (spawn `git`, or read `.git/HEAD` + a cheap
   `git status --porcelain`). Debounced + cached per repo; refresh on cwd change / file change
   (fs watch or poll). READ-ONLY — never write.
3. **IPC + UI** — `GitChannels` (query + change events); a per-pane git chip (branch • dirty dot)
   next to the agent badge (06). Updates on cwd change / working-tree change.

## Files
- `src/backend/features/git/**`, `src/contracts/ipc/git.ipc.ts` (+ channels in `channels.ts`),
  `src/main/**` (register), `src/ui/features/terminal/**` (per-pane git chip) or a small
  `ui/features/git` feature wired via the existing ports.

## Definition of Done
- A pane in a repo shows branch + dirty; a branch switch / working-tree edit updates it.
- A pane not in a repo shows nothing (no error).
- Strictly read-only: no git command mutates state (review + grep confirm).

## Checks that must be green
- Git smoke: point a pane at a repo, assert branch/dirty; make an edit -> dirty flips true.
- `npm run typecheck` -> 0; `npm run build` -> ok; boundaries clean.

## Guardrails
- READ-ONLY git. Keep `@backend` Electron-free (spawn git from the backend, no electron).
- Debounce/cache — git probes must not regress the N-pane perf budget.
