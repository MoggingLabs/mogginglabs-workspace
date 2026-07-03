Numbers don't answer "am I okay?" — a VERDICT does. Build the pure pace engine
that turns (used%, window elapsed%, recent burn rate) into the three verdicts
with one set of house wording, used identically everywhere usage appears.

## Steps
1. **Pure module** (`src/backend/features/usage/pace.ts` — zero I/O, zero
   Date.now(): the clock is an argument): inputs are a `UsageWindow` + now +
   options; outputs a `PaceReport`:
   - `paceDelta`: signed percent = usedPct − elapsedPct (CodexBar's pace
     number: `+12%` means 12 points hotter than the linear budget line;
     renders `0%` unsigned when it rounds to zero).
   - `burnRate`: blended rate — window-average with a recent-hours overlay so
     a sprint TODAY moves the forecast before the weekly average notices.
   - `runOutAt`: projected exhaustion timestamp at `burnRate`, only when the
     projection lands BEFORE `resetsAt`.
   - `surplusPct`: projected unused share at reset, only when it lands after.
2. **The three verdicts — binding wording** (one enum, one formatter; every
   surface renders these strings and nothing else):
   - `runs-out` → **"Ahead of pace — runs out ~{Tue 14:00} at this rate"**
   - `on-pace` → **"On pace for the {weekly} window"**
   - `surplus` → **"Behind pace — ~{18%} likely unused at reset"**
   Severity mapping: runs-out = warning ink (brand orange family), on-pace =
   neutral, surplus = info-quiet. Thresholds: |paceDelta| ≤ 5 points reads
   on-pace by default (configurable later, hardcoded constant now).
3. **Work-day baseline** (CodexBar's smartest option): optionally pace against
   configured working days/hours instead of the raw calendar — a weekend of
   zero usage must not scream "Behind pace" on Monday. Options object:
   `{ workDays?: number[], workHours?: [start, end] }`; elapsedPct maps
   through the active-time integral when set.
4. **Golden fixtures**: a table of (window, now, options) → expected verdict +
   delta + ETA, covering: fresh window, mid-window on-pace, sprint spike,
   idle weekend with/without baseline, exhausted, reset boundary minute,
   zero-limit/unknown-limit degradation. Deterministic timestamps only.
5. **Smoke teeth**: extend the USAGE smoke to run the golden table and fail on
   any drift — the wording strings themselves are asserted (a reworded verdict
   is a contract change and must move the fixtures WITH it).

## Files
- `src/backend/features/usage/pace.ts` · `src/backend/features/usage/
  pace-fixtures.ts` · `src/main/usage-smoke.ts` (golden assertions) ·
  `src/contracts/usage/` (PaceReport + verdict union)

## Definition of Done
- One pure function produces verdict + delta + ETA/surplus for any window;
  USAGE smoke asserts the full golden table including exact wording.
- The formatter is the ONLY place the three strings exist (grep-proven).
- Work-day baseline changes the verdict in the fixture where it should and
  nothing else.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep (USAGE gate now includes the golden table).

## Guardrails
- Purity is the contract: no Date.now(), no fetches, no config reads inside
  the module — callers inject everything (this is what makes the goldens
  trustworthy and CI-deterministic).
- Verdicts never speculate past the data: unknown limits or a `stale` snapshot
  render the snapshot age ("as of 12m ago"), not a forecast.
- Wording changes are fixture changes — claim and probe move together.
