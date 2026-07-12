import type { UsageWindow } from '@contracts'
import type { PaceOptions } from './pace'

// The golden pace table (Phase-7/02). Deterministic UTC timestamps only —
// Jan 2026: the 5th is a Monday, the 9th a Friday. Every `text` below is the
// BINDING wording: rewording the formatter without moving these fixtures is
// a failed gate, by design (claim and probe move together).

export interface PaceGolden {
  name: string
  window: UsageWindow
  now: number
  opts: PaceOptions
  /** null = the engine must refuse to pace (caller renders snapshot age). */
  expect: null | { verdict: 'runs-out' | 'on-pace' | 'surplus'; deltaRounded: number; text: string }
}

const WEEK_MS = 604_800_000
const FIVE_H_MS = 18_000_000
const T = (iso: string): number => Date.parse(iso)

// Base weekly window: Mon Jan 5 00:00Z -> Mon Jan 12 00:00Z.
const RESET_MON = '2026-01-12T00:00:00Z'
// Friday-anchored week for the idle-weekend fixture: Fri Jan 9 -> Fri Jan 16.
const RESET_FRI = '2026-01-16T00:00:00Z'

export const PACE_GOLDENS: PaceGolden[] = [
  {
    name: 'fresh window (warm-up band, never louder than on-pace)',
    window: { label: 'Weekly', usedPct: 0, resetsAt: RESET_MON },
    now: T('2026-01-05T01:00:00Z'),
    opts: { windowMs: WEEK_MS },
    expect: { verdict: 'on-pace', deltaRounded: -1, text: 'On pace for the Weekly window' }
  },
  {
    name: 'mid-window on-pace (52% used at 50% elapsed)',
    window: { label: 'Weekly', usedPct: 52, resetsAt: RESET_MON },
    now: T('2026-01-08T12:00:00Z'),
    opts: { windowMs: WEEK_MS },
    expect: { verdict: 'on-pace', deltaRounded: 2, text: 'On pace for the Weekly window' }
  },
  {
    name: 'sprint spike (recent overlay moves the forecast before the average)',
    window: { label: 'Weekly', usedPct: 30, resetsAt: RESET_MON },
    now: T('2026-01-07T00:00:00Z'),
    opts: { windowMs: WEEK_MS, recent: { usedPct: 10, atMs: T('2026-01-06T18:00:00Z') } },
    expect: { verdict: 'runs-out', deltaRounded: 1, text: 'Ahead of pace — runs out ~Thu 07:06 at this rate' }
  },
  {
    name: 'idle weekend (calendar pacing: unused share projected honestly)',
    window: { label: 'Weekly', usedPct: 20, resetsAt: RESET_FRI },
    now: T('2026-01-12T09:00:00Z'),
    opts: { windowMs: WEEK_MS },
    expect: { verdict: 'surplus', deltaRounded: -28, text: 'Behind pace — ~59% likely unused at reset' }
  },
  {
    name: 'exhausted (100% used mid-window: runs out NOW)',
    window: { label: 'Session (5h)', usedPct: 100, resetsAt: '2026-01-07T17:00:00Z' },
    now: T('2026-01-07T15:00:00Z'),
    opts: { windowMs: FIVE_H_MS },
    expect: { verdict: 'runs-out', deltaRounded: 40, text: 'Ahead of pace — runs out ~Wed 15:00 at this rate' }
  },
  {
    name: 'reset boundary minute (97% with 1min left reads calm)',
    window: { label: 'Weekly', usedPct: 97, resetsAt: RESET_MON },
    now: T('2026-01-11T23:59:00Z'),
    opts: { windowMs: WEEK_MS },
    expect: { verdict: 'on-pace', deltaRounded: -3, text: 'On pace for the Weekly window' }
  },
  {
    name: 'unknown reset (no resetsAt): refuse to pace',
    window: { label: 'Weekly', usedPct: 40 },
    now: T('2026-01-08T12:00:00Z'),
    opts: { windowMs: WEEK_MS },
    expect: null
  },
  {
    name: 'degraded usedPct (NaN from a shape drift): refuse to pace',
    window: { label: 'Weekly', usedPct: Number.NaN, resetsAt: RESET_MON },
    now: T('2026-01-08T12:00:00Z'),
    opts: { windowMs: WEEK_MS },
    expect: null
  },
  {
    // The quit-and-come-back shape: a CLI drove the session to 85%, stopped
    // writing, and the window rolled over hours ago. Pacing the dead window
    // forecast ">100% likely unused at reset" off negative remaining time.
    name: 'expired window (reset already passed): refuse to pace',
    window: { label: 'Session (5h)', usedPct: 85, resetsAt: '2026-01-07T17:00:00Z' },
    now: T('2026-01-07T23:00:00Z'),
    opts: { windowMs: FIVE_H_MS },
    expect: null
  }
]
