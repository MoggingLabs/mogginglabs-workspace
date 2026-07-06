Freeze the pack the house way: one end-to-end milestone that proves all FOUR
integration directions COMPOSE, the docs page that makes the surface
teachable, and the books recording the sweep green on every environment.

## Steps
1. **INTEGMILESTONE smoke** (`MOGGING_INTEGMILESTONE`, env-gated, in
   qa-smokes.sh) — the composed story in one fixture world, no network:
   (a) manager applies the house server into a FIXTURE Claude config
   home → entry present, dialect-correct; (b) an MCP session
   (scripted frames, pane identity) lists panes, captures a tail,
   reads mail — grant `'none'`, zero write tools listed; (c) the
   workspace grant flips on → `list_changed` fires, the session claims a
   glob and `send_to_pane`s its own worktree pane, text arrival confirmed; an
   ungranted workspace's session sees no writes;
   (d) agent-web: acts on the GRANTED fixture origin (04's site),
   refused on the ungranted one — receipts both ways; (e) a board card linked
   to a FAKE-adapter PR flips checks-failing → checks-green, chip class
   follows; (f) the
   structural sweep: `approve` in no tools/list frame, no token/credential/
   cookie string in any frame or log, receipts landed on the target pane.
   Verdict via `out/integmilestone-result.json`; budgets sampled DURING
   the run — MILESTONE + PERCEPTION unchanged.
2. **`docs/14-integrations.md`** — the teachable page: the four directions
   (agents→app, agents→web, app→CLIs, app→services); the tool catalog table
   (generated or hand-synced — say which); the integrations catalog +
   connect/authorize story (06); the grant model (writes + act-origins)
   + prompt injection (docs/09 restated; the agent-web threat model in
   one honest FINDINGS-sourced paragraph); registering a foreign server
   across the three dialects (quirk table); the adapter authoring ladder (FAKE-first,
   degradation states), github.ts the exemplar; what Phase 2.5 mounts
   later. docs/13-browser.md gets a pointer, not a rewrite.
3. **Books**: README roadmap row + phase table; `docs/02` Phase-8
   section with the shipped checklist; `prompts/README.md` row;
   `docs/06-control-api.md` gains "the MCP server speaks these verbs
   too"; sweep counts updated everywhere stated.
4. **The four-environment certification**: full sweep — with all six new
   gates (MCP, MCPWRITE, AGENTWEB, MCPMGR, INTEG, INTEGMILESTONE) — green on
   local Windows AND the three CI OSes. Record per-OS numbers in this
   pack's README (the phase-6 convention); platform finds get a one-line
   root-cause note.
5. **Pack freeze**: this README's sequence table flips to DONE rows with
   commit ranges + certification run ids (the phase-6 convention).

## Files
- `src/main/integmilestone-smoke.ts` · `scripts/qa-smokes.sh` (gate row) ·
  `docs/14-integrations.md` · `README.md` · `docs/02-mvp-and-roadmap.md` ·
  `prompts/README.md` · `docs/06-control-api.md` ·
  `prompts/phase-8/README.md` (freeze) · `prompts/phase-10/README.md`
  (Comet RESOLVED → 8/04; Branch B parked)

## Definition of Done
- INTEGMILESTONE green inside the full sweep on all four environments;
  budgets unchanged with the composed surface active.
- A newcomer can register a server, grant a workspace + an origin, and link
  a card using docs/14 alone — no code spelunking (dry-run, fresh session).
- Every book that states a gate count states the new one.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full sweep on all four environments, all six new gates in the list.

## Guardrails
- The milestone asserts EXISTING behavior composed — needing new product
  code means a step above was incomplete; fix there, stay assertion-only.
- Docs state the daemon protocol is STILL v3 after the whole phase — that
  sentence is the pack's proudest claim; verify before writing it.
- No screenshots-as-proof: the books cite smoke output and run ids, the
  gallery carries the visuals.
