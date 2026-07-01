# 05 — Workspace tabs + `mogging .` launcher + themes

**Prereq:** `04` green. **Shared context:** see `README.md`.

## Goal
Multiple color-coded **workspace tabs** (each = a project dir + its pane layout), a
`mogging .` launcher to open a workspace for any directory, and a small theme system.

## Steps
1. **`src/ui/features/workspace/`** — a tab bar: new / close / switch; `Cmd/Ctrl+T`,
   `Cmd/Ctrl+1..9`. Each tab is a workspace (dir + layout tree from `04`).
2. **`mogging .` launcher** — a CLI shim (`package.json` `bin`) + deep link (`mogging://`)
   that opens/focuses a workspace for the given directory; preserve the user's shell config.
3. **Themes** — an xterm theme + app-chrome theme set; a picker; persist the choice (via
   `03`'s store).
4. **Restore** — tabs/workspaces restored on relaunch (persistence from `03`).

## Files
- `src/ui/features/workspace/**`, `src/main/` (deep link `mogging://` + the `mogging` bin),
  `src/contracts/ipc/workspace.ipc.ts`, `package.json` (`bin`).

## Definition of Done
- Create/switch/close multiple workspace tabs; each keeps its own layout.
- `mogging .` from a shell opens a workspace for that directory.
- Themes apply and persist across relaunch.

## Checks that must be green
- Workspace smoke: open 2 workspaces, switch, relaunch -> both restored -> green.
- `npm run typecheck` -> 0; `npm run build` -> ok; boundaries clean.

## Guardrails
- Decoupled feature; BYO auth unaffected. No secrets in persisted workspace state.
