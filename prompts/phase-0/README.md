# Phase 0 — Runtime Validation (the parity gate)

Sequenced task prompts to get **MoggingLabs Workspace** running and pass the Phase-0
parity gate. **Execute in order.** Each file is self-contained (its own goal, steps,
files, Definition of Done, and green-checks). This README carries the shared context
that applies to all of them.

> Part of the sequenced master prompts — see [`../README.md`](../README.md) for the full phase
> map (0 → 4) and where the cross-cutting sets (`observability/`, `features/`) fit.

> **Do NOT start Phase 1 until every step's gate below is green.**

## Goal
Get the app to launch and prove one terminal pane hosts a real coding-agent CLI with
identical, reliable rendering — Windows (ConPTY) first, macOS (forkpty) when a Mac is
available. This validates the Electron + xterm.js + node-pty engine choice (ADR 0001)
before any Phase-1 work. Compilation is already green; the app has never been run.

## Current state (don't redo)
- Repo: `<workspace root>` (git `master`, uncommitted).
- Layered/feature-sliced architecture; aliases `@contracts` / `@backend` / `@ui` (see `docs/adr/0004-layered-feature-sliced-architecture.md`).
- `npm install` -> exit 0 (461 pkgs). `npm run typecheck` -> exit 0 (32 source files, all layers).
- **Key gap:** `node-pty` was built against system Node, not Electron's ABI — fixed in step `00`.

## Sequence
| # | File | Gate |
|---|------|------|
| 00 | `00-native-rebuild.md` | node-pty rebuilt against Electron's ABI; typecheck still green |
| 01 | `01-first-launch-smoke.md` | `npm run dev` opens the window with zero console errors |
| 02 | `02-terminal-core.md` | shell spawns; input/output/resize/copy-paste/scrollback; WebGL or fallback |
| 03 | `03-host-agent-cli.md` | `claude` runs as a full TUI, self-authenticated |
| 04 | `04-agent-state-osc.md` | titlebar chip flips idle/busy/attention from OSC |
| 05 | `05-reliability-reload.md` | renderer reload does NOT kill the running agent |
| 06 | `06-parity-and-build.md` | Windows parity; macOS checklist; `npm run build`; boundary re-grep |

## Overall Definition of Done (the gate)
- `npm run dev` launches with **zero console errors** (main + renderer).
- A pane hosts the real login shell (profile/PATH intact) with working input/output/resize/copy-paste/scrollback; WebGL active or graceful fallback.
- `claude` (or another agent CLI) runs as a full TUI, self-authenticated.
- Agent-state chip transitions idle <-> busy <-> attention from OSC.
- **Renderer reload does not kill the running agent** (reliability proven).
- Windows verified; macOS parity pass or documented gap.
- No layer-boundary regressions; no provider auth brokered.

## All checks that must be green
- `npm install` -> exit 0
- native rebuild (`electron-builder install-app-deps` **or** `npx @electron/rebuild -f -w node-pty`) -> exit 0
- `npm run typecheck` -> exit 0 *(regression guard, re-run after each step)*
- `npm run dev` -> launches; manual acceptance checklist passes
- `npm run build` -> succeeds (all three `out/*` bundles emitted)
- Boundary re-grep clean: `backend` imports no `@ui`/`electron`; `ui` imports no `@backend`/`node-pty`/`electron` (only `node-pty` lives in `backend`)

## Files to look into (full map)
- `package.json` — rebuild/postinstall; confirm `main: ./out/main/index.js`.
- `electron.vite.config.ts` — alias resolution must also work in the dev server.
- `src/main/window.ts` — dev loads `ELECTRON_RENDERER_URL`; preload path `../preload/index.js`; hardened `webPreferences`.
- `src/main/index.ts`, `src/main/electron-context.ts` — backend compose + ipc binding.
- `src/preload/index.ts` — generic `window.bridge` + `AllChannels` allowlist; survives `sandbox: true`.
- `src/renderer/index.html` (CSP) + `src/renderer/main.ts` (`import '@ui'`).
- `src/ui/features/terminal/terminal-pane.ts` + `terminal.client.ts` — xterm/webgl/fit + spawn/write/resize.
- `src/backend/features/terminal/pty.service.ts` + `src/backend/platform/shell.ts` — node-pty spawn, env, login shell.
- `src/backend/features/agent-state/osc-parser.ts` — OSC 9/99/777/133/7 detection.

## Guardrails / non-goals (apply to every step)
- **Do not start Phase 1** (multi-pane, workspace tabs, SQLite, Kanban) until this gate is green.
- Respect ADR 0004 layer boundaries and ADR 0002 (never store/broker provider credentials).
- Keep the PTY in a process separate from the renderer (ADR 0003) — don't move it into the UI to "simplify."
- If rendering/input diverges Win vs Mac or WebGL is unusable -> **STOP and revisit ADR 0001 before Phase 1.**

## Next after this gate
Phase 1: multi-pane grid + workspace tabs; extract the PTY into a persistent
`src/pty-host` utilityProcess; SQLite persistence/restore; agent launcher for the CLI
roster; code-signing/notarization. (See `docs/02-mvp-and-roadmap.md`.)
