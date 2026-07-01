# Phase 2 — Agent awareness

Sequenced task prompts for Phase 2 of **MoggingLabs Workspace**: make a wall of agents
*legible* — see who needs you at a glance, navigate long sessions, and never freeze. Same
format as `prompts/phase-1/` (each step is self-contained + pasteable as a `/goal`). Execute in
order; each step file is < 4000 chars.

> **Do NOT start Phase 2.5 (memory graph) until every step's gate is green** on Win + Mac.

## Where Phase 1 left us
- Repo live; Electron + xterm(WebGL) + node-pty (from source); detached PTY daemon; SQLite
  persistence/restore; multi-pane grid; workspace tabs + `mogging .` + themes; agent launcher +
  provider-mix templates; signed/auto-updating packaging. An OSC agent-state chip + per-pane
  badge already exist (Phase-0/04, Phase-1/06) — this phase HARDENS OSC and adds the awareness
  layer on top of it.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-osc-hardening-and-attention.md` | **DONE**: split-safe OSC parser (9/777/133/7); workspace-tab attention rings + latch + clear-on-focus; dock/taskbar badge (smokes green) |
| 02 | `02-command-blocks.md` | Warp-style collapsible command blocks (exit color, time, search) |
| 03 | `03-per-pane-git.md` | per-pane branch + dirty, read-only |
| 04 | `04-mogging-notify-and-hooks.md` | `mogging notify` socket + first-party Claude/Codex hooks |
| 05 | `05-perf-and-milestone.md` | 16 agents, attention at a glance, nothing freezes (perf gate) |

## Overall Definition of Done
- OSC 9/99/777/133/7 parsed reliably; per-pane + per-tab attention ("which agent needs me").
- Command blocks make long sessions navigable; per-pane git visible; `mogging notify` + hooks
  raise the right pane.
- The 16-agent milestone passes within a hard perf budget.
- Architecture intact; boundaries clean; ADR 0002 upheld (no content/credentials in signals).

## Global checks (every step)
- `npm run typecheck` -> 0; `npm run build` -> ok.
- Boundary re-grep: backend no `@ui`/electron; ui no `@backend`/node-pty/electron.
- Relevant env-gated smoke green; no PTY output/credentials in any telemetry/state/notify.

## Guardrails
- **OSC over hooks** (works for any CLI); hooks are the richer opt-in (Claude/Codex).
- Never freeze the main thread; the perf budget gates features (research §8 risk #1).
- Never broker provider auth (ADR 0002); keep `@backend` Electron-free.

## Gate -> Phase 2.5
Phase 2 green -> Phase 2.5 (the local **memory graph** differentiator: `.memory/` wikilink graph
+ MCP tools). See `docs/02-mvp-and-roadmap.md`. Cross-cutting `prompts/observability/` (Sentry
shipped in 1/07; consent-UI + PostHog pending a Settings surface) and
`prompts/features/auth-settings.md` (Phase 4) are NOT part of Phase 2 — see `prompts/README.md`.
