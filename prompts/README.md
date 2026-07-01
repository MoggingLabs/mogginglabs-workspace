# Prompts — master index

Sequenced master prompts that build **MoggingLabs Workspace** phase by phase. Each phase folder
has a `README.md` (the plan) + numbered step files; every STEP is self-contained and pasteable as
a `/goal` (kept < 4000 chars). Execute a phase in order; don't start the next phase until the
current phase's gate is green (Windows + macOS). Roadmap: `docs/02-mvp-and-roadmap.md`.

## Phases
| Phase | Folder | Status | What |
|---|---|---|---|
| 0 | `phase-0/` | done | Parity spike: one PTY pane hosting a real agent CLI, Win/Mac parity (validates ADR 0001) |
| 1 | `phase-1/` | done | MVP core: daemon PTY-host, SQLite restore, multi-pane, workspace tabs + `mogging .` + themes, agent launcher + provider-mix templates (06b), signed auto-updating packaging |
| 2 | `phase-2/` | planned | Agent awareness: OSC hardening + tab rings, command blocks, per-pane git, `mogging notify` + hooks, 16-agent perf milestone |
| 2.5 | *(future)* | — | Memory graph (the differentiator): `.memory/` wikilink graph + MCP tools |
| 3 | *(future)* | — | Orchestration: worktree-per-agent + diff review, Kanban launcher, control API |
| 4 | *(future)* | — | Differentiators: swarm, SSH/remote, multi-profile accounts, Linux, voice |

## Cross-cutting sets (NOT a single phase)
- **`observability/`** — turn on real Sentry (+ optional PostHog) behind the vendor-agnostic
  telemetry seam. **Placement: cross-cutting** ("Sentry from day one" — roadmap). Its Sentry +
  sourcemaps half **already shipped in Phase-1/07** (opt-in adapter + release-time upload). The
  remaining **consent UI + PostHog** attach to a **Settings surface**, which first appears in
  **Phase 4** (`features/auth-settings`) — do them alongside that (or as a small standalone
  consent pass). Default OFF; ADR 0005.
- **`features/auth-settings.md`** — Settings → "Accounts": one-click sign-in that ORCHESTRATES
  each CLI's own login (never brokers auth — ADR 0002). **Placement: Phase 4** ("multi-profile
  account switching"). Run after Phase 1. NOTE: this is one large prompt (~8.8k chars) — split it
  into < 4000-char steps when Phase 4 is scheduled.

## Why neither is Phase 2
Phase 2 is *agent awareness* — making a wall of agents legible. Observability is foundational /
cross-cutting, and account-settings is a later differentiator; neither is on the Phase-2 critical
path, so both are deferred to where they belong (see each set's README).
