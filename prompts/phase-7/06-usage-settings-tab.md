Usage gets a FULL tab in Settings — its own entry in the page's left
section nav (the house "tab"), not a sub-block borrowed from another
section. The popover stays the glance; this tab is the feature's home:
everything configurable, everything explainable, in one place a user can
find without being told.

## Steps
1. **The nav section** (`src/ui/features/settings/`): a `Usage` entry in
   the sections array, its content in its own module (`usage.ts`, the
   `profiles-hosts.ts` pattern — index.ts stays an assembler). House
   division rhythm; 03's minimal stub (enable + cadence) is ABSORBED here
   and deleted — one home, no drift.
2. **Providers block**: one row per provider (Claude, Codex/OpenAI,
   Gemini) — detected chip (dimmed when the CLI is absent, the
   first-run detect reused), enable toggle, cadence preset (manual · 1m ·
   2m · 5m · 15m), per-provider health line ("fresh 2m ago" / stale /
   error with its human reason / unconfigured + what would fix it). A
   manual "refresh now" per row.
3. **Plans × profiles table**: every (provider, profile) pair the poller
   fans out (05) — plan label, profile name, both window gauges in
   miniature, the verdict line, active-profile identity treatment, and a
   "switch for new launches" action (the SAME path as the popover's
   Enter). This is the management view the popover's glance deliberately
   isn't.
4. **Pace & alerts block**: work-day baseline editor (days + hours),
   per-plan threshold editors (defaults 80/95, the 05 single-fire rules
   stated inline), and a "test notification" button that fires the house
   toast with fixture data (proves the wiring without waiting for a real
   threshold).
5. **The privacy story, in place**: a short panel with the ADR 0007
   words — "your sessions, read in place: nothing stored, nothing sent,
   nothing in telemetry" — and a "read the full policy" link to
   docs/12. Trust is part of the feature.
6. **USAGESET smoke** (`MOGGING_USAGESET`, env-gated, in qa-smokes.sh):
   FAKE-adapter world — the tab renders all blocks; cadence edit reaches
   the poller live (fake timer observes the new period); threshold edit
   persists and re-arms per 05's rules; the plans table matches the
   popover's tile set exactly (one data source); switch action flips the
   active profile in the store; privacy panel text present. Verdict via
   `out/usageset-result.json`.

## Files
- `src/ui/features/settings/usage.ts` (new module) ·
  `src/ui/features/settings/index.ts` (nav entry; stub removal) ·
  `src/backend/features/usage/` (settings IPC growth if a knob lacks
  one) · `src/main/usageset-smoke.ts` · `scripts/qa-smokes.sh` (gate
  row) · `src/main/gallery.ts` (tab states, both themes)

## Definition of Done
- Settings shows a Usage entry in the left nav; every knob the feature
  has lives THERE (grep proves no usage knob renders in any other
  section); the popover's gear deep-links to it.
- The plans table and the popover render from the same snapshot — no
  second data path (smoke-asserted equality).
- USAGESET gate green; gallery carries the tab in both themes; sweep
  count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- The tab CONFIGURES and explains; it never becomes a dashboard — gauges
  in the table are miniature, no charts, no history (the popover stays
  the glance; depth needs a future phase to earn it).
- Every mutation goes through the same IPC the popover uses — no
  settings-only side channel into the poller.
- Token values, plan names, and numbers stay out of telemetry (ADR
  0005); the smoke greps the events it emits.
- Design-system compliant: tokens only, division rhythm, AA on both
  themes (docs/11 ledger gets the new states).
