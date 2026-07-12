# Research — The vibe-coding ecosystem sweep (what to absorb, what to refuse)

- **Date:** 2026-07-12 · **Status:** research synthesis, pre-implementation
- **Question:** which GitHub projects gaining visibility in the AI-coding /
  "vibe coding" space carry an idea worth absorbing, and what do they compose
  into when merged?
- **Answer in one line:** the category's stars have accumulated in the
  **management layer** (task boards, spec kits, context graphs) and every one of
  those tools stands on a terminal it did not build well — **we build that
  terminal**, so the correct posture is to absorb their *ideas as protocols and
  data* (ADR 0008) and own the execution layer beneath them.

> **Binding constraints on everything below.** ADR 0002 (never broker auth) ·
> ADR 0008 (protocols, not plugins — no third-party JS in our processes) ·
> roadmap risk #5 (**zero code from AGPL/GPL rivals; clean-room only**). Several
> of the highest-profile projects here are AGPL or GPL. They are **design
> references, never dependencies**, and are marked ⛔ below.

---

## 1. The merged jigsaw (ranked by value to this app)

Each row is a **capability we could name on a landing page**, not a dependency
list. The merges exist because each part covers another's weakness: something
that *knows things* paired with something that *renders or routes* them.

| # | Capability | Merged from | Why they complete each other | Lands as |
|---|---|---|---|---|
| 1 | **The Workspace Brain** — one context daemon per workspace, mounted into every pane over MCP | Graphify (MIT) + Serena (MIT) + Context7 (MIT) + Aider's repomap algorithm (Apache-2.0) | Graphify answers "how does this repo fit together" deterministically (tree-sitter, no LLM, no embeddings) but is **read-only**; Serena adds symbol-level *writes* so panes stop blind-rewriting files and colliding. Context7 covers the one thing a local graph cannot know — third-party API truth. The repomap ranking decides what gets injected at pane spawn | **Phase 12** (supersedes Phase 2.5) |
| 2 | **Contention** — the failure mode our own product creates | uzi (MIT) + Crystal (MIT) + Sculptor's Pairing Mode (MIT) | uzi solves **ports + per-worktree dev servers**; Crystal solves review/merge across N worktrees; Sculptor solves getting isolated work back *out*. Individually fragments; together the full lifecycle of parallel work on one repo | **Phase 13** |
| 3 | **A real control plane** — structured turns instead of scraped bytes | ACP (Apache-2.0) + HumanLayer's typed approval events + ccmanager's per-CLI state heuristics (MIT) | ACP gives structure but only for agents that speak it; ccmanager's heuristics are the **fallback** for CLIs that don't, so we degrade gracefully instead of maintaining two worlds. HumanLayer turns "this pane is waiting" into a routable event | **Phase 14** |
| 4 | **Loops that start sharper** | Phase 9 (authored) + spec-kit (MIT) + Backlog.md (MIT) | Phase 9 already has the harness (fresh context, verify gate, budgets). spec-kit supplies *where the work comes from* (spec → tasks); Backlog.md persists it as **committed markdown** — git is the database, zero infra | **Phase 9** (enriched) |
| 5 | **Opt-in sandboxed panes** | container-use (Apache-2.0) + microsandbox (Apache-2.0) + vibekit (MIT) | container-use lets agents opt into isolation *themselves over MCP* so we write no runtime; microsandbox is the **local-first** backend that keeps the no-account promise; vibekit stops secrets leaking into an unattended agent | **Phase 15** |
| 6 | **Replayable panes** | asciinema's `.cast` **format** (⛔ GPL-3.0 — format only, no code) + VHS tapes (MIT) + OpenHands' typed event stream | `.cast` captures pixels, a typed action/observation log captures *meaning* — together a replay is watchable **and** searchable. VHS tapes are the same shape our control API already speaks, so demos and UI smokes become one artifact | **Phase 16** |
| 7 | **Remote attach** | vibetunnel (MIT) + HumanLayer | vibetunnel gets you *looking* at a pane remotely; the approval protocol is what makes it useful — unblock an agent without a laptop. Our daemon already outlives the app (ADR 0006), so the hard part is done | **Phase 17** |
| 8 | **The review pane** | pr-agent (MIT) + Crystal's diff-compare + ast-grep (MIT) | Five panes write, one critiques. ast-grep lets the reviewer verify structurally ("find every caller") instead of re-reading files | **Phase 18** |
| 9 | **Portable workspaces** | zellij layout files (MIT) + AGENTS.md (MIT) | A layout says *where panes go*; AGENTS.md says *how each agent behaves* once there. Together a workspace is one committable file | **Phase 19** |

