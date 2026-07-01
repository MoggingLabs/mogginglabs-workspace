# 06 — Cross-platform parity, prod build, boundary regression

**Prereq:** `05` green. **Shared context:** see `README.md`. This is the final gate.

## Goal
Confirm the engine choice holds across OSes, the production build works, and no layer
boundary regressed while fixing runtime issues.

## Steps
1. **Windows parity (now):** run steps `01`–`05` on Windows (ConPTY). Record results.
2. **macOS parity (checklist):** capture the same `01`–`05` checklist to run on macOS
   (forkpty) when a Mac is available. Note any divergence in rendering/input/resize.
3. **Production build smoke:** `npm run build` (electron-vite). Confirm it emits
   `out/main`, `out/preload`, and `out/renderer` with no errors. *(Optional: `npm run dist`
   to produce installers — needs signing config to be warning-free.)*
4. **Boundary re-grep** (no regressions from runtime fixes):
   - `backend` imports no `@ui` and no `electron` (only `node-pty` is expected there).
   - `ui` imports no `@backend`, no `node-pty`, no `electron`.

## Files
- `package.json` (`build`/`dist` scripts, `main` entry)
- `electron.vite.config.ts` (three builds resolve aliases + externalize node-pty)
- `electron-builder.yml` (win/mac targets, native unpack, signing reminders)

## Definition of Done
- Windows: `01`–`05` all green.
- macOS: parity checklist captured (pass, or a documented, tracked gap).
- `npm run build` succeeds with all three `out/*` bundles.
- Boundary re-grep clean.

## Checks that must be green
- `npm run build` -> success (out/main, out/preload, out/renderer emitted)
- `npm run typecheck` -> exit 0
- Boundary grep clean (backend: no `@ui`/`electron`; ui: no `@backend`/`node-pty`/`electron`)

## Gate decision
- **All green + Windows verified -> Phase 0 passes.** Proceed to Phase 1
  (`docs/02-mvp-and-roadmap.md`).
- **Rendering/input diverges Win vs Mac, or WebGL is unusable -> STOP.** Revisit the
  engine choice in `docs/adr/0001-electron-over-tauri.md` before any Phase-1 work.
