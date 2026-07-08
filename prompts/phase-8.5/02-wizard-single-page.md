The one-page wizard (Phase-8.5/02). Three stepper screens (Start · Layout ·
Agents) become ONE scannable page: the user sees folder, grid, and agent
lineup at once, with the 01 spacing scale giving every group real breathing
room. The Agents screen was the worst offender (zero margin between roster
rows, meter touching steppers, quick-fill chips crammed) — it gets the
deepest pass. All existing behavior (prefill, presets, per-slot profiles,
swarm roles, remote hosts, worktree isolation, tool-plan picker, telemetry
events) is PRESERVED — this is layout surgery, not a rewrite of the model.

## Steps
1. **Structure** (`src/ui/features/wizard/index.ts`): drop the
   `createWizardStepper` + per-step render fns for one `render()` composing
   three `Card`s in a single scrollable body — "Where" (folder + runs-on +
   name), "Layout" (grid picker + live mini preview inline, not a separate
   screen), "Agents" (roster + quick-fill + assignment preview + meter).
   Each card uses `SectionHeader` + `FieldGroup` from 01; vertical rhythm
   from `--space-*`; the modal widens (a `wizard` variant size bump) so one
   page never feels crammed — cramming is the failure this step exists to
   fix. Footer: single primary `Launch N terminals` + ghost Cancel; the
   validation that used to gate Continue now gates Launch (folder unset →
   the Where card shows the inline hint, page scrolls to it).
2. **Progressive disclosure inside cards**: rarely-used controls (remote
   host, per-slot profiles, swarm roles, tool plan) collapse behind a
   quiet "Advanced" disclosure per card — visible defaults, one click to
   depth, per AUDIT.md's density findings. Prefill (`WizardPrefill`) and
   preset application auto-expand whatever they touch.
3. **The live summary**: the Agents card's assignment preview stays THE
   at-a-glance truth (letter chips per pane, provider colors). The launch
   button label tracks `paneCount`; the fill meter and "N of M panes
   assigned" copy keep working against the one-page model.
4. **Keyboard flow**: Tab order runs top→bottom through cards; Enter in
   the folder field jumps to Launch when the form is valid; Escape
   confirms-then-closes exactly as today. `wizard-port` prefill contract
   and `wizard:open` palette verb unchanged.
5. **WIZARDUX smoke** (`MOGGING_WIZARDUX`, env-gated, qa-smokes.sh):
   opens the wizard and asserts (a) all three cards visible in ONE page
   (no `.wizard-stepper` in the DOM); (b) computed styles: card padding ≥
   `--space-4` and inter-card gap ≥ `--space-5` (the spacing claim,
   measured); (c) prefill (`{cwd, paneCount, mix}`) lands in all three
   cards at once; (d) launch from the single page opens the workspace with
   the chosen mix (reuse TEMPLATE-smoke assertions); (e) invalid folder →
   inline hint + no launch; (f) the Advanced disclosures start collapsed
   and expand. Verdict `out/wizardux-result.json`.

## Files
- `src/ui/features/wizard/index.ts` · `src/ui/styles/global.css` (wizard
  block rewritten on tokens) · `src/ui/components/modal.ts` (size variant
  if needed) · `src/main/wizardux-smoke.ts` · main/index.ts dispatch ·
  qa-smokes.sh row · gallery (both themes)

## Definition of Done
- One page, zero steppers; every group padded on the 01 scale — no
  hardcoded px in the wizard CSS block.
- Every Phase-3..8 wizard capability still reachable (worktrees, roles,
  profiles, remote, tool plan) — behind disclosures, not dropped.
- TEMPLATE_A/B, PRODUCT, and BOARD gates still green (they drive the
  wizard); WIZARDUX green; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE re-run (renderer touched).

## Guardrails
- Layout surgery only: the wizard's state model, channels, and telemetry
  event names do not change.
- If one page genuinely cannot hold 16-pane roster comfortably, the
  answer is disclosure depth — never a second screen.
