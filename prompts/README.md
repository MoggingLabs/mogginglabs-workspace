# Prompts — master index

> **Why this tree is committed** (reviewed 2026-07, declined for deletion): it is not
> process residue — `scripts/check-audit.mjs` (the AUDIT gate, run in every sweep) asserts
> over `phase-8.5/AUDIT.md` that every audit finding stays routed and no Grades row sits
> below A, and `check-gate-count.mjs` holds the phase-11 pack's sweep-size claims to the
> derived count. Deleting the tree fails the sweep. Transient session artifacts (the root
> `AUDIT_REMEDIATION_*` files) were the actual slop, and those are gone.

Sequenced master prompts that build **MoggingLabs Workspace** phase by phase. Each phase folder
has a `README.md` (the plan) + numbered step files; every STEP is self-contained and pasteable as
a `/goal` (kept **≤ 3950 chars** — `/goal` caps the whole condition at 4000 and you prepend your
own preamble, so a 3999-char step fails to set; count characters, not bytes). Execute a phase in
order; don't start the next phase until the current phase's gate is green (Windows + macOS).
Roadmap: `docs/02-mvp-and-roadmap.md`.

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
| 8.5 | `phase-8.5/` | done (2026-07-09) | UI/UX revamp: one full audit (AUDIT.md — every surface graded keep/fix/remove) then a systemic visual pass — the ramp extended (`--sp-7/8`) + four layout primitives (Card/SectionHeader/FieldGroup/TwoColumn) in the token system, the wizard collapsed to ONE uncluttered page, a real clickable folder browser (breadcrumb + repo badges) beside the path bar, the Settings shell + both dense tabs (Integrations/Usage) rebuilt on cards with progressive disclosure, Home/first-run/board/palette/toasts/chrome/possession unified into one feedback language, 13 removals executed + 16 bugs fixed; 21st.dev as clean-room pattern research only (vanilla TS + house tokens, no new deps); 13 steps, 14 new gates (sweep 52→66), closed by UXMILESTONE + the check-audit coverage gate + spacing frozen at `--max 0`, budgets unchanged, four-environment certification |
| 9 | `phase-9/` | authored | Loops: standing harnesses — triggers, fresh-worktree iterations, verify gates, budgets, Sentry watcher, staged playbook learning (ADR 0009) |
| 10 | `phase-10/` | resolved → 8/04 | Agents on real logged-in sessions: Branch A/C implemented as phase-8/04 (agent web profile); Branch B (system-cookie inheritance) stays PARKED behind its own future ADR — `FINDINGS.md` is the map |
| Accounts | `phase-accounts/` | authored | Productization: the paid tier, hardened. Implements what `phase-login/` researched — accounts (PKCE + DPoP, ADR 0015), signed short-TTL entitlements + offline grace + an `Entitlements` port gating paid features, a **hardware-bound device key** (TPM/Secure Enclave) so copies are inert, plus the anti-crack pass: origin-pinning (closes `MOGGING_REGISTRY_BASE`), the four safe Electron **fuses** + ASAR integrity, renderer CSP/navigation lockdown, main-only **V8 bytecode**, forensic activation watermark + tamper self-check, and the **runtime split** (ADR 0016) that finally disables `runAsNode`. Free local core stays account-free + offline; `mogging list/send/capture` ungated; boot budget unmoved. FAKE IdP/MoR in all smokes (zero network). 10 steps, 10 new gates, closed by PRODMILESTONE. Code-signing certs are the operator's deferred final step, out of the pack. Plan: `docs/research/2026-07-anti-crack-implementation-report.md` (+3 companion docs) |
| 11 | `phase-11/` | done (2026-07-12) | Files: the explorer sidebar — a right-side dock with the workspace folder in a virtualized, git-decorated, LIVE tree. ADR 0010 (a window, not a manager: read-only v1; open/reveal delegate to the OS; write verbs + an in-app editor deferred with rationale). Far-right titlebar toggle + `Ctrl+Shift+E`; watch-what is-visible liveness (per-expanded-dir non-recursive `fs.watch`, LRU-capped at 64 + jittered poll fallback, coalesced batches — a collapsed dir / hidden window / closed explorer each cost ZERO, measured); per-file M/A/U/D/C badges + colour-only folder propagation riding the EXISTING 2.5s git tick (zero new pollers — the porcelain lines were already read and discarded) + check-ignore dimming + the Changes lens; delegation-only actions (open/reveal/copy/send-to-pane, never Enter) + the house context-menu primitive; `docs/16-files.md`. Zero new deps. 7 steps, 7 new gates (sweep 76 → 83), closed by FILESMILESTONE with budgets measured on the composed surface (16 panes + explorer + write torrent: 142.8 fps, 25.1ms worst gap, 20MB heap). Research: `phase-11/RESEARCH.md`; receipts + platform finds: `phase-11/REPORT.md` |

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
