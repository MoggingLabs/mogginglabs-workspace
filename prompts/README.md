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
| 2 | `phase-2/` | done | Agent awareness: OSC hardening + tab rings, command blocks, per-pane git, `mogging notify` + hooks, 16-agent perf milestone |
| 2.5 | *(future)* | — | Memory graph (the differentiator): `.memory/` wikilink graph — mounts as tools on the phase-8 MCP server |
| 3 | `phase-3/` | done | Orchestration: worktree-per-agent + diff review, Kanban launcher, control API |
| 4 | `phase-4/` | done | Differentiators: swarm (mailbox/roles/ledger/gate), SSH/remote, profiles + failover, Linux target |
| 5 | `phase-5/` | done | UI/UX excellence: token system + workspace identity, icon family, window chrome, full-app views (receipts: `phase-5/REPORT.md`) |
| 6 | `phase-6/` | done | Product-ready: three-platform 30-gate sweeps, profile persistence, browser dock + agent control via MCP, first-run + updates, v0.4.0 shipped |
| 7 | `phase-7/` | done | Usage meters — **full CodexBar parity** (50 catalog providers on 5 mechanism classes: cli-store · api-key · cloud-cli · web-session · local): adapter seam + ADR 0007/.a/.b, pace engine, titlebar gauge + popover, cost/spend/history, provider status feed, plans×profiles + thresholds + failover feed, merged-icon display, reset confetti, `mogging usage` CLI, full Usage settings tab; sweep 30→35 gates, three-platform certification run 28789330898 (docs: `docs/12-usage.md`, receipts: `phase-7/REPORT.md`) |
| 8 | `phase-8/` | done | Integrations, five directions: ADR 0008 (protocols, not plugins; 8 stances incl. the custody rule), control plane joins the shipped MCP server (reads + granted writes), the agent web profile (phase-10 Comet resolution, Branch C) + the activity trail (FINDINGS §4.5), MCP manager + curated catalog honoring the WEBSITE roster (n8n + Google Workspace first; research: `docs/research/`), paste-once vault keys materialized into pane envs (the 0007.a grammar fleet-wide), per-workspace TOOL PLANS (context hygiene: which servers each CLI gets, chosen at creation, launch-time materialization, the who-has-what matrix), the outbound event bridge ("a notify call to any webhook"), a live MCP connection registry (per-server×CLI states, pane chips, restart nudges, one-click re-auth), GitHub adapter with review-lands-back-in-the-pane, the onboarding/UX pass (guided connect-your-stack flow, single-fire failure toasts, palette verbs, plain-language summaries); closed by the `MOGGING_INTEGMILESTONE` milestone (all five directions composed, one fixture world, budget unmoved) + `docs/14-integrations.md` incl. the site-honesty map; 14 steps, 13 new gates, sweep 35→52 |
| 9 | `phase-9/` | authored | Loops: standing harnesses — triggers, fresh-worktree iterations, verify gates, budgets, Sentry watcher, staged playbook learning (ADR 0009) |
| 10 | `phase-10/` | resolved → 8/04 | Agents on real logged-in sessions: Branch A/C implemented as phase-8/04 (agent web profile); Branch B (system-cookie inheritance) stays PARKED behind its own future ADR — `FINDINGS.md` is the map |

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
