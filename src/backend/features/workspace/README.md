# backend/features/workspace (Phase 1)

Home for the workspace/session feature: the SQLite session store, layout-tree
persistence, per-pane cwd + last-agent tracking, and restore-on-relaunch.

**To build it (parallel-safe):**
1. Add `WorkspaceChannels` + payload types in `src/contracts/ipc/` and spread into `AllChannels`.
2. Add `workspace.service.ts` (pure logic) + `workspace.module.ts` (a `FeatureModule`) here.
3. Register it in `src/backend/bootstrap.ts`.

Nothing outside this folder + the contract slice + one bootstrap line changes.
