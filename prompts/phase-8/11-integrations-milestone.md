Freeze the pack the house way: one milestone proving all FIVE integration
directions COMPOSE, the docs page that makes the surface teachable —
including the map that keeps the WEBSITE honest — and the books carrying
the numbers.

## Steps
1. **INTEGMILESTONE smoke** (`MOGGING_INTEGMILESTONE`, env-gated, in
   qa-smokes.sh) — the composed story, one fixture world, no network:
   (a) the manager applies the house server into a FIXTURE Claude home →
   dialect-correct entry; (b) an MCP session (scripted frames, pane
   identity) lists panes, captures a tail, reads mail — grant `'none'`,
   zero write tools; (c) grant on → `list_changed`, the session claims a
   glob + `send_to_pane`s its own pane, arrival confirmed; an ungranted
   workspace sees no writes; (d) agent-web acts on the GRANTED fixture
   origin, refused on the ungranted — both trailed; (e) the fixture
   receiver gets the bridge's `notify`; a dead second webhook stalls
   nothing; (f) a FAKE PR flips to approved — chip follows, owning pane
   notified, `review-changed` fires; (g) structural: `approve` in no
   tools/list frame; no token/secret/webhook-URL/cookie in any frame,
   log, or trail; § Integrations knobs in ONE module (7/12 grep);
   receipts landed. Verdict `out/integmilestone-result.json`; budgets
   sampled DURING.
2. **`docs/14-integrations.md`** — the teachable page: the five
   directions; the tool catalog table (generated from contracts — say
   how); connect/authorize; the grant model + prompt injection (docs/09
   restated; the agent-web threat model in one FINDINGS paragraph); the
   trail (where it lives, what it never contains); the bridge payload
   schema VERBATIM + an n8n Webhook-node walkthrough; the three dialects
   (quirk table); the adapter authoring ladder (FAKE-first, github.ts
   the exemplar); **the site-honesty map**: every name in the site's
   rosters → its on-ramp (preset+date · registry · custom · bridge ·
   honest "none yet"), no name dropped; what Phase 2.5 mounts later.
   docs/13 gets a pointer.
3. **Books**: README roadmap + phase table; `docs/02` Phase-8 section;
   `prompts/README.md` row; docs/06 gains "the MCP server speaks these
   verbs too"; sweep counts COUNTED from qa-smokes.sh (live docs only,
   history stays history).
4. **Four-environment certification** (7/13 convention): ONE dispatch,
   full uncut sweeps — all ten new gates (MCP, MCPWRITE, AGENTWEB,
   WEBTRAIL, MCPMGR, MCPCAT, VAULTKEYS, EVBRIDGE, INTEG, INTEGMILESTONE)
   green on local Windows AND the three CI OSes. Per-OS numbers + run id
   in the README; platform finds get root causes; REPORT.md if earned.
5. **Pack freeze**: DONE rows with commit ranges + run ids; verify
   phase-10's pointer here survived.

## Files
- integmilestone-smoke.ts · qa-smokes.sh · `docs/14-integrations.md` ·
  `README.md` · `docs/02` · `prompts/README.md` · `docs/06` · this
  README · REPORT.md

## Definition of Done
- INTEGMILESTONE green inside the full sweep on all four environments;
  budgets unchanged with the composed surface active.
- A newcomer can register a server, grant a workspace + an origin, wire
  an n8n webhook, and link a card using docs/14 alone (dry-run).
- The site-honesty map is COMPLETE: every website-named integration
  resolves; the website team can link docs/14 without a caveat.
- Every book stating a gate count states the new one.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full sweep on all four environments, all ten new gates; nightly crons
  left enabled.

## Guardrails
- The milestone asserts EXISTING behavior composed — needing new product
  code means a step above was incomplete; fix there, stay assertion-only.
- Docs state the daemon protocol is STILL v3 after the whole phase — the
  pack's proudest claim; verify before writing it.
- No screenshots-as-proof: books cite smoke output and run ids; the
  gallery carries the visuals.
