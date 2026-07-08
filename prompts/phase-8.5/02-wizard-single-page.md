The one-page wizard (Phase-8.5/02). Three stepper screens in a MODAL become one
full-app PAGE (`#view-wizard`, beside the workspace rail): folder, grid, agents
at once, in a centred `--page-max` column with `--sp-6` gutters — you configure
the next workspace with the ones you have still in view.
AUDIT.md grades the Agents screen **F**: 8 flat siblings, no cards, `padding:
5px`, four control heights in one row, a meter grouping up toward the subtitle
instead of down toward its controls. It gets the deepest pass. All behavior
(prefill, presets, profiles, roles, remotes, worktrees, tool plans, telemetry)
is PRESERVED. § Patterns has the NN/g citation: wizards are wrong for repeated,
expert, arbitrary-order tasks. This is all three.

## Steps
1. **Structure** (`features/wizard/index.ts`): drop `createWizardStepper` + the
   per-step render fns for one `render()` composing three `Card`s in one
   scrollable body — "Where" (folder + name), "Layout" (grid picker), "Agents"
   (roster + quick-fill + preview + meter), each on `SectionHeader` +
   `FieldGroup` from 01, rhythm from `--sp-*`. Add `'wizard'` to `AppView` + the
   app-shell class loop; let the rail render for it. Sticky footer: one primary
   `Launch N terminals`; Cancel/Esc `goBack()`; the validation that gated
   Continue now gates Launch (folder unset → hint, scroll into view).
2. **Progressive disclosure**: rarely-used controls (remote host, per-slot
   profiles, swarm roles, tool plan, custom command, preset save/delete)
   collapse behind a quiet "Advanced" disclosure per card — native `<details>`.
   Auto-open a disclosure when anything inside it is already set.
3. **The live summary**: the assignment preview stays THE at-a-glance truth
   (letter chips per pane). The launch label tracks `paneCount`; the meter
   regroups DOWN with its controls. The Layout caption states count + shape,
   so the duplicate mini-preview goes.
4. **Keyboard + audit removals**: Tab order top→bottom; Enter in the folder
   field launches when valid; `wizard-port`'s prefill contract unchanged.
   Execute AUDIT.md's wizard REMOVEs: the `wizard:open` verb (twin of
   `workspace:new` — KEEP `setWizardOpener(open)`, the port), the layout
   preview, the double footer divider, three empty-node spacers, the dead
   `EmptyState` import, `createWizardStepper`. Fix the `renderAgents()`
   self-call (`:818`) — it double-renders — and give the isolate checkbox a
   REAL `disabled` (it faked one with `pointer-events: none`).
5. **WIZARDUX smoke** (`MOGGING_WIZARDUX`, env-gated, qa-smokes.sh):
   (a) three cards in ONE page, zero `.wizard-stepper`, zero `.modal-overlay`,
   RAIL up beside it; (b) computed: card padding ≥ `--sp-4`, gap ≥ `--sp-5`;
   (c) prefill lands in all three cards at once; (d) launch opens the workspace
   with the chosen mix; (e) unset folder → hint, no launch; (f) Advanced starts
   collapsed, expands. Verdict `out/wizardux-result.json`. Gallery must NOT click
   the footer primary — on one page that launches; scroll + expand instead.

## Files
- `wizard/index.ts` · `global.css` · `core/shell/view-port.ts` ·
  `shell/app-shell.ts` · `components/checkbox.ts` · `wizardux-smoke.ts` ·
  main dispatch · qa-smokes.sh · gallery

## Definition of Done
- One page, zero steppers; wizard bucket clears § Enforcement (5 → 0,
  `node scripts/check-spacing.mjs`).
- Every Phase-3..8 capability still reachable (worktrees, roles, profiles,
  remote, tool plan) — behind disclosures, not dropped.
- TEMPLATE_A/B, PRODUCT, BOARD, FIRSTRUN green; WIZARDUX green.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE re-run (renderer touched).

## Guardrails
- Layout surgery only: state model, channels, telemetry names unchanged.
- The wizard is a PAGE — the only non-grid view that keeps the rail.
- If one page can't hold a 16-pane roster, add disclosure depth, not a screen.
