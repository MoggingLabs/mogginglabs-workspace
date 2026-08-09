import type { PlanUsageView } from '@contracts'
import { cappedLanesFrom, cappedSetSignature, laneKeyOf, nextLaneExpiry, type CappedLane } from './lane-capped'

/**
 * WHICH USAGE LANES ARE SPENT, RIGHT NOW.
 *
 * PUBLISHER: the `usage` feature, from the one place it applies a snapshot.
 * SUBSCRIBER: the `agents` feature, which decides whether a pane should be
 * covered. A port so neither imports the other (workspace-info-port pattern:
 * publish / get / subscribe-with-immediate-replay).
 *
 * THE TRI-STATE IS THE POINT. `cappedLane()` answers CappedLane (spent now),
 * `null` (we looked, it is not), or `undefined` (we have not looked yet). The
 * shipped bug is what happens when the third answer does not exist: at renderer
 * mount the outbox drains before the first poll lands, and "no evidence" was
 * indistinguishable from "no cap" — except that the code was reading an EVENT,
 * so it acted on 24-hour-old news as if it were the present.
 *
 * CONTENT RULE. This carries a derived PREDICATE — "this lane is at its ceiling"
 * — plus the provider's own name for the window and the moment it ends. It
 * deliberately carries no percentage. (The rule it is easily confused with lives
 * on usage-capped-port: "ids only, never usage numbers, ADR 0002/0005". ADR 0002
 * forbids storing/proxying/metering provider CREDENTIALS — a window label is not
 * one and this port never sees one. ADR 0005 governs TELEMETRY payloads, and
 * nothing here is ever passed to getTelemetry(). The percentages themselves
 * already ride usage:changed into this very renderer and are painted in six
 * bars; a renderer-local port carrying strictly less than the snapshot it
 * derives from adds no exposure. What it must never become is a SECOND,
 * differently-derived copy of that snapshot — hence one publisher, one pure
 * derivation, and no numbers.)
 */
export interface UsageLanesSnapshot {
  /** false until the first publish. "We have not looked" is a DISTINCT answer
   *  from "we looked and nothing is capped"; conflating them is this bug's genus. */
  known: boolean
  /** Keyed by laneKeyOf(providerId, profileId). */
  capped: ReadonlyMap<string, CappedLane>
  at: number
}

const EMPTY: ReadonlyMap<string, CappedLane> = new Map()

let snapshot: UsageLanesSnapshot = { known: false, capped: EMPTY, at: 0 }
let retained: readonly PlanUsageView[] = []
let signature = ''
let expiryTimer: ReturnType<typeof setTimeout> | null = null
const subscribers = new Set<(snap: UsageLanesSnapshot) => void>()

const emit = (): void => {
  for (const cb of subscribers) cb(snapshot)
}

function armExpiry(lanes: readonly CappedLane[], now: number): void {
  if (expiryTimer) clearTimeout(expiryTimer)
  expiryTimer = null
  const next = nextLaneExpiry(lanes)
  if (next === null) return
  // A window rolling over is an event at a KNOWN instant. Waiting for the next
  // poll to notice would leave a card covering a pane for up to a full cadence
  // after the limit it names has expired — and before this, nothing lowered it
  // at all. +1s so the boundary is unambiguously behind us.
  //
  // CAPPED at a day, and re-armed on wake. setTimeout takes a SIGNED 32-BIT
  // delay: anything past ~24.8 days overflows and fires IMMEDIATELY, and since
  // waking re-arms the same overflowing timer that is a tight loop, not a late
  // one. A monthly window sitting at 100% is enough to trigger it. Re-deriving
  // once a day costs nothing (the derive is pure and emits only on change).
  const MAX_DELAY_MS = 24 * 3_600_000
  const delay = Math.min(Math.max(0, next - now) + 1_000, MAX_DELAY_MS)
  expiryTimer = setTimeout(() => {
    expiryTimer = null
    derive(retained, Date.now())
  }, delay)
}

function derive(plans: readonly PlanUsageView[], now: number): void {
  retained = plans
  const lanes = cappedLanesFrom(plans, now)
  const sig = cappedSetSignature(lanes)
  const wasKnown = snapshot.known
  const map = new Map<string, CappedLane>()
  for (const l of lanes) map.set(laneKeyOf(l.providerId, l.profileId), l)
  snapshot = { known: true, capped: map, at: now }
  armExpiry(lanes, now)
  // Level-triggered and idempotent: same set, same answer, no event. Any IPC
  // arrival order converges on the same snapshot.
  if (sig === signature && wasKnown) return
  signature = sig
  emit()
}

/** The ONE publisher calls this with the enriched snapshot. Derivation happens
 *  HERE so a second caller cannot publish a differently-derived view. */
export function publishUsageLanes(plans: readonly PlanUsageView[], now: number = Date.now()): void {
  derive(plans, now)
}

export function getUsageLanes(): UsageLanesSnapshot {
  return snapshot
}

/** CappedLane = spent now · null = looked, not spent · undefined = not known yet. */
export function cappedLane(providerId: string, profileId: string): CappedLane | null | undefined {
  if (!snapshot.known) return undefined
  return snapshot.capped.get(laneKeyOf(providerId, profileId)) ?? null
}

/** Subscribe; the current snapshot replays immediately, so a subscriber that
 *  mounts before the first publish is told `known: false` rather than nothing. */
export function onUsageLanesChange(cb: (snap: UsageLanesSnapshot) => void): () => void {
  subscribers.add(cb)
  cb(snapshot)
  return () => subscribers.delete(cb)
}

/** Test seam only. */
export function __resetUsageLanes(): void {
  if (expiryTimer) clearTimeout(expiryTimer)
  expiryTimer = null
  snapshot = { known: false, capped: EMPTY, at: 0 }
  retained = []
  signature = ''
  subscribers.clear()
}
