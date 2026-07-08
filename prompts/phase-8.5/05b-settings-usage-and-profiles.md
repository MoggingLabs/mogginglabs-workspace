Usage + Profiles & hosts (Phase-8.5/05b). The three surfaces nothing owned. The
Usage TAB (D−) renders 7 sections and 20 controls always-open. The Usage POPOVER
(D) is styled as dense chrome without being it, and reaches for **nine tokens
that do not exist**. Profiles & hosts (D) is a CRUD manager of five
placeholder-as-label inputs — AUDIT § Deviations #7 records it unowned and
recommends folding it here. One family, one bucket, one step.

## Steps
1. **Usage tab** (`settings/usage.ts`): overview on top (active plan, gauge
   snapshot), then collapsible `Card`s — Providers · Keys · Plans & profiles ·
   Thresholds & alerts · History. Collapsed except overview and attention.
   Surviving collapse, surfaced on the collapsed header: `.usage-health.is-error`,
   `.usage-fill.is-hot`. The five mechanism-class badges, the reset-style knob,
   and the DOM USAGESET drives (`.usage-class-group[data-klass]`,
   `.usage-prov-row[data-provider]`, `.usage-plan-row[data-profile]`,
   `.usage-key-*`, `.usage-display-*`) are untouched.
2. **The Usage GLANCE** (`features/usage/`) — the titlebar popover, graded D,
   owned by no step until now. Bug #4: nine usages of `--surface-1`, `--surface-3`,
   `--text-dim`, `--border-1` — **tokens that do not exist** — each falling through
   to a hardcoded gray, so the gauge track and popover foot never participate in
   the theme. Bug #5: `.usage-tile.is-active::before` uses `var(--r-md)` — a RADIUS
   token, 10px — as a vertical inset, and its `6px` fallback is a lie; same in four
   `var(--r-md, 6px)` sites. The gauge itself grades **A** (sanctioned literals).
3. **Profiles & hosts** (`profiles-hosts.ts`): the five placeholder-as-label
   inputs become `FieldGroup`s (a placeholder is not a label — it vanishes on
   focus); the two CRUD lists become `Card`s with `SectionHeader` + `EmptyState`.
   `.settings-error` already inks correctly (04). PROFILES and the gallery click
   these — they stay: `.ph-form`, `.ph-profiles`, `.ph-env-row`, `.prof-name`,
   `.prof-env-key`, `.prof-env-val`, `button[aria-label="Add profile"]`.
4. **Removals**: REMOVE #20 — `.usage-history-block` (zero rules, name-collides
   with `.usage-history-block-row`); the cadence `<select>` on **disabled**
   providers (a dead toggle); `Test notification`, whose own comment calls it "a
   fixture, not a reading" — put it behind `import.meta.env.DEV`.
5. **Spacing**: `.usage-prov-row` (4px) and `.usage-prov-controls` (26px indent)
   → tokens. With 05, the `settings` bucket reaches **0**.
6. **SETUSAGE smoke** (`MOGGING_SETUSAGE`, env-gated, qa-smokes.sh): (a) the tab
   opens to overview-only; disclosure persists across a reopen; (b) a hot fixture
   auto-expands and shows `.usage-fill.is-hot` on the collapsed header; (c) every
   USAGESET/USAGEUI hook resolves; (d) the popover's gauge track and foot border
   **change with the theme** (computed colour differs midnight vs light — bug #4's
   regression test); (e) grep-assert: no `var(--r-md` on a non-radius property;
   (f) a profile form renders `FieldGroup` labels and a refusal still lands in
   `.settings-error`. Verdict `out/setusage-result.json`.

## Files
- `settings/usage.ts` · `settings/profiles-hosts.ts` · `features/usage/` ·
  settings + usage CSS blocks · `src/main/setusage-smoke.ts` · main dispatch ·
  qa-smokes.sh row · gallery (both themes)

## Definition of Done
- AUDIT grades **Usage tab D− → A**, **Usage popover D → A**, **Profiles &
  hosts D → A**. § Deviations #7 discharged.
- USAGESET, USAGEUI, PROFILES, WEBUSAGE, USAGECLI green UNMODIFIED.
- `settings` bucket **0**; REMOVE #20 ✅; bugs #4, #5 ✅.

## Checks that must be green
- typecheck 0; build ok; boundaries clean; full local sweep.
- PERCEPTION + MILESTONE re-run.

## Guardrails
- A nonexistent token is not a style: fix the token, never the gray it falls to.
- Secret-shaped values stay refused at save (ADR 0002); no credential field.
