The Integrations tab (Phase-8.5/05). AUDIT.md's worst grade: **F**. 1174 lines
rendering nine sections at once — registry, catalog, matrix, grants, webhooks,
keys, trail — and `.mgr-chip`, a **1px-vertical-padding button**, is the only
click target for needs-auth and drift. Restructure on the 01 primitives with
progressive disclosure. Pure reorganization: every verb, channel and
assert-relied-on hook keeps working.

## Steps
1. **Overview first**: a band on top (connected count, webhook health, trail
   teaser) then collapsible `Card` sections in task order: Connect (catalog,
   connected-first grouping intact) · Servers & registry · Workspace tool plans
   · Grants · Webhooks · Service keys · Activity trail. Each: `SectionHeader`
   with a purpose caption + its palette verbs as header actions. Collapsed
   EXCEPT Connect and any section with attention; state persists per section in
   localStorage. `.integux-intro` / `.integux-privacy` keep their classes.
2. **Collapse ≠ hide.** These MUST surface through a collapsed header (AUDIT
   § Settings): `.mgr-chip.is-needs-auth`, `.mgr-chip.is-drift-*`,
   `.toolplan-truth` pending-restart count, `.evbridge-health.is-failing`,
   `.trail-badge.is-refused`, `.cat-badge.is-draft`.
3. **Hitboxes the gate cannot see.** `.mgr-chip { padding: 1px … }` and
   `.trail-btn { padding: 2px … }` use *sanctioned* literals, so check-spacing
   is blind to them — and `.trail-btn` is the button primitive for Preview,
   Connect, Import, Apply, Remove, Adopt, Forget, Save, Clear trail, Authorize.
   Both reach ≥28px. Then clear this tab's four bucket rows: `.evbridge-ev`
   (gap 5px), `.evbridge-health` (7px), `.toolplan-head`/`-cell` (4px).
4. **Trail polish**: the 04 rhythm — outcome badges aligned, relative times
   right-set, the workspace filter a labeled `FieldGroup`, "never sent
   anywhere" in the section caption (WEBTRAIL asserts the string — keep it).
5. **Removals, in this order.** Bug #13 FIRST: `integux-smoke.ts:65` asserts
   `.palette-result`, a class that exists nowhere — half the assertion is dead,
   and REMOVE #2's safety proof ("≥2 matches; 5 remain") rests on it. Fix the
   gate, THEN remove verb `integrations:connect` (#2) and `integrations:restart`
   (#3 — its title promises a restart; `run()` scrolls the matrix and restarts
   nothing: a lying verb) and the duplicate `.integux-empty` CTA (#6). Stale
   copy: ship strings leak build phases ("a tool plan (8/09)", "8/08").
6. **SETINTEG smoke** (`MOGGING_SETINTEG`, env-gated, qa-smokes.sh): (a) the
   overview band's counts come from fixtures; (b) sections collapse/expand and
   persist across a reopen; (c) a failing-webhook fixture auto-expands Webhooks
   AND its collapsed header shows the failing chip (attention beats
   persistence); (d) every hook INTEGUX/WEBTRAIL/MCPMGR/MCPCAT click still
   resolves; (e) computed: `.mgr-chip` and `.trail-btn` hitboxes ≥28px,
   adjacent card gap ≥ `--sp-4`. Verdict `out/setinteg-result.json`.

## Files
- `settings/integrations.ts` · settings CSS block · `src/main/setinteg-smoke.ts`
  · `integux-smoke.ts` (the dead assertion) · main dispatch · qa-smokes.sh row
  · gallery (both themes)

## Definition of Done
- AUDIT grade **Integrations: F → A**. Nothing but overview + attention open.
- INTEGUX, WEBTRAIL, MCPMGR, MCPCAT, EVBRIDGE, TOOLPLAN, INTEG green — only the
  one dead assertion changed, with its reason in the commit.
- Four rows leave the `settings` bucket (6 → 2; 05b takes the last two).
  REMOVE #2/#3/#6 ✅; bug #13 ✅.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE re-run (renderer touched).

## Guardrails
- If a smoke's selector must change, change the SMOKE in the same commit with
  the reason — never leave a gate asserting a ghost.
- One-home rule: no knob leaves this module; grouping is visual.
