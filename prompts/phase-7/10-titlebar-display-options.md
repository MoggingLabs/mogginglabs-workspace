With ~57 providers possible, one gauge can't show them all — CodexBar
solves this with Merge Icons (combine providers into one item + a switcher),
display config (icons/labels/bars), highest-usage auto-select, and reset-time
style. Ours brings the same control to the titlebar gauge + popover.
Research: `docs/research/2026-07-codexbar-parity.md`.

## Steps
1. **Merged vs. per-provider gauge** (titlebar): a display mode —
   `merged` shows ONE gauge for the highest-severity (or pinned) provider
   with a switcher in the popover header; `pinned` shows a chosen provider;
   `auto` = highest-usage across enabled providers (CodexBar's
   auto-select). Persisted in the KV; paint-only switches (03 discipline).
2. **Gauge content options**: toggle what the icon shows — the two bars,
   a numeric `%`, the provider glyph, a compact label — the CodexBar
   "configurable icon display." Sensible default (two bars + dot badge);
   everything else opt-in, all token-driven (docs/11 rhythm).
3. **Reset-time style**: countdown (`2d 4h`) vs. absolute (`Tue 14:00`) vs.
   relative-words — one setting, applied everywhere a reset renders (popover
   rows, tab, CLI where sensible). One formatter, like the verdict.
4. **Popover ordering + density**: enabled providers only; order by
   severity (runs-out first, 09) or by a manual pin order; a compact/roomy
   density toggle for users tracking many providers. Highest-severity always
   surfaces regardless of scroll.
5. **DISPLAY smoke** (folds into `MOGGING_USAGEUI`; no new gate): FAKE
   multi-provider world — assert merged mode shows the highest-severity
   provider + switcher, auto-select picks the highest usage, pinned honors
   the pin, the gauge-content toggles change classes not layout, and the
   reset-time style flips format everywhere. Assertions in the USAGEUI JSON.

## Files
- `src/ui/features/usage/` (gauge modes, switcher, options) · `src/ui/
  features/settings/usage.ts` (the display controls live in the tab, 12) ·
  `src/backend/features/usage/` (KV-backed display prefs) · `src/main/
  usageui-smoke.ts` · `src/main/gallery.ts` (merged/pinned/auto states)

## Definition of Done
- The titlebar gauge can show merged / pinned / auto, with the popover
  switcher; gauge content + reset-time style are user-configurable and
  render identically across popover, tab, and CLI.
- Every display mode is a gallery state in both themes.
- USAGEUI gate green (grown); both perf budgets unchanged (paint-only).

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- Display options are PAINT-ONLY — no mode change refetches or reflows the
  layout; the gauge stays off the hot path (03's rule).
- Defaults stay minimal (two bars + badge): the glance must survive a user
  who never opens settings.
- No provider name or number in telemetry (ADR 0005) — display-pref events
  are the mode enum + booleans only.
- Reset-time + verdict each have ONE formatter — no surface re-spells them.
