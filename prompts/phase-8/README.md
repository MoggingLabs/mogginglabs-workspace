# Phase 8 — Integrations: protocols, not plugins — and the agent's own web

Sequenced task prompts for Phase 8 of **MoggingLabs Workspace**: the swarm
coordinates through verbs a HUMAN scripts — now the agents get the control
plane, the browser they already drive gets real (consented) sessions, and the
app becomes the one place a fleet's integrations are managed. Four directions,
one philosophy: agents→app (the control plane joins the first-party MCP
server), agents→web (the agent browser profile — the phase-10 "Comet"
resolution), app→CLIs (MCP registration fanned out across every hosted CLI's
config dialect), app→services (API adapters behind one seam, GitHub first).
Same format as `prompts/phase-1..7/` (each step self-contained + pasteable as
a `/goal`, < 4000 chars). Execute in order.

> **Ground truth (this pack builds on shipped code, not greenfield)**: 6/05b
> already shipped the first-party MCP server — `bin/mogging-mcp.mjs`, stdio
> JSON-RPC 2.0, 14 browser tools, an authed app endpoint, per-workspace
> consent. This pack does NOT build a second server: 02 folds the control
> plane INTO it (one registration, two authed upstreams — the daemon socket
> for panes/mail/board, the app endpoint for the dock), and 01 moves ALL tool
> definitions into contracts so the catalog is one piece of data.

> **Mechanism decision (made here, binding)**: integrations are PROTOCOLS,
> not plugins. No in-process plugin runtime in v1: third-party JS inside the
> app attacks the two load-bearing assets — rendering reliability (the wedge)
> and the hardened posture. The scriptable control API + hooks + the MCP
> server ARE the extensibility surface. Codified as ADR 0008 in step 01; UI
> extensibility revisits post-v1 via MCP Apps, never via npm-in-process.

> **The Comet resolution (per `prompts/phase-10/FINDINGS.md`, binding)**: the
> dock gets a first-class **agent browser profile** the user signs into ON
> PURPOSE (Branch C) — real logins, per-ORIGIN action grants, a sensitive-
> origin blocklist, and read-vs-act separation. **Branch B (inheriting the
> system browser's cookies) stays parked**: it reverses ADR 0002 and starts,
> if ever, with its own ADR — this pack codifies that boundary in ADR 0008
> rather than leaving it as a folder of findings.

> **Auth stance (binding, ADR 0002 lineage)**: outbound adapters RIDE sessions
> the user's own tools already hold (`gh auth token` — in memory, one request,
> never persisted, logged, or shown). The MCP manager writes server ENTRIES
> into CLI config files — surgical, backed-up, env-refs only, never a secret
> literal, never touching auth/credential keys. Third-party service KEYS are env-ref
> POINTERS (ADR 0007 extended to services in 0008.d); app-held OAuth is
> deferred behind its own ADR. The agent web profile's sessions are created
> by the USER logging in inside the dock — the app never reads any other
> credential store.

> **Security stance (binding)**: the server's write tools grant NOTHING an
> in-pane `mogging send` doesn't already grant — the opt-in is tool-CATALOG
> hygiene against prompt injection, not the security boundary. The reviewer
> gate remains the boundary: `approve` is NEVER exposed as a tool. On the web
> side the same shape: reading a page is never gated, ACTING on a signed-in
> origin requires that origin's explicit grant, and sensitive origins refuse
> grants entirely.

