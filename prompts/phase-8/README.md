# Phase 8 — Integrations: protocols, not plugins — and the agent's own web

Sequenced task prompts for Phase 8 of **MoggingLabs Workspace**: the swarm
coordinates through verbs a HUMAN scripts — now the agents get the control
plane, the browser they already drive gets real (consented) sessions, every
action an agent takes on your behalf leaves a reviewable trail, pane events
reach the automation platforms an agency already runs, and the app becomes
the one place a fleet's integrations are managed. Five directions, one
philosophy: agents→app (the control plane joins the first-party MCP server),
agents→web (the agent browser profile — the phase-10 "Comet" resolution),
app→CLIs (MCP registration fanned out across every hosted CLI's config
dialect), app→services (API adapters behind one seam, GitHub first), and
app→automations (the outbound event bridge — a notify call to any webhook).
Same format as `prompts/phase-1..7/` (each step self-contained + pasteable
as a `/goal`, < 4000 chars). Execute in order.

> **Remade 2026-07-06** on four sources: the shipped code, the integrations
> research (`docs/research/2026-07-third-party-integrations.md`), the
> phase-10 findings (`prompts/phase-10/FINDINGS.md`), and the WEBSITE's
> published promises (`MoggingLabs-Website` — the roster where **n8n and
> Google Workspace lead by founder priority**, "a notify call to any
> webhook", "review lands back in the pane that wrote it", the agent web
> profile card). Every site-named integration must map to an honest on-ramp
> by the milestone — no name silently dropped.

> **Ground truth (this pack builds on shipped code, not greenfield)**: 6/05b
> already shipped the first-party MCP server — `bin/mogging-mcp.mjs`, stdio
> JSON-RPC 2.0, 14 browser tools, an authed app endpoint, per-workspace
> consent. This pack does NOT build a second server: 02 folds the control
> plane INTO it (one registration, two authed upstreams — the daemon socket
> for panes/mail/board, the app endpoint for the dock), and 01 moves ALL tool
> definitions into contracts so the catalog is one piece of data.

> **Mechanism decision (binding)**: integrations are PROTOCOLS, not plugins.
> No in-process plugin runtime in v1: third-party JS inside the app attacks
> the two load-bearing assets — rendering reliability (the wedge) and the
> hardened posture. The scriptable control API + hooks + the MCP server +
> the event bridge ARE the extensibility surface. Codified as ADR 0008 in
> step 01; UI extensibility revisits post-v1 via MCP Apps, never
> npm-in-process.

> **The Comet resolution (per `prompts/phase-10/FINDINGS.md`, binding)**: the
> dock gets a first-class **agent browser profile** the user signs into ON
> PURPOSE (Branch C) — real logins, per-ORIGIN action grants, a sensitive-
> origin blocklist, read-vs-act separation, AND the audit trail FINDINGS §4
> calls non-negotiable (step 05, first-class — not a footnote). **Branch B
> (inheriting the system browser's cookies) stays parked**: it reverses
> ADR 0002 and starts, if ever, with its own ADR — codified in ADR 0008.e.

> **Auth stance (binding, ADR 0002 lineage)**: outbound adapters RIDE
> sessions the user's own tools already hold (`gh auth token` — in memory,
> one request, never persisted, logged, or shown). The MCP manager writes
> server ENTRIES into CLI config files — surgical, backed-up, env-ref or
> vault-slot POINTERS only, never a secret literal, never touching
> auth/credential keys. Third-party service KEYS are pointers (ADR 0007
> extended to services in 0008.d): an env-ref, or pasted ONCE into the OS
> vault — ciphertext at rest, write-only, materialized only into pane
> environments at launch (08, the phase-7 grammar fleet-wide); webhook
> URLs that embed secrets ride the same vault (09); app-held OAuth is
> deferred behind its own ADR. The agent web profile's sessions are
> created by the USER logging in inside the dock — the app never reads
> any other credential store.

