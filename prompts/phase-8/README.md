# Phase 8 — Integrations: protocols, not plugins

Sequenced task prompts for Phase 8 of **MoggingLabs Workspace**: the swarm
coordinates through verbs a HUMAN scripts — now the agents get the control
plane, and the app becomes the one place a fleet's integrations are managed.
Three directions, one philosophy: agents→app (a first-party MCP server over
the existing authed daemon socket), app→CLIs (MCP registration fanned out
across every hosted CLI's config dialect — the `hooks/` pattern generalized),
app→services (API adapters behind one seam, GitHub first). Same format as
`prompts/phase-1..7/` (each step self-contained + pasteable as a `/goal`,
< 4000 chars). Execute in order.

> **Mechanism decision (made here, binding)**: integrations are PROTOCOLS,
> not plugins. No in-process plugin runtime in v1: third-party JS inside the
> app attacks the two load-bearing assets — rendering reliability (the wedge)
> and the hardened posture (sandbox, closed allowlists, nothing new listens).
> The scriptable control API + hooks + the MCP server ARE the extensibility
> surface. Codified as ADR 0008 in step 01; UI extensibility revisits post-v1
> via MCP Apps (spec 2026-07-28), never via npm-in-process.

> **Auth stance (binding, ADR 0002 lineage)**: outbound adapters RIDE sessions
> the user's own tools already hold (`gh auth token` — in memory, one request,
> never persisted, logged, or shown). The MCP manager writes server ENTRIES
> into CLI config files — surgical, backed-up, env-refs only, never a secret
> literal, never touching auth/credential keys.

> **Security stance (binding)**: the server's write tools grant NOTHING an
> in-pane `mogging send` doesn't already grant — the opt-in is tool-CATALOG
> hygiene against prompt injection, not the security boundary. The reviewer
> gate remains the boundary: `approve` is NEVER exposed as a tool.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-adr-and-contracts.md` | ADR 0008 + `@contracts/integrations` + tool catalog AS DATA + grants shape; typecheck/boundaries green (ships zero runtime) |
| 02 | `02-mcp-server-read.md` | `mogging mcp serve` (stdio, hand-rolled JSON-RPC, daemon-client reuse) with the read tools; MCP smoke green on golden frames |
| 03 | `03-mcp-write-tools.md` | Write tools behind the workspace grant (default OFF), pane-scoped identity, notify receipts; MCPWRITE smoke green |
| 04 | `04-mcp-manager.md` | Settings § Integrations: register any server across claude/codex/gemini config dialects — surgical, backed-up, diff-previewed; MCPMGR smoke green on fixture homes |
| 05 | `05-github-adapter.md` | Board cards link to GitHub PRs/issues with live status chips riding `gh` auth; INTEG smoke green on the FAKE adapter |
| 06 | `06-integrations-milestone.md` | INTEGMILESTONE end-to-end + `docs/13-integrations.md` + books; full sweep green on all four environments |

## Overall Definition of Done
- Any hosted CLI, registered by the app in one click, can list panes, read a
  scrollback tail, and speak on the mailbox through MCP — identically for
  Claude Code, Codex, and Gemini.
- Write tools exist only where a workspace opted in; `approve` appears in no
  tools/list frame anywhere in the sweep.
- A board card linked to a GitHub PR shows live state without the app holding
  a single credential.
- The sweep — with all five new gates — is green on local Windows and all
  three CI OSes; both perf budgets unchanged.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean.
- The step's env-gated smoke green via `scripts/qa-smokes.sh` isolation; both
  perf budgets (MILESTONE + PERCEPTION) re-run after any renderer-touching
  step.
- Gallery states staged for every new visual surface (both themes).

## Guardrails
- **Daemon protocol stays v3.** The MCP server is a pure CLIENT of the authed
  socket — zero new wire surface, zero new listeners (stdio only, no TCP).
- **Smokes are network-free forever**: scripted JSON-RPC frames, fixture
  config homes, the FAKE service adapter. Real CLIs/services are dev-verified
  manually and recorded in the books.
- **ADR 0005**: tool args, pane content, repo names, URLs never enter
  telemetry — counts and booleans only.
- Platform differences live in path tables + CI config only (6/03 lesson:
  compare canonical paths on win32).
- Phase 2.5's memory tools mount on THIS server later — the catalog stays
  data so it can grow without touching dispatch.

## Parallelization
01 is the root. After it: Lane A (02 → 03, the server), Lane B (04, the
manager), Lane C (05, the service seam) — three lanes, zero shared files
beyond contracts. 06 needs all lanes. The pack is independent of Phase 6's
remaining steps and of Phase 7 entirely (different seams); sequencing between
packs stays the operator's call.
