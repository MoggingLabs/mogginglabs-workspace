Usage must be a GLANCE: a two-bar gauge in the titlebar's right icon cluster
and a popover that answers "can I keep going, and until when?" in one click.
No page, no navigation — the reference interaction is a menu-bar dropdown.

## Steps
1. **Titlebar gauge icon** (right cluster, with the existing icons): a compact
   two-bar meter — session window on top, weekly on the bottom (the CodexBar
   icon grammar) — for the ACTIVE profile's primary plan. States: fills track
   usedPct; `runs-out` verdict tints the relevant bar warning-orange; stale
   dims the whole glyph; error/unconfigured shows the outline only. A ≥90%
   dot badge mirrors the attention-badge idiom. Paint-only state flips.
2. **The popover** (anchored dropdown, palette-grade elevation + scrim-free;
   Esc/click-away dismisses; the icon is `aria-expanded`): one tile per plan,
   grouped by provider —
   - header row: provider glyph + plan label + profile name + health chip
   - one gauge row per window: label, bar, `{usedPct}%`, reset countdown
     ("resets in 2d 4h" / absolute on hover)
   - the verdict line (step-02 wording, its severity ink)
   - footer: "as of {age}" freshness + a manual refresh glyph + a gear that
     deep-links to Settings § Usage.
   Keyboard: arrows move plan focus, Enter switches the active profile to the
   focused plan (05 wires the actual switch; render disabled until then).
3. **Settings § Usage** (new settings section, house division rhythm): per
   provider — enable toggle, cadence preset (manual · 1m · 2m · 5m · 15m),
   plus the work-day baseline editor (days + hours). Persisted app-side like
   other settings; poller consumes changes live.
4. **Gallery states**: popover open with the three verdicts represented,
   stale + error + unconfigured tiles, gauge icon at rest/warn/stale — both
   themes (FAKE adapter fixtures drive all of it).
5. **USAGEUI smoke** (`MOGGING_USAGEUI`): opens the popover on fixtures,
   asserts tile count, verdict strings (must equal the step-02 formatter
   output), countdown presence, dismiss behavior, and gauge state classes.

## Files
- `src/ui/features/usage/` (icon, popover, controller) · `src/ui/shell/
  app-shell.ts` (icon slot) · `src/ui/features/settings/index.ts` (§ Usage) ·
  `src/ui/styles/global.css` · `src/main/usageui-smoke.ts` ·
  `scripts/qa-smokes.sh` (gate row) · `src/main/gallery.ts` (states)

## Definition of Done
- The gauge lives in the titlebar cluster on all platforms; popover opens in
  <100 ms perceived (PERCEPTION-grade — measure action→painted in the smoke).
- Every visual state in the gallery, both themes, design-system compliant
  (tokens only; the division rhythm where titles head columns).
- USAGEUI gate green; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched) —
  budgets unchanged.

## Guardrails
- Quick-check surface: no scroll-heavy dashboard, no charts in v1 — gauges,
  countdowns, verdicts. Depth belongs to a later phase if ever earned.
- Popover render must not block on fetch: it opens on the cached snapshot
  instantly and refreshes in place (stale age visible, not a spinner wall).
- No usage value, plan name, or account identifier in telemetry (ADR 0005) —
  events are counts/booleans (opened, refreshed, verdict-class shown).
- Icon cluster spacing follows the machined-UI rhythm rules (docs/11).
