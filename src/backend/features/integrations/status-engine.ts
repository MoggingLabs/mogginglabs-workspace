// The status engine (ADR 0020, phase-tools/03) — pure, Electron-free. ONE verification
// vocabulary for every trigger (manual Check, the ~15-min heartbeat, page entry,
// pre-launch), so "✓ Connected · verified Xm ago" is true by construction:
//
//   · classifyProbeOutcome — the four-way read of any probe result. `network-down`
//     is the load-bearing case: a probe that failed because THIS MACHINE is offline
//     says nothing about the grant and may flip nothing (the updater's reachability
//     lesson, backend/core/net/reachability.ts — one classifier, two consumers);
//   · runBudgetedSweep — the heartbeat's shape (Nango's budgeted sync): staggered
//     with jitter so a beat never stampedes forty probes at one tick, concurrency
//     bounded, and a HARD wall-clock budget — the cursor resumes where the budget
//     cut it off, so every connection is still reached across beats and no beat
//     ever owns the event loop;
//   · AttentionLedger — verification failures as EDGES: raised once on ok→failed,
//     cleared once on failed→ok, and network-down never recorded — offline is not
//     an alarm, and repetition is not news.
//
// The TOOLPULSE gate (src/main/smokes/toolpulse-smoke.ts) bites all three against a
// fixture service, including LIVE mutation-red proofs that the network-down classifier
// and the budget are load-bearing.

import { isNetworkDownMessage } from '../../core/net/reachability'

// ── Classification ───────────────────────────────────────────────────────────

export type ProbeClassification = 'ok' | 'unauthorized' | 'network-down' | 'failed'

/**
 * Read a probe result into the engine's vocabulary. `unauthorized` is the ONE
 * failure that means the grant itself is bad (the caller downgrades to `expired`);
 * `network-down` means the machine, not the service (the caller writes NOTHING);
 * `failed` is a reached-and-refused answer (the grant stands — a failed probe never
 * un-connects a valid grant — but attention is owed).
 *
 * `_testBreakOfflineClassifier` is TEST-ONLY (the TOOLPULSE mutation-red): it makes
 * every network failure read as real, proving the gate catches a broken classifier.
 */
export function classifyProbeOutcome(
  r: { ok: boolean; unauthorized?: boolean; reason?: string },
  o: { _testBreakOfflineClassifier?: boolean } = {}
): ProbeClassification {
  if (r.ok) return 'ok'
  if (r.unauthorized) return 'unauthorized'
  if (!o._testBreakOfflineClassifier && isNetworkDownMessage(r.reason ?? '')) return 'network-down'
  return 'failed'
}

// ── The budgeted, staggered sweep ────────────────────────────────────────────

export interface SweepOptions {
  /** Hard wall-clock budget: once spent, no further probe LAUNCHES this beat. */
  budgetMs: number
  /** Concurrency bound — never one stampeding tick. */
  maxConcurrent: number
  /** Max random pre-launch stagger per probe (uniform in [0, jitterMs)). */
  jitterMs: number
  now?: () => number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
  /** TEST-ONLY (the TOOLPULSE mutation-red): ignore the budget entirely. */
  _testIgnoreBudget?: boolean
}

export interface SweepReport {
  /** Ids whose probe LAUNCHED this beat, in launch order. */
  launched: string[]
  /** Where the next beat resumes — the id after the last one launched. */
  nextCursor: number
  /** True when every id was reached within this beat's budget. */
  coveredAll: boolean
  /** The largest number of probes ever in flight at once (the stagger proof). */
  peakConcurrent: number
  stoppedForBudget: boolean
  /** A probe classified network-down: the machine is offline — the rest of the
   *  beat was skipped (probing a dead network forty times proves nothing). */
  stoppedOffline: boolean
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Run one beat over `ids`, starting at `cursor` (indices wrap — the list is a ring,
 * so a budget-cut beat resumes exactly where it stopped). The probe callback does
 * the whole verification for one id and reports its classification; this function
 * owns only the SHAPE of the beat: stagger, bound, budget, cursor.
 */
export async function runBudgetedSweep(
  ids: readonly string[],
  cursor: number,
  probe: (id: string) => Promise<ProbeClassification>,
  o: SweepOptions
): Promise<SweepReport> {
  const now = o.now ?? Date.now
  const random = o.random ?? Math.random
  const sleep = o.sleep ?? defaultSleep
  const started = now()
  const report: SweepReport = {
    launched: [],
    nextCursor: ids.length ? cursor % ids.length : 0,
    coveredAll: ids.length === 0,
    peakConcurrent: 0,
    stoppedForBudget: false,
    stoppedOffline: false
  }
  if (!ids.length) return report

  const inflight = new Set<Promise<void>>()
  let sawOffline = false
  const budgetSpent = (): boolean => !o._testIgnoreBudget && now() - started >= o.budgetMs

  for (let k = 0; k < ids.length; k++) {
    if (sawOffline) {
      report.stoppedOffline = true
      break
    }
    if (budgetSpent()) {
      report.stoppedForBudget = true
      break
    }
    // The stagger: every launch after the first waits its jitter, so even a beat
    // over one datacenter's worth of services arrives as a trickle, not a tick.
    if (k > 0 && o.jitterMs > 0) await sleep(random() * o.jitterMs)
    // The bound: never more than maxConcurrent probes in flight.
    while (inflight.size >= o.maxConcurrent) await Promise.race(inflight)
    if (sawOffline || budgetSpent()) {
      // Re-check after any wait — the budget may have expired inside it.
      if (sawOffline) report.stoppedOffline = true
      else report.stoppedForBudget = true
      break
    }
    const id = ids[(cursor + k) % ids.length]
    report.launched.push(id)
    report.nextCursor = (cursor + k + 1) % ids.length
    const run: Promise<void> = probe(id)
      .then((c) => {
        if (c === 'network-down') sawOffline = true
      })
      .catch(() => undefined)
      .finally(() => {
        inflight.delete(run)
      })
    inflight.add(run)
    report.peakConcurrent = Math.max(report.peakConcurrent, inflight.size)
  }
  // The beat settles its own launches (late results still land through the caller's
  // state writes) — but the budget already stopped new work, which is the promise.
  await Promise.all(inflight)
  report.coveredAll = report.launched.length === ids.length
  return report
}

// ── Attention, as edges ──────────────────────────────────────────────────────

export type AttentionEdge = 'raised' | 'cleared' | null

/**
 * Which connections are failing VERIFICATION right now, with edge detection so the
 * app-wide surface (rail badge + dot) rings once per failure, not once per beat.
 * Network-down records nothing: offline is a fact about the machine, not an alarm
 * about a connection — and it must never raise (the TOOLPULSE (e) law).
 */
export class AttentionLedger {
  private failing = new Set<string>()

  record(id: string, c: ProbeClassification): AttentionEdge {
    if (c === 'network-down') return null
    if (c === 'ok') return this.failing.delete(id) ? 'cleared' : null
    if (this.failing.has(id)) return null
    this.failing.add(id)
    return 'raised'
  }

  /** A disconnect takes its alarm with it — there is nothing left to fix. */
  drop(id: string): boolean {
    return this.failing.delete(id)
  }

  failingIds(): string[] {
    return [...this.failing].sort()
  }
}