> **Before executing any step, read `IMPLEMENTATION.md`** — the best-path
> decisions surveyed against shipped code (framing, catalog-as-JSON, the
> grant wire, writer strategy per config format, the act-gating point,
> named risks). Steps deviate only by recording why there.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-adr-and-contracts.md` | ADR 0008 (six stances incl. the browser-session boundary) + `@contracts/integrations`: ONE tool catalog as data (browser + control families), ONE grant shape (writes + web), services seam; typecheck/boundaries green (ships zero runtime) |
| 02 | `02-mcp-server-read.md` | The shipped server becomes `mogging` (not `mogging-browser`): control-plane read tools join the browser tools, catalog served from contracts data, daemon client as second upstream; MCP smoke green on golden frames |
| 03 | `03-mcp-write-tools.md` | Control-plane write tools behind the workspace grant (default OFF), pane-scoped identity, notify receipts; MCPWRITE smoke green |
| 04 | `04-agent-web-profile.md` | The agent browser profile: sign-in-here affordance, per-origin action grants + blocklist, clear-logins, origin-change alerts; AGENTWEB smoke green on a localhost fixture login site |
| 05 | `05-mcp-manager.md` | Settings § Integrations: register any server across claude/codex/gemini config dialects — surgical, backed-up, diff-previewed; the house server is the built-in first row; MCPMGR smoke green on fixture homes |
| 06 | `06-integrations-catalog.md` | The Integrations Catalog: ~20 official-MCP presets as data (research-sourced) PLUS the open end — registry search, custom entries, preset import/export (the 21st tool is data, never code); Connect + per-CLI Authorize orchestration (status only, never tokens); MCPCAT smoke green on fixture homes |
| 07 | `07-github-adapter.md` | Board cards link to GitHub PRs/issues with live status chips riding `gh` auth; INTEG smoke green on the FAKE adapter |
| 08 | `08-integrations-milestone.md` | INTEGMILESTONE end-to-end (all four directions composed) + `docs/14-integrations.md` + books; full sweep green on all four environments |

## Overall Definition of Done
- Any hosted CLI, registered by the app in one click, can list panes, read a
  scrollback tail, speak on the mailbox, AND drive the dock — through ONE
  server entry, identically for Claude Code, Codex, and Gemini.
- Write tools exist only where a workspace opted in; `approve` appears in no
  tools/list frame anywhere in the sweep.
- An agent can act on a site the user signed into IN the dock — but only on
  origins the user granted, never on the blocklist, with every action
  receipted; an ungranted origin refuses ACT verbs and says why.
- A board card linked to a GitHub PR shows live state without the app holding
  a single credential.
- A third-party preset (Sentry) reaches every hosted CLI in one click +
  one browser consent per CLI — the app registering and orchestrating,
  holding nothing. Tools BEYOND the presets ride the same pipeline:
  registry search, custom entry, or imported preset — never a code change.
- The sweep — with all seven new gates — is green on local Windows and all
  three CI OSes; both perf budgets unchanged.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean.
- The step's env-gated smoke green via `scripts/qa-smokes.sh` isolation; both
  perf budgets (MILESTONE + PERCEPTION) re-run after any renderer-touching
  step.
- Gallery states staged for every new visual surface (both themes).

## Guardrails
- **Daemon protocol stays v3.** The MCP server is a pure CLIENT of two authed
  sockets it does not own — zero new wire surface, zero new listeners (stdio
  to the agent, nothing on TCP).
- **ADR 0002 boundary, restated for the web**: sessions enter the agent
  profile ONLY by the user logging in inside the dock. No import from Chrome/
  Safari/Edge, no cookie-store reads, no keychain touches — that is Branch B,
  parked behind its own future ADR (`prompts/phase-10/FINDINGS.md` is its map).
- **Smokes are network-free forever**: scripted JSON-RPC frames, fixture
  config homes, the FAKE service adapter, and a LOCALHOST fixture login site
  for AGENTWEB. Real CLIs/services are dev-verified manually and recorded in
  the books.
- **ADR 0005**: tool args, pane content, page content, cookies, repo names,
  URLs, and origins never enter telemetry — counts and booleans only.
- Platform differences live in path tables + CI config only (6/03 lesson:
  compare canonical paths on win32).
- Phase 2.5's memory tools mount on THIS server later — the catalog stays
  data so it can grow without touching dispatch.

## Parallelization
01 is the root. After it: Lane A (02 → 03 → 04, the server + the web
profile), Lane B (05 → 06, the manager + catalog), Lane C (07, the service
seam) — three lanes, zero shared files beyond contracts. 08 needs all
lanes. The ecosystem research behind the catalog (per-tool matrix, CLI
OAuth capabilities, sources): `docs/research/2026-07-third-party-integrations.md`. Docs pages
ladder: 12 usage (phase 7) · 13 browser (shipped) · **14 integrations (this
pack)** · 15 loops (phase 9).
