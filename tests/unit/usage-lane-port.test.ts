import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cappedLanesFrom, cappedSetSignature, nextLaneExpiry } from '@ui/core/usage/lane-capped'
import { __resetUsageLanes, cappedLane, getUsageLanes, onUsageLanesChange, publishUsageLanes } from '@ui/core/usage/usage-lane-port'
import type { PlanUsageView } from '@contracts'

const NOW = Date.parse('2026-08-02T12:00:00Z')
const FUTURE = new Date(NOW + 3_600_000).toISOString()
const LATER = new Date(NOW + 7 * 86_400_000).toISOString()
const PAST = new Date(NOW - 3_600_000).toISOString()

const plan = (over: Partial<PlanUsageView> = {}): PlanUsageView => ({
  providerId: 'claude',
  profileId: 'cdev',
  planLabel: 'Claude (Max 20x)',
  windows: [{ id: 'five_hour', label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE }],
  fetchedAt: NOW,
  health: 'fresh',
  ...over
})

describe('cappedLanesFrom', () => {
  it('a spent, live window is a capped lane and names its window', () => {
    const [l] = cappedLanesFrom([plan()], NOW)
    expect(l.windowLabel).toBe('Session (5h)')
    expect(l.providerId).toBe('claude')
    expect(l.evidence).toBe('fresh')
  })

  it('99.6% is NOT capped — the rounding that manufactured caps, on this side too', () => {
    const near = plan({ windows: [{ id: 'five_hour', label: 'Session (5h)', usedPct: 99.6, resetsAt: FUTURE }] })
    expect(cappedLanesFrom([near], NOW)).toEqual([])
  })

  it('a LAPSED window is not capped, however fresh the snapshot carrying it', () => {
    const lapsed = plan({ windows: [{ id: 'five_hour', label: 'Session (5h)', usedPct: 100, resetsAt: PAST }] })
    expect(cappedLanesFrom([lapsed], NOW)).toEqual([])
  })

  it('error and unconfigured assert NOTHING, even at 100%', () => {
    expect(cappedLanesFrom([plan({ health: 'error' })], NOW)).toEqual([])
    expect(cappedLanesFrom([plan({ health: 'unconfigured' })], NOW)).toEqual([])
  })

  it('STALE keeps the offer up — the last good reading still says you are locked out', () => {
    // Lowering here would hand the user a keyboard into an agent that rejects them.
    const [l] = cappedLanesFrom([plan({ health: 'stale' })], NOW)
    expect(l.evidence).toBe('stale')
  })

  it('with two windows spent it names the one that blocks you LONGEST', () => {
    const both = plan({
      windows: [
        { id: 'five_hour', label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE },
        { id: 'seven_day', label: 'Weekly', usedPct: 100, resetsAt: LATER }
      ]
    })
    expect(cappedLanesFrom([both], NOW)[0].windowLabel).toBe('Weekly')
  })

  it('a spent window with NO boundary outlasts every dated one', () => {
    const both = plan({
      windows: [
        { id: 'seven_day', label: 'Weekly', usedPct: 100, resetsAt: LATER },
        { id: 'credits', label: 'Credits', usedPct: 100 }
      ]
    })
    expect(cappedLanesFrom([both], NOW)[0].windowLabel).toBe('Credits')
  })

  it('carries resetText byte-for-byte and never recomposes it', () => {
    const withText = plan({
      windows: [{ id: 'five_hour', label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE, resetText: 'resets in 1h' }]
    })
    expect(cappedLanesFrom([withText], NOW)[0].resetText).toBe('resets in 1h')
  })

  it('nextLaneExpiry is the EARLIEST known boundary, or null', () => {
    const lanes = cappedLanesFrom(
      [plan(), plan({ profileId: 'cmain', windows: [{ id: 'seven_day', label: 'Weekly', usedPct: 100, resetsAt: LATER }] })],
      NOW
    )
    expect(nextLaneExpiry(lanes)).toBe(Date.parse(FUTURE))
    expect(nextLaneExpiry([])).toBeNull()
    expect(nextLaneExpiry(cappedLanesFrom([plan({ windows: [{ label: 'Credits', usedPct: 100 }] })], NOW))).toBeNull()
  })

  it('the signature is order-independent', () => {
    const a = cappedLanesFrom([plan(), plan({ profileId: 'cmain' })], NOW)
    const b = cappedLanesFrom([plan({ profileId: 'cmain' }), plan()], NOW)
    expect(cappedSetSignature(a)).toBe(cappedSetSignature(b))
  })
})

