# 00 — Rebuild node-pty against Electron's ABI

**Prereq:** none. **Shared context:** see `README.md`.

## Goal
Make `node-pty` loadable inside Electron. `npm install` built it against system Node,
so at runtime Electron would fail to load the native binary (ABI mismatch). Fix this
before attempting to launch.

## Steps
1. Add a rebuild step. Preferred (electron-builder is already a devDep):
   - Add to `package.json` scripts: `"postinstall": "electron-builder install-app-deps"`.
   - Run it: `npm run postinstall` (or re-run `npm install`).
2. Alternative: `npm i -D @electron/rebuild` then `npx @electron/rebuild -f -w node-pty`.
3. **Fallback if the native build fails on this machine** (no VS C++ Build Tools / Python):
   swap to a prebuilt fork `@lydell/node-pty`, but keep the import specifier `node-pty`
   stable by adding an alias in `electron.vite.config.ts` and `tsconfig.json`
   (`'node-pty' -> '@lydell/node-pty'`). Do not edit every import site.

## Files
- `package.json` — add the postinstall/rebuild script.
- *(fallback only)* `electron.vite.config.ts`, `tsconfig.json` — the `node-pty` alias.
- Import sites (for reference, do not scatter changes): `src/backend/features/terminal/pty.service.ts`, `src/backend/platform/process-tree.ts`.

## Definition of Done
- The native rebuild completes without error.
- `node-pty` is built for Electron's ABI (electron-builder/electron-rebuild reports success).

## Checks that must be green
- native rebuild (`electron-builder install-app-deps` or `npx @electron/rebuild -f -w node-pty`) -> exit 0
- `npm run typecheck` -> exit 0 *(regression guard — the fallback alias must not break types)*

## Guardrails
Do not change the PTY architecture here — this is a build/ABI fix only.
