import type { TrailEntry } from '@contracts'

// The agent activity trail's ONE emission point (Phase-8/03 stub; 8/05 gives
// it the real per-workspace JSONL store + viewer). Instrumented now so every
// receipt/act flows through here from day one — one emission, two sinks (the
// house notify receipt + this). Entries are REFS only, never content
// (@contracts TrailEntry contract); nothing here may ever reach telemetry.

export function recordTrail(_entry: TrailEntry): void {
  // no-op until 8/05 — the call sites are the deliverable this step
}
