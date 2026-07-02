The rail is the app's steering wheel and today its selection state is timid: a thin
brand-orange outline, identical for every workspace, while the workspace's OWN color
sits as a dead swatch behind the name. BridgeSpace does this better — make selection
VIVID and IDENTITY-COLORED: the whole button lights up in that workspace's color.

## Steps
1. **The selected treatment** (uses 01's per-tab `--ws-*` ramp): the active
   `.workspace-tab` gets the full-button treatment —
   • 1px outline in `--ws-accent` (vivid, not the muted swatch tone)
   • an inner wash: `background: --ws-tint` across the ENTIRE button
   • a HEAVY left edge: 3px solid `--ws-accent` (the lateral bar that reads
     "you are here" — border-left or an inset box-shadow so layout doesn't shift)
   • the workspace icon + name pick up `--ws-accent` ink.
   Unselected tabs: quiet neutrals, the identity color only on the icon glyph —
   selection must be the ONLY loud thing.
2. **Attention stays semantically distinct**: the attention ring/badge remains BRAND
   ORANGE on every workspace (it means "needs you", not "which one is active") — but
   restyle it to coexist with vivid selection: the latched ring becomes a soft outer
   glow + the numeric badge keeps high contrast; when a tab is BOTH selected and
   ringing, both must read (glow outside the outline). Screenshot this exact combo.
   The `.workspace-tab[data-attention]` attribute contract is UNTOUCHED.
3. **States matrix**: hover (tint at ~6%), active-press, keyboard focus-visible
   (2px focus ring, not the selection outline), drag-reorder ghost — all tokenized,
   both themes. Rail header/footer alignment + the `+` button get the same pass.
4. **Micro-typography**: name weight/size vs count badges re-tuned per 01's scale;
   truncation with a fade (not "…") if it fits the budget cheaply.
5. **Verify**: gallery shots — 3 workspaces (distinct identity colors), one selected,
   one ringing, one both; light + dark; collapsed rail variant. Geometry probe: the
   left bar renders INSIDE the button box (no layout shift on select — assert equal
   tab widths selected vs not).

## Files
- `src/ui/styles/global.css` (rail block) · `src/ui/features/workspace/controller.ts`
  (makeTab sets the `--ws-*` inline custom properties; class logic only if needed)
- `docs/11-design-system.md` (selection spec) · gallery updates

## Definition of Done
- The selected workspace is unmistakable at a glance AND tells you WHICH workspace
  by color; attention keeps its own visual language; the two compose cleanly.
- No layout shift between states; both themes AA; collapsed rail inherits the
  treatment (left bar + icon ink).

## Checks that must be green
- `npm run typecheck` → 0; build ok.
- ATTENTION + MILESTONE smokes still green (both assert rail DOM/behavior); SMOKE +
  PERCEPTION green (rail renders on every frame path).
- Before/after shots in the gallery; the states-matrix shot committed.

## Guardrails
- `.workspace-tab`, `data-attention`, `.ws-attn` count badge: contracts frozen —
  restyle, never rename (MILESTONE asserts the ring on tab index 0).
- Selection color comes ONLY from the 01 ramp tokens — no per-feature hex.
- The rail is on the hot path (re-renders on attention churn): no new per-frame
  work, no transition longer than 150 ms, PERCEPTION must not notice.
