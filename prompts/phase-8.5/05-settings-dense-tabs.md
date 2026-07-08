The dense tabs: Integrations + Usage (Phase-8.5/05). The two mega-tabs
(integrations.ts ~1174 lines, usage.ts ~638 + profiles-hosts) grew a knob
per Phase-7/8 step and now render everything at once — registry, catalog
grid, matrix, grants, webhooks, trail, keys, plans, thresholds — a wall.
This step restructures BOTH on the 01 primitives with progressive
disclosure: overview first, depth on demand. Pure reorganization — every
verb, channel, and assert-relied-on hook keeps working.

## Steps
1. **Integrations tab**: an overview band on top — connected-count chip,
   webhook health, trail teaser ("N agent acts this week") — then
   collapsible `Card` sections in task order: Connect (catalog grid, the
   connected-first grouping intact) · Servers & registry · Workspace tool
   plans (the matrix) · Grants · Webhooks · Service keys · Activity trail.
   Each section: `SectionHeader` with a one-line purpose caption + its
   guided-flow / palette verbs as header actions. Sections start collapsed
   EXCEPT Connect and any section with attention (failing webhook,
   needs-auth chip) — the disclosure state persists per section in
   localStorage. The intro CTA + privacy block keep their classes
   (`.integux-intro`, `.integux-privacy`) and single-module home.
2. **Usage tab**: same treatment — overview (active plan, gauge snapshot)
   on top; Providers grid · Keys · Plans & profiles · Thresholds & alerts
   · History as collapsible cards. The provider grid's five mechanism-class
   badges and the reset-style knob survive verbatim; the plan-row/profile
   DOM the USAGESET smoke drives (`.usage-plan-row[data-profile]`,
   is-active) is untouched.
3. **Trail viewer polish**: the Activity section gets the 04 table
   rhythm — outcome badges aligned, relative times right-set, the
   workspace filter as a labeled `FieldGroup`, "never sent anywhere" copy
   in the section caption (WEBTRAIL asserts it — keep the string).
4. **Audit removals in scope**: AUDIT.md REMOVE verdicts inside these two
   tabs executed (e.g. knobs duplicated between sections) — rationale in
   the commit.
5. **SETTABS smoke** (`MOGGING_SETTABS`, env-gated, qa-smokes.sh): opens
   both tabs and asserts (a) overview bands render with live counts from
   fixtures; (b) sections collapse/expand and the state persists across a
   reopen; (c) a failing-webhook fixture auto-expands Webhooks (attention
   beats persistence); (d) every smoke-relied hook still resolves:
   `.integux-intro .integux-setup-cta`, `.integux-privacy`, `.trail-ws`,
   `.trail-activity`, `.usage-plan-row[data-profile]`, the mgr/cat DOM the
   INTEGUX gate clicks; (e) spacing: adjacent cards' gap ≥ `--sp-4`
   (computed). Verdict `out/settabs-result.json`.

## Files
- `src/ui/features/settings/integrations.ts` · `usage.ts` ·
  `profiles-hosts.ts` · settings CSS block · `src/main/settabs-smoke.ts`
  · main dispatch · qa-smokes.sh row · gallery (both themes)

## Definition of Done
- Neither tab shows more than the overview + expanded-attention sections
  on open; everything else is one disclosure away — no scroll-wall.
- INTEGUX, USAGESET, WEBTRAIL, MCPMGR, MCPCAT, VAULTKEYS gates green
  UNMODIFIED (their DOM contracts survived the restructure); SETTABS
  green; count bumped in the books.
- The one-home rule still greps clean (all § Integrations knobs in the
  one module).

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE re-run (renderer touched).

## Guardrails
- If a smoke's selector must change, change the SMOKE in the same commit
  with the reason — never leave a gate asserting a ghost.
- Collapse ≠ hide: attention states (drift chips, failing health,
  needs-auth) must surface through a collapsed section's header, always.
