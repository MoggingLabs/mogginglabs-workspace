You can't polish what you haven't seen. FIRST: screenshot every surface the app has,
in both themes, and write the findings down. THEN: rebuild the color system so
workspace identity is VIVID (BridgeSpace's real edge) and every neutral is crisp —
one token layer, AA-validated, that every later step consumes.

## Steps
1. **The shot sweep**: extend `MOGGING_SHOT` into a gallery mode (`MOGGING_SHOT=all`)
   that drives the app through EVERY surface and writes numbered PNGs to
   `out/gallery/`: Home (empty + with recents), wizard (all three steps), grid with
   1/4/8/16 panes (with git chips, role chips, claims chip, remote chip, attention
   ring visible), zoomed pane, expand-col/row, board (empty + cards + bound card w/
   chips), Settings (every section incl. an open profile form + error state), review
   modal (gated + approved), palette open, pane ⋯ menu, toasts (all tones), light
   AND dark. Reuse the existing dev handles; add tiny ones only where a state can't
   be reached (e.g. a `__mogging.toast(tone)` helper).
2. **The findings ledger** (`docs/11-design-system.md` § Audit): walk the gallery
   with a ruthless checklist — contrast, alignment, spacing rhythm, dead/muddy
   colors, inconsistent radii/weights/paddings, orphaned styles, hover/focus states
   missing, light-theme neglect. Every finding gets an ID (UX-01…), a screenshot
   reference, and an owner step (02–06 or "this step"). Fix the PURE-TOKEN wins
   immediately (muddy grays, low-contrast text-lo, inconsistent border colors).
3. **Vivid workspace identity ramps**: today `colorForOrdinal` yields one flat color
   per workspace and the UI barely uses it. Build a RAMP per identity color via
   `color-mix` tokens: `--ws-accent` (vivid, AA on dark+light), `--ws-tint` (~12%
   surface wash), `--ws-edge` (heavy border weight), `--ws-glow` (soft outer). Expose
   them as per-tab CSS custom properties (the rail item sets `--ws-accent: <color>`
   inline — the ONE sanctioned inline style). Recalibrate the 8 identity colors for
   vividness + hue distinctness + AA (document the measured ratios in a table).
4. **Neutral + semantic pass**: re-tune `--bg-*`, `--border`, `--text-*` for crisp
   separation (surfaces must read as LAYERS, not near-identical grays); semantic
   colors (success/danger/attention/info) checked on BOTH themes; kill any remaining
   hard-coded hex in feature CSS (grep-audit: only tokens + the theme files may
   define colors — `.pane-remote`'s #58a6ff etc. become tokens).
5. **Document**: `docs/11-design-system.md` — the token catalog (name, purpose, dark/
   light values, contrast table), the spacing/radius/type scales as they ACTUALLY
   are, and the audit ledger. Re-run the gallery after the token pass: before/after
   pairs committed under `docs/assets/gallery/` (small PNGs).

## Files
- `src/main/shot.ts` (gallery mode) · dev-handle touches
- `src/ui/styles/global.css` (tokens) · `src/ui/features/workspace/model.ts`
  (identity colors) · `docs/11-design-system.md` · `docs/assets/gallery/`

## Definition of Done
- `out/gallery/` reproduces every surface in one command, both themes.
- The ledger exists with owner steps; token-level findings already fixed.
- Workspace ramps + recalibrated neutrals live as tokens with a written AA table;
  zero hard-coded colors outside the token/theme layer (grep proves it).

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- SMOKE + PERCEPTION + MILESTONE still green (token changes touch everything).
- Both-theme gallery re-generated AFTER changes and eyeballed — no regressions.

## Guardrails
- Audit findings you can't fix in this step get LOGGED, not silently fixed —
  later steps own them (scope discipline).
- Identity vividness never sacrifices AA: measure, don't eyeball, contrast.
- No selector changes in this step — pure CSS/token/docs (smokes must not notice).
