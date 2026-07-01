# 01 — First launch smoke (npm run dev)

**Prereq:** `00` green. **Shared context:** see `README.md`.

## Goal
`npm run dev` opens the Electron window with **zero errors** in both the main-process
console and the renderer DevTools console. This is where the new layered wiring is
proven at runtime (it only passed *type*-check so far).

## Steps
1. `npm run dev` (electron-vite). Confirm the window appears.
2. Open renderer DevTools; watch the main-process terminal output.
3. Confirm `window.bridge` exists in the renderer console and exposes `invoke/send/on`.
4. Work through the most likely first-run failure points (see Files) and fix in place.

## Likely failure points (check these first)
- Alias `@ui` / `@contracts` / `@backend` not resolving in the **dev server** (vite
  `resolve.alias` must match `tsconfig` paths — they do, but verify at runtime).
- Sandboxed preload (`sandbox: true`) importing `@contracts` — the `AllChannels` const
  must be **inlined/bundled** into the preload, not required at runtime.
- CSP in `index.html` blocking the module script or xterm styles.
- `import '@ui'` in `src/renderer/main.ts` not resolving under the electron-vite renderer root.
- Preload path in `window.ts` (`../preload/index.js`) not matching the electron-vite output.

## Files
- `electron.vite.config.ts`, `src/main/window.ts`, `src/main/index.ts`,
  `src/main/electron-context.ts`, `src/preload/index.ts`,
  `src/renderer/index.html`, `src/renderer/main.ts`.

## Definition of Done
- Window launches; **no errors** in main or renderer consoles.
- `window.bridge` is present; the app shell (titlebar + empty pane host) renders.

## Checks that must be green
- `npm run dev` -> window launches, zero console errors
- `npm run typecheck` -> exit 0 *(regression guard after any wiring fix)*
