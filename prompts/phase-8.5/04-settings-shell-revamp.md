The Settings shell revamp (Phase-8.5/04). Settings is the audit's poster
child: functional, but a wall of controls with no padding, no cards, no
visual hierarchy. This step rebuilds the SHELL — the nav, the page frame,
and the four lighter tabs (Appearance, Terminal, Privacy, Browser,
Shortcuts, About) — on the 01 primitives. The two mega-tabs (Integrations,
Usage) keep their current internals and get their own step (05); this one
gives them the same page frame so the app stops looking half-styled.

## Steps
1. **The frame** (`src/ui/features/settings/index.ts` + CSS): the
   nav+content two-column moves to the `TwoColumn` primitive — nav gets
   icons per tab, an active-state fill, grouped ordering (Workspace ·
   Agents & tools · Trust · System) with quiet group labels; content gets
   a readable max-width column, `--sp-6` page padding, and a per-tab
   `SectionHeader` (title + one-line caption saying what lives here).
   Tab-as-own-page behavior, the persisted last-tab key, and every
   `data-target` hook the smokes click stay EXACTLY as-is.
2. **Controls become components**: every bare `<input>/<select>/checkbox`
   row in the light tabs is rewrapped in `FieldGroup` (label · hint ·
   control) inside `Card`s grouping related knobs (e.g. Appearance:
   "Theme" card + "Density" card). Toggle rows get one shared row
   component (label left, switch right, hint under) — the pattern 21st.dev
   settings pages converge on, re-implemented on house tokens. Kill every
   ad-hoc px margin in the settings CSS block; tokens only.
3. **Copy pass**: each tab's captions checked against AUDIT.md — stale
   copy referencing removed flows is fixed here; the Privacy and Browser
   consent paragraphs keep their exact meaning (ADR 0002/0005 wording is
   load-bearing) but gain layout: short paragraphs in a Card, not a text
   wall.
4. **Audit removals in scope**: any Settings-shell REMOVE verdicts from
   AUDIT.md (duplicated verbs, dead toggles) are executed here with their
   rationale in the commit message.
5. **SETSHELL smoke** (`MOGGING_SETSHELL`, env-gated, qa-smokes.sh):
   opens Settings and asserts (a) the nav renders all tabs with icons +
   group labels, selection persists across a reopen (the stored-tab key);
   (b) computed styles on a light tab: content column max-width applied,
   card padding ≥ `--sp-4`, no zero-margin sibling controls (measure
   two adjacent FieldGroups' gap ≥ `--sp-3`); (c) every tab still
   switches by `.settings-nav-item[data-target=…]` click (the contract
   WEBTRAIL/USAGESET/INTEGUX rely on); (d) a theme change from the
   Appearance card still applies live (existing behavior, re-asserted);
   (e) both themes: the shell renders with AA-passing text on cards
   (reuse the Phase-5 contrast probe helper). Verdict
   `out/setshell-result.json`.

## Files
- `src/ui/features/settings/index.ts` · `src/ui/styles/global.css`
  (settings block rewritten on tokens) · `src/ui/components/` (toggle-row
  if new) · `src/main/setshell-smoke.ts` · main dispatch · qa-smokes.sh
  row · gallery (both themes)

## Definition of Done
- Every light tab reads as designed: cards, rhythm, hierarchy — zero
  bare-control walls left outside Integrations/Usage.
- All existing settings behavior + persisted keys unchanged; every gate
  that drives Settings (USAGESET, INTEGUX, KBSHORTCUTS, WEBTRAIL) still
  green untouched.
- SETSHELL green; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE re-run (renderer touched).

## Guardrails
- The DOM hooks smokes click (`data-target`, class names asserted
  elsewhere) are a compatibility surface — restyle around them.
- One-home rule stands: no knob moves out of Settings; grouping is
  visual, not relocation.
