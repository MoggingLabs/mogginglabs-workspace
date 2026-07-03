Usage becomes OPERATIONAL: every plan on every profile visible and switchable,
thresholds that tap you on the shoulder through the house notify system, and
the meter feeding the Phase-4 failover machinery — see the wall BEFORE you hit
it, switch lanes in one keystroke.

## Steps
1. **Plans × profiles enumeration**: the poller fans out per (provider,
   profile) pair — a provider with three profiles shows three plan tiles.
   Popover groups by provider, orders by severity (runs-out first), and marks
   the ACTIVE profile's plan with the identity treatment (ws ramp stops, the
   selection grammar the rail already speaks). Two plans on one Claude
   account-pair? Both tiles, both gauges, always.
2. **Switch from the popover**: Enter (or click) on a plan tile switches the
   active profile for NEW launches (the Phase-4 profile mechanism — pointers
   flip, nothing re-authenticates). The tile's identity treatment follows
   immediately; running panes are untouched (their env was set at spawn — the
   popover says so in a one-line hint when relevant).
3. **Threshold notifications** (house notify/toast system, no OS spam):
   per-plan session-window thresholds (default 80% and 95%, Settings § Usage
   editable): quiet toast at 80, warning toast at 95 carrying the verdict
   line ("Ahead of pace — runs out ~Tue 14:00"). Each threshold fires ONCE
   per window (re-arms at reset). Window reset gets a single quiet
   "fresh window" toast — celebration, one notch above silence.
4. **Failover feed**: when the active plan crosses the 95% threshold AND at
   least one sibling profile on the same provider sits under 50%, the toast
   gains an action: "Fail over to {profile}" — invoking the SAME failover
   path the Phase-4 usage-limit machinery uses (one implementation, two
   triggers). Never automatic: the meter suggests, the human switches
   (auto-failover stays the Phase-4 in-pane behavior).
5. **USAGE/USAGEUI smoke growth**: fixtures stage multi-profile fan-out,
   severity ordering, threshold single-fire + re-arm across a simulated
   reset, and the failover suggestion arming condition. Assert toast copy
   equals the pace formatter output.

## Files
- `src/backend/features/usage/` (fan-out, thresholds, re-arm state) ·
  `src/ui/features/usage/` (grouping, ordering, switch action, hints) ·
  `src/ui/features/notify/` (only if a toast-action affordance is missing) ·
  settings § Usage (threshold editor) · smokes + gallery states

## Definition of Done
- N plans across M profiles all render, ordered by severity, switchable from
  the popover; the active plan carries the identity treatment.
- Thresholds fire exactly once per window with the verdict wording; reset
  re-arms them; the failover suggestion appears only under its condition and
  drives the existing failover path.
- Gallery: multi-profile popover + threshold toast + suggestion toast, both
  themes.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- Suggestion, never auto-switch: the human owns lane changes made from the
  meter (the gate philosophy — humans own the gate).
- Toast copy = formatter output verbatim (one wording source, smoke-asserted).
- Threshold state lives app-side, keyed (provider, profile, window-epoch) —
  restart must not re-fire a spent threshold (persisted like other app state).
- ADR 0005: notification events carry class + booleans, never plan names or
  numbers.
