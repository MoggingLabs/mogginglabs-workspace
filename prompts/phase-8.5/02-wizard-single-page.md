The one-page wizard (Phase-8.5/02). Three stepper screens (Start · Layout ·
Agents) become ONE scannable page: folder, grid, and agent lineup at once,
with 01's ramp giving every group breathing room. AUDIT.md grades the Agents
screen **F** — 8 flat siblings, no cards, `padding: 5px`, four control
heights in one row, a fill meter grouping upward toward the subtitle instead
of down toward its own controls. It gets the deepest pass. All behavior
(prefill, presets, per-slot profiles, swarm roles, remote hosts, worktree
isolation, tool plans, telemetry) is PRESERVED — layout surgery, not a
rewrite. AUDIT.md § Patterns carries the NN/g citation settling the format:
wizards are wrong for repeated, expert, arbitrary-order tasks. All three.

## Steps
1. **Structure** (`src/ui/features/wizard/index.ts`): drop
   `createWizardStepper` + the per-step render fns for one `render()`
   composing three `Card`s in one scrollable body — "Where" (folder +
   runs-on + name), "Layout" (grid picker), "Agents" (roster + quick-fill +
   assignment preview + meter). Each card uses `SectionHeader` +
   `FieldGroup` from 01; rhythm from `--sp-*`; the modal widens so one page
   never feels crammed. Footer: one primary `Launch N terminals` + ghost
   Cancel; the validation that gated Continue now gates Launch (folder
   unset → the Where card shows its hint and scrolls into view).
2. **Progressive disclosure**: rarely-used controls (remote host — one
   option for most users, per-slot profiles, swarm roles, tool plan, custom
   command, preset save/delete) collapse behind a quiet "Advanced"
   disclosure per card. Prefill and presets auto-expand what they touch.
3. **The live summary**: the assignment preview stays THE at-a-glance truth
   (letter chips per pane). The launch label tracks `paneCount`; the fill
   meter regroups DOWN toward its own controls, not up to the subtitle.
4. **Keyboard + audit removals**: Tab order top→bottom; Enter in the folder
   field jumps to Launch when valid; Escape confirms-then-closes;
   `wizard-port`'s prefill contract unchanged. Execute AUDIT.md's wizard
   REMOVEs: the `wizard:open` verb (twin of `workspace:new`, which also has
   the Ctrl+T chip — KEEP `setWizardOpener(open)`, that's the port), the
   layout preview+caption, the double footer divider, three empty-node
   spacers, the dead `EmptyState` import. Fix the `renderAgents()` self-call
   (`wizard/index.ts:818`) — it double-renders the screen.
5. **WIZARDUX smoke** (`MOGGING_WIZARDUX`, env-gated, qa-smokes.sh):
   (a) all three cards visible in ONE page (no `.wizard-stepper` in the
   DOM); (b) computed: card padding ≥ `--sp-4`, inter-card gap ≥ `--sp-5`;
   (c) prefill lands in all three cards at once; (d) launch opens the
   workspace with the chosen mix; (e) invalid folder → inline hint, no
   launch; (f) Advanced disclosures start collapsed and expand. Verdict
   `out/wizardux-result.json`. NOTE: `gallery.ts:272,275` clicks
   `.wizard-footer .btn--primary` — keep exactly one such descendant.

## Files
- `wizard/index.ts` · `global.css` (wizard block on tokens) ·
  `components/modal.ts` · `src/main/wizardux-smoke.ts` · main dispatch ·
  qa-smokes.sh row · gallery (both themes)

## Definition of Done
- One page, zero steppers; the wizard CSS block clears the § Enforcement
  grep (16 violations → 0).
- Every Phase-3..8 capability still reachable (worktrees, roles, profiles,
  remote, tool plan) — behind disclosures, not dropped.
- TEMPLATE_A/B, PRODUCT, BOARD gates still green; WIZARDUX green.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE re-run (renderer touched).

## Guardrails
- Layout surgery only: state model, channels, telemetry names unchanged.
- If one page cannot hold a 16-pane roster comfortably, the answer is
  disclosure depth — never a second screen.