## 2. Already shipped here — do not re-buy

The sweep surfaced several tools whose entire value we have built:

| Their tool | Our shipped equivalent |
|---|---|
| claude-squad ⛔, Crystal, coder/mux ⛔ (worktree-per-agent) | Phase 3 — worktree isolation + guarded `merge --no-ff` |
| vibe-kanban, ccpm (board dispatches agents) | Phase 3 — Kanban board; the task IS the first prompt |
| cmux ⛔ (agent-aware notifications) | Phase 2 — OSC parser → rings/badges; `mogging notify` |
| ccusage, Claude-Code-Usage-Monitor, sniffly | Phase 7 — titlebar usage gauge, cost/spend/history, failover |
| MCP registry / awesome-mcp-servers | Phase 8 — MCP manager + Catalog + registry, per-workspace tool plans |
| opcode ⛔ (session library) | Phase 3/4 — persistent workspaces, control API |

The residue worth taking from that column is small and specific: **ccmanager's
per-CLI idle/busy/waiting heuristics** (row 3 above) and **vibe-kanban's
backlog-auto-spawns-the-next-agent** queueing, which our board does not do.

## 3. The licence map (⛔ = clean-room reference only, never linked)

- ⛔ **AGPL-3.0**: claude-squad, opcode/claudia, coder/mux
- ⛔ **GPL-3.0**: cmux, asciinema (the `.cast` *format* is fine; the code is not)
- ⛔ **Elastic-2.0**: cipher/ByteRover
- ✅ **MIT / Apache-2.0**: Graphify, Serena, Context7, repomix, ast-grep, uzi,
  Crystal, Sculptor, container-use, microsandbox, vibekit, vibetunnel, pr-agent,
  spec-kit, Backlog.md, ACP, zellij, ghostty, AGENTS.md, mem0, graphiti
- ⚠️ **NOASSERTION** (non-SPDX licence file — read the text before vendoring):
  wezterm, node-pty, langfuse, ccusage, HumanLayer

Star counts gathered 2026-07-12 (approx): Graphify ~83k · spec-kit very large ·
vibe-kanban ~27k · cmux ~24k · opcode ~22k · Serena ~26k · Context7 ~59k ·
ACP ~3.6k · uzi ~580 · Sculptor ~200. **Star count is a visibility signal, not a
value signal** — uzi (~580) carries the highest value-per-hour idea in the sweep;
Graphify (~83k) carries the flagship.

## 4. Why the graph, and why now

Phase 2.5 named a memory graph as *the chosen differentiator* and was never
built. The sweep validates the instinct and corrects its scope: the winning
artefact is not only a **human** memory graph of notes, it is a **code** graph
the agents query. The economic argument is the point —

> Sixteen agents each re-scanning the same tree pay the cost sixteen times.
> One graph, queried by all sixteen over MCP, makes *many agents cheaper per
> question than one agent working badly.*

That is a claim only a multi-pane host can make, and it converts our core
feature (many agents) from an ergonomic story into an economic one. Graphify is
the cheapest nucleus to build against: local, deterministic, MIT, no embeddings,
no vector store, and it already speaks MCP to every CLI we launch (ADR 0008's
"data over protocols", exactly).