describe('usage-lane-port', () => {
  beforeEach(() => {
    __resetUsageLanes()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    __resetUsageLanes()
  })

  it('THE TRI-STATE: undefined before any publish, null after a publish with nothing capped', () => {
    // Conflating these two is this bug's genus: "we have not looked" was
    // indistinguishable from "we looked and it is fine".
    expect(getUsageLanes().known).toBe(false)
    expect(cappedLane('claude', 'cdev')).toBeUndefined()
    publishUsageLanes([plan({ windows: [{ id: 'five_hour', label: 'Session (5h)', usedPct: 12, resetsAt: FUTURE }] })], NOW)
    expect(getUsageLanes().known).toBe(true)
    expect(cappedLane('claude', 'cdev')).toBeNull()
  })

  it('a spent lane is answered by identity', () => {
    publishUsageLanes([plan()], NOW)
    expect(cappedLane('claude', 'cdev')?.windowLabel).toBe('Session (5h)')
    expect(cappedLane('claude', 'cmain')).toBeNull()
  })

  it('subscribing replays the current snapshot immediately', () => {
    const seen: boolean[] = []
    onUsageLanesChange((s) => seen.push(s.known))
    expect(seen).toEqual([false]) // told "not known yet", rather than nothing
    publishUsageLanes([plan()], NOW)
    expect(seen).toEqual([false, true])
  })

  it('republishing the SAME set emits once; a changed set emits again', () => {
    let emits = 0
    onUsageLanesChange(() => emits++)
    expect(emits).toBe(1) // the replay
    publishUsageLanes([plan()], NOW)
    publishUsageLanes([plan()], NOW)
    expect(emits).toBe(2)
    publishUsageLanes([], NOW)
    expect(emits).toBe(3)
  })

  it('a boundary past setTimeout’s 32-bit ceiling does not spin — it re-arms, capped at a day', () => {
    // 30 days of delay overflows a SIGNED 32-BIT timer and fires immediately;
    // waking re-arms the same overflowing timer, so it is a tight loop rather
    // than a late one. A monthly window at 100% is enough to reach it.
    const MONTH = new Date(NOW + 30 * 86_400_000).toISOString()
    let emits = 0
    onUsageLanesChange(() => emits++)
    publishUsageLanes([plan({ windows: [{ id: 'monthly', label: 'Monthly', usedPct: 100, resetsAt: MONTH }] })], NOW)
    const after = emits
    // A full day of ticks: the lane is still capped, so nothing may be emitted —
    // and crucially the run must TERMINATE rather than re-entering forever.
    vi.advanceTimersByTime(24 * 3_600_000 + 5_000)
    expect(cappedLane('claude', 'cdev')).not.toBeNull()
    expect(emits).toBe(after)
    // ...and it does still lower once the boundary genuinely passes.
    vi.setSystemTime(Date.parse(MONTH) + 2_000)
    vi.advanceTimersByTime(30 * 86_400_000)
    expect(cappedLane('claude', 'cdev')).toBeNull()
  })

  it('THE OFFER LOWERS ITSELF at the window’s reset, with no second publish', () => {
    // Before this, nothing withdrew an offer when its window rolled — even a
    // correct card stayed up until the user dismissed it.
    let emits = 0
    onUsageLanesChange(() => emits++)
    publishUsageLanes([plan({ windows: [{ id: 'five_hour', label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE }] })], NOW)
    expect(cappedLane('claude', 'cdev')).not.toBeNull()
    const before = emits
    vi.setSystemTime(Date.parse(FUTURE) + 2_000)
    vi.advanceTimersByTime(3_600_000 + 2_000)
    expect(cappedLane('claude', 'cdev')).toBeNull()
    expect(emits).toBe(before + 1)
  })
})
