The audit + the spacing system (Phase-8.5/01). Before restyling anything,
walk EVERY user-facing surface and write the findings down; then land the
one systemic fix every later step consumes — a spacing scale + layout
primitives in the house component library. Research 21st.dev's free
components for patterns (cards, field groups, steppers, settings pages,
file browsers) but adapt clean-room: this renderer is vanilla TS + house
CSS tokens — no React, no Tailwind, no pasted code, no new runtime deps.

## Steps
1. **The audit** (`prompts/phase-8.5/AUDIT.md`): run the app
   (`npm run dev`) and visit every surface — wizard (all 3 screens), Home
   + first-run checklist, Settings (all 8 tabs), board, palette, toasts,
   confirms, review modal, browser dock + its chrome, pane headers,
   workspace tabs, titlebar, shortcuts overlay, usage popover, update UX,
   empty states. For each: a density/spacing grade, a keep / fix / REMOVE
   verdict, and the concrete complaint (e.g. "wizard Agents screen: zero
   margin between roster rows, meter touches steppers"). REMOVE hunts
   specifically for pre-Phase-6 affordances the product outgrew —
   duplicated verbs the palette + Settings both expose, layout toolbar
   remnants absorbed by the wizard, stale copy referencing removed flows.
   Every remove names its replacement (or "none needed — dead").
2. **21st.dev research**: browse the free registry for the surfaces above;
   record in AUDIT.md § Patterns which component informed which surface
   (layout idea + spacing rhythm only, never code). Note anything NOT
   adaptable to vanilla DOM cheaply — honesty over ambition.
3. **The spacing scale** (`src/ui/styles/global.css`): tokens
   `--space-1..8` (4/8/12/16/24/32/48/64) + `--radius-*` and a max-width
   token for readable columns. Document in the tokens comment block, same
   style as the Phase-5 color system.
4. **Layout primitives** (`src/ui/components/`): `Card` (padded, bordered,
   optional header/footer), `FieldGroup` (label + hint + control with
   consistent vertical rhythm), `SectionHeader` (title + caption + optional
   action), `TwoColumn` (nav/content or form/preview). Pure `el()`-built,
   token-only CSS, exported from `components/index.ts`, AA-checked in both
   themes. Ship them USED at least once (the Settings About tab is the
   smallest customer) so they can't rot unexercised.
5. **Boundary + drift**: a grep documented in AUDIT.md § Enforcement —
   feature CSS added AFTER this step must not introduce hardcoded px
   margins/paddings (the milestone greps it). Existing violations are
   listed, not mass-fixed here; steps 02–08 burn them down per surface.

## Files
- `prompts/phase-8.5/AUDIT.md` · `src/ui/styles/global.css` ·
  `src/ui/components/card.ts` / `field-group.ts` / `section-header.ts` /
  `two-column.ts` · `components/index.ts` · gallery (About tab, both
  themes)

## Definition of Done
- AUDIT.md covers every surface listed in step 1 with grade + verdict;
  the REMOVE list is explicit and each entry has a rationale.
- The spacing tokens exist and the four primitives render in both themes,
  AA-measured, consuming only tokens.
- At least one live surface (Settings About) uses the primitives.
- 21st.dev research recorded pattern-by-pattern; zero code imported.

## Checks that must be green
- `npm run typecheck` → 0; `npm run build` ok; boundary greps clean.
- Full local sweep still green (this step is additive); PERCEPTION +
  MILESTONE re-run (renderer touched).

## Guardrails
- Audit before opinion: every later step cites AUDIT.md findings, so
  vague verdicts here cost the whole pack — be concrete.
- No behavior changes in this step beyond the About-tab dressing; the
  primitives are the deliverable, not a redesign.
- The token scale is THE spacing vocabulary from now on — later steps may
  extend it, never bypass it.
