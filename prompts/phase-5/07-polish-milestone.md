Freeze the polish phase the house way: prove the upgrade with a COMPLETE before/after
gallery, close out every audit-ledger finding (fixed or explicitly deferred with a
reason), and hold the whole regression surface green — beauty with receipts.

## Steps
1. **Ledger close-out**: walk `docs/11-design-system.md` § Audit — every UX-NN
   finding must be ✅ fixed (with its owning step) or ⏸ deferred WITH a one-line
   reason and a target phase. Zero silent drops. Anything small still open that
   fits in an hour: fix it HERE (this step is the sweep-up — hover states, focus
   rings, spacing nits, light-theme stragglers).
2. **The gallery, complete**: regenerate `MOGGING_SHOT=all` (01's mode) + the
   window-state matrix (04) + the density matrix (06) on the FINISHED surface, both
   themes → `docs/assets/gallery/after/`. Build the before/after REPORT
   (`prompts/phase-5/REPORT.md`): per-surface pairs (01's `before/` set vs now)
   with a one-line note each; the named complaints get explicit pairs — rail
   selection, icons, corner clipping, fullscreen bar, centered command box,
   full-app Home/Settings, terminal type.
3. **Cross-cutting passes** (cheap, high-polish, often forgotten):
   • focus-visible audit — TAB through every surface; every interactive element
     shows the 01 focus ring (grep + manual shot of a focus walk)
   • motion audit — every transition ≤150 ms, `prefers-reduced-motion` kills all
     of them (assert the media block covers new animations)
   • empty states — every list/panel (recents, board lanes, claims modal, profiles,
     hosts, approvals) has a designed empty state, not blank space
   • hover/tooltip audit — every icon-only button has title + aria-label (grep).
4. **The full freeze**: `bash scripts/qa-smokes.sh` → ALL gates green (any smoke
   updated during 02–06 runs in its final form); MILESTONE + PERCEPTION numbers
   recorded — the polish must cost NOTHING (compare against the Phase-4 close
   numbers in `prompts/phase-4/README.md`).
5. **Close the books**: pack README rows → DONE with per-step receipts; README.md
   status line mentions the redesign; `docs/02` gets a Phase-5 (UI/UX) entry ✅ and
   the product-ready phase renumbered as Phase 6. This is version-worthy: prep the
   v0.3.x/v0.4.0-material release-notes section (ship it with the next release —
   don't tag inside this step unless the tree is otherwise release-clean).

## Files
- `prompts/phase-5/REPORT.md` (before/after) · `docs/assets/gallery/after/`
- `docs/11-design-system.md` (ledger close) · sweep-up CSS touches
- `prompts/phase-5/README.md` · README.md · `docs/02-mvp-and-roadmap.md`

## Definition of Done
- One command (`bash scripts/qa-smokes.sh`) green across every gate on the polished
  surface; both budgets at-or-better than the Phase-4 close numbers.
- The REPORT's before/after pairs make the upgrade obvious WITHOUT commentary; every
  audit finding accounted for; every named user complaint has a visual receipt.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full sweep green; MILESTONE + PERCEPTION recorded and budget-clean.
- Focus/motion/empty-state/tooltip audits documented in the REPORT.

## Guardrails
- No new features sneak in under "polish" — scope is strictly the audit ledger +
  the named complaints + the cross-cutting passes.
- Numbers over adjectives: every claim in the REPORT points at a shot or a probe.
- If a budget regressed anywhere in 02–06, THIS step fixes the cause — never the
  budget.