> **Security stance (binding)**: the server's write tools grant NOTHING an
> in-pane `mogging send` doesn't already grant — the opt-in is tool-CATALOG
> hygiene against prompt injection, not the security boundary. The reviewer
> gate remains the boundary: `approve` is NEVER exposed as a tool. On the
> web side the same shape: reading a page is never gated, ACTING on a
> signed-in origin requires that origin's explicit grant, sensitive origins
> refuse grants entirely — and every act lands in the trail.

> **Before executing any step, read `IMPLEMENTATION.md`** — the best-path
> decisions surveyed against shipped code (framing, catalog-as-JSON, the
> grant wire, writer strategy per config format, the act-gating point, the
> trail store, the bridge's vault, named risks) plus the phase-7 lessons
> now binding (one-home Settings modules, catalog∪config truthfulness,
> vault-conditioned probes, four-environment certification). Steps deviate
> only by recording why there.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-adr-and-contracts.md` | ADR 0008 (seven stances incl. the browser-session boundary + outbound events) + `@contracts/integrations`: ONE tool catalog as data, ONE grant shape, the trail entry, services seam, preset + webhook shapes; typecheck/boundaries green (ships zero runtime) |
| 02 | `02-mcp-server-read.md` | The shipped server becomes `mogging`: control-plane read tools join the browser tools, catalog served from contracts data, daemon client as second upstream; dev-verified against a NON-CLI MCP client too (protocol citizen, not a Claude-Code trick); MCP smoke green on golden frames |
| 03 | `03-mcp-write-tools.md` | Control-plane write tools behind the workspace grant (default OFF), pane-scoped identity, receipts; MCPWRITE smoke green |
| 04 | `04-agent-web-profile.md` | The agent browser profile (Branch C): sign-in-here affordance, per-origin action grants + blocklist, read-vs-act, session-scoped confirm, clear-logins, origin-change alerts; AGENTWEB smoke green on a localhost fixture login site |
| 05 | `05-agent-activity-trail.md` | The audit trail with teeth (FINDINGS §4.5): one local ledger for web acts + MCP writes + bridge deliveries, reviewable UI, retention, never telemetry; WEBTRAIL smoke green |
| 06 | `06-mcp-manager.md` | Settings § Integrations: register any server across claude/codex/gemini config dialects — surgical, backed-up, diff-previewed; the house server is the built-in first row; MCPMGR smoke green on fixture homes |
| 07 | `07-integrations-catalog.md` | The Integrations Catalog: research-verified presets (n8n + Google Workspace FIRST — founder priority) PLUS the open end — registry search, custom entries, preset import/export; Connect + per-CLI Authorize orchestration (status only, never tokens); the site-roster map begins; MCPCAT smoke green on fixture homes |
| 08 | `08-vault-service-keys.md` | The phase-7 vault, fleet-wide: paste-once service keys (OS-vault ciphertext, write-only) materialized into pane ENVIRONMENTS at launch — api-key MCP servers without dotfile editing, no secret literal ever on disk; `vault.ts` extracted from usage-keys; per-CLI env semantics dev-verified; VAULTKEYS smoke green |
| 09 | `09-event-bridge.md` | The outbound event bridge: pane/board events → user-configured webhooks (n8n · Make · Zapier · Slack incoming) — "a notify call to any webhook"; vault-held URLs, versioned payload, polite delivery; EVBRIDGE smoke green on a localhost fixture receiver |
| 10 | `10-github-adapter.md` | Board cards link to GitHub PRs/issues with live status chips riding `gh` auth; review-state changes land back on the pane that wrote it; INTEG smoke green on the FAKE adapter |
| 11 | `11-integrations-milestone.md` | INTEGMILESTONE end-to-end (all five directions composed) + `docs/14-integrations.md` incl. the site-honesty map + books; full sweep green on all four environments |

## Overall Definition of Done
- Any hosted CLI, registered by the app in one click, can list panes, read a
  scrollback tail, speak on the mailbox, AND drive the dock — through ONE
  server entry, identically for Claude Code, Codex, and Gemini — and a
  non-CLI MCP client (Inspector / n8n's client node) speaks to the same
  server unmodified.
- Write tools exist only where a workspace opted in; `approve` appears in no
  tools/list frame anywhere in the sweep.
- An agent can act on a site the user signed into IN the dock — but only on
  origins the user granted, never on the blocklist, with every action in the
  trail; an ungranted origin refuses ACT verbs and says why. The trail
  answers "what did agents do as me this week" from the UI alone.
- A pane's notify reaches a self-hosted n8n (or Make/Zapier/Slack) webhook
  the user configured — payload documented, secrets vault-held, nothing
  else leaves the machine.
- A board card linked to a GitHub PR shows live state without the app
  holding a single credential — and a review decision flips a notify onto
  the pane that owns the card.
- A third-party preset (Sentry) reaches every hosted CLI in one click + one
  browser consent per CLI — the app registering and orchestrating, holding
  nothing. Tools BEYOND the presets ride the same pipeline: registry search,
  custom entry, or imported preset — never a code change.
- Every integration named on the website maps in docs/14 to its on-ramp:
  preset (verified date) · registry · custom entry · event bridge · or an
  honest "no official server yet".
- An api-key tool (PostHog) connects with a key pasted ONCE — vault
  ciphertext at rest, materialized only into pane environments, no
  plaintext on disk anywhere; a vault-less Linux box refuses and offers
  the env-ref instead.
- The sweep — with all ten new gates — is green on local Windows and all
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
  to the agent, nothing on TCP). The bridge POSTs out; nothing listens.
- **ADR 0002 boundary, restated for the web**: sessions enter the agent
  profile ONLY by the user logging in inside the dock. No import from Chrome/
  Safari/Edge, no cookie-store reads, no keychain touches — that is Branch B,
  parked behind its own future ADR (`prompts/phase-10/FINDINGS.md` is its map).
- **Smokes are network-free forever**: scripted JSON-RPC frames, fixture
  config homes, the FAKE service adapter, a LOCALHOST fixture login site for
  AGENTWEB, a LOCALHOST fixture receiver for EVBRIDGE. Real CLIs/services
  are dev-verified manually and recorded in the books with dates (the 7/01
  discipline — nothing hardcoded unverified, presets included).
- **ADR 0005**: tool args, pane content, page content, cookies, repo names,
  URLs, origins, and webhook payloads never enter telemetry — counts and
  booleans only. The trail is LOCAL — it exists so the user can audit, and
  it never leaves the machine.
- **One home**: Settings § Integrations is ONE module growing across 06/07/08
  (the 7/12 lesson) — no knob renders anywhere else; the milestone greps it.
- Platform differences live in path tables + CI config only (6/03 lesson:
  compare canonical paths on win32).
- Phase 2.5's memory tools mount on THIS server later — the catalog stays
  data so it can grow without touching dispatch.

## Parallelization
01 is the root. After it: Lane A (02 → 03 → 04 → 05, the server + the web
profile + the trail), Lane B (06 → 07 → 08 → 09, the manager + catalog +
vault keys + bridge),
Lane C (10, the service seam) — three lanes, zero shared files beyond
contracts. 11 needs all lanes. Solo execution runs 01→11 in order (house
rule: no parallel agents); the lanes describe independence, not simultaneity.
The ecosystem research behind the catalog (per-tool matrix, CLI OAuth
capabilities, sources): `docs/research/2026-07-third-party-integrations.md`.
The site roster the catalog must honor: `MoggingLabs-Website/src/lib/site.ts`
(INTEGRATIONS · INTEGRATIONS_MORE · INTEGRATIONS_MEDIA). Docs pages ladder:
12 usage (phase 7) · 13 browser (shipped) · **14 integrations (this pack)** ·
15 loops (phase 9).
