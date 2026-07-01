# Phase 1 — MVP core

Sequenced task prompts to turn the validated Phase-0 spike into the MVP: multi-pane
**workspaces** backed by a **persistent PTY-host**, **SQLite** persistence/restore, an
**agent launcher**, and **signed/notarized** distributables — without breaking the
layered architecture or ADR 0002 (never broker auth). Same format as `prompts/phase-0/`.
Execute in order; each file is self-contained.

> **Do NOT start Phase 2 until every step's gate is green** on Windows + macOS.

## Where Phase 0 left us (context)
- Repo live: **github.com/MoggingLabs/mogginglabs-workspace** (private, `main`).
- Electron + xterm.js(WebGL) + `@lydell/node-pty`; layered architecture (`contracts` /
  `backend` / `ui` + thin app-wiring); backend is Electron-free.
- Proven end-to-end (steps 00–06): real terminal, Claude Code TUI hosting +
  self-auth (ADR 0002), OSC agent-state chip, renderer-reload survival (PTY in main).
- Reusable smoke suite: `MOGGING_SMOKE` / `MOGGING_AGENT` / `MOGGING_STATE` / `MOGGING_RELOAD`.
- Known gaps this phase closes: reloaded pane starts blank (→ scrollback restore),
  single hardcoded pane (→ layout), main-reload not covered (→ persistent pty-host),
  no packaging/signing.

## Sequence
| # | File | Gate |
|---|------|------|
| 00 | `00-commit-to-github.md` | repo committed + pushed under MoggingLabs (**DONE**) |
| 01 | `01-ci-and-hygiene.md` | CI (typecheck+build on Win+Mac) green; `.gitattributes` LF |
| 02 | `02-persistent-pty-host.md` | **detached PTY daemon** (ADR 0006), now the **DEFAULT** — agents survive a main crash + app restart (**DONE**; macOS runtime-verify + version carry-over pending) |
| 03 | `03-sqlite-persistence-and-restore.md` | workspaces/layout/cwd + scrollback restore on relaunch; no secrets |
| 04 | `04-multi-pane-layout.md` | split/grid templates, drag-resize; N panes concurrent, isolated |
| 05 | `05-workspace-tabs.md` | multiple workspace tabs; `mogging .` launcher; themes |
| 06 | `06-agent-launcher.md` | one-click launch of a CLI into a pane with cwd; BYO auth |
| 07 | `07-packaging-signing-updates.md` | signed/notarized installers + auto-update for win/mac |

## Overall Definition of Done (Phase 1)
- Multi-pane workspaces with persistent restore (layout + cwd + scrollback).
- Agents survive a **main** reload/crash (persistent pty-host), UI reconnects.
- One-click agent launch for the CLI roster, self-authenticated (never brokered).
- Signed + notarized installers with working auto-update, on Windows + macOS.
- Architecture intact; boundaries clean; ADR 0002 upheld.

## Global checks that must stay green (every step)
- `npm run typecheck` -> exit 0
- `npm run build` -> succeeds (out/main, out/preload, out/renderer)
- Boundary re-grep: `backend` no `@ui`/`electron`; `ui` no `@backend`/`node-pty`/`electron`
- Relevant env-gated smoke green (extend the suite per step)
- **Secret audit**: no provider credentials stored/injected/proxied anywhere (ADR 0002)

## Guardrails (apply to every step)
- Keep `@backend` Electron-free; features decoupled (`docs/04-adding-a-feature.md`).
- **Never broker provider auth** (ADR 0002); agents self-authenticate.
- PTY stays in a process separate from the renderer (ADR 0003).
- No secrets committed; signing certs live only in CI secrets / OS keychain.

## Gate -> Phase 2
MVP core green on Win + Mac -> proceed to Phase 2 (command blocks + OSC hardening) and
Phase 2.5 (the local **memory graph** — the chosen differentiator). See
`docs/02-mvp-and-roadmap.md`. Related: `prompts/features/auth-settings.md` (Phase-4
settings-driven auth) builds on step 06's adapters.
