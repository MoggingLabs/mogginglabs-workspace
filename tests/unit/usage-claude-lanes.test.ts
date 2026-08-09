import { describe, expect, it } from 'vitest'
import { laneLabel, laneRank, laneWindowMs, limitLanes, parseLanes, pctWindow, uniqueLaneIds } from '@backend/features/usage/claude-lanes'
import { laneKey, slugLabel } from '@backend/features/usage/lane-key'

// Claude's lane parsing, verified headless. This decides what a LANE is, and a
// lane is what the alert engine keys its single-fire state to — so a wrong
// answer here is a false `capped`, which is a pane nobody can type into.
//
// Imported from the module DIRECTLY, not the feature barrel: the barrel pulls
// claude-adapter -> claude-refresh -> platform/pty-host, which calls
// requireNative('node-pty') at module scope and cannot load under vitest.

const SESSION_MS = 5 * 3_600_000
const WEEK_MS = 7 * 86_400_000
const FUTURE = '2026-08-03T18:00:00.000Z'

const flat = (utilization: number, resets_at?: string): Record<string, unknown> => ({ utilization, ...(resets_at ? { resets_at } : {}) })

describe('lane labels and ranks (the display vocabulary, unchanged by the id split)', () => {
  it('every known lane keeps its historical label', () => {
    expect(laneLabel('five_hour')).toBe('Session (5h)')
    expect(laneLabel('seven_day')).toBe('Weekly')
    expect(laneLabel('seven_day_opus')).toBe('Weekly (Opus)')
    expect(laneLabel('seven_day_fable')).toBe('Weekly (Fable)')
    expect(laneLabel('seven_day_oauth_apps')).toBe('Weekly (OAuth apps)')
  })

  it('an unknown key derives a label rather than dropping the lane', () => {
    expect(laneLabel('seven_day_newmodel')).toBe('Weekly (Newmodel)')
    expect(laneLabel('five_hour_newmodel')).toBe('Session (Newmodel)')
    expect(laneLabel('monthly_fable')).toBe('Monthly fable')
  })

  it('window lengths come from the key, so the pace engine never parses prose', () => {
    expect(laneWindowMs('five_hour')).toBe(SESSION_MS)
    expect(laneWindowMs('five_hour_newmodel')).toBe(SESSION_MS)
    expect(laneWindowMs('seven_day_fable')).toBe(WEEK_MS)
    expect(laneWindowMs('monthly_fable')).toBe(0)
  })

  it('rank orders session -> all-models weekly -> the rest', () => {
    expect([laneRank('five_hour'), laneRank('seven_day'), laneRank('five_hour_x'), laneRank('seven_day_x')]).toEqual([0, 1, 2, 3])
  })
})

describe('lane identity is the provider key, not the label', () => {
  it('a flat lane carries its body key verbatim as the id', () => {
    const out = parseLanes({ five_hour: flat(12), seven_day_fable: flat(40, FUTURE) })
    expect(out.map((w) => w.id)).toEqual(['five_hour', 'seven_day_fable'])
    expect(out.map((w) => w.label)).toEqual(['Session (5h)', 'Weekly (Fable)'])
  })

  it('laneKey is total — an adapter that mints no id gets a slug of its label', () => {
    expect(laneKey({ id: 'five_hour', label: 'Session (5h)' })).toBe('five_hour')
    expect(laneKey({ label: 'Session (5h)' })).toBe('session-5h')
  })

  it('the id spelling and the label spelling slug apart, so a legacy ring can be told from a new one', () => {
    expect(slugLabel('five_hour')).toBe('five-hour')
    expect(slugLabel('Session (5h)')).toBe('session-5h')
    expect(slugLabel('five_hour')).not.toBe(slugLabel('Session (5h)'))
  })
})

describe('the limits[] shape maps back onto the flat keys', () => {
  it('session and weekly_all take the flat ids', () => {
    const out = limitLanes({
      limits: [
        { kind: 'session', percent: 30, resets_at: FUTURE },
        { kind: 'weekly_all', percent: 55 }
      ]
    })
    expect(out.map((w) => [w.id, w.label, w.windowMs])).toEqual([
      ['five_hour', 'Session (5h)', SESSION_MS],
      ['seven_day', 'Weekly', WEEK_MS]
    ])
  })

  it('a scoped weekly reduces its marketing name to the family the flat key uses', () => {
    const out = limitLanes({
      limits: [
        { kind: 'weekly_scoped', group: 'weekly', percent: 10, scope: { model: { display_name: 'Claude Fable 4.5' } } },
        { kind: 'weekly_scoped', group: 'weekly', percent: 20, scope: { model: { display_name: 'Opus 4.1' } } }
      ]
    })
    expect(out.map((w) => w.id)).toEqual(['seven_day_fable', 'seven_day_opus'])
    expect(out.map((w) => w.label)).toEqual(['Weekly (Claude Fable 4.5)', 'Weekly (Opus 4.1)'])
  })

  it('a scoped weekly with no usable model name still becomes a lane of its own', () => {
    const out = limitLanes({ limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 5, scope: {} }] })
    expect(out.map((w) => [w.id, w.label])).toEqual([['seven_day_model', 'Weekly (model)']])
  })

  it('an entry with no numeric percent is not a lane', () => {
    expect(limitLanes({ limits: [{ kind: 'session', percent: 'lots' }, { kind: 'weekly_all' }] })).toEqual([])
    expect(limitLanes({})).toEqual([])
    expect(limitLanes({ limits: 'nope' })).toEqual([])
  })
})

describe('the two shapes dedupe by IDENTITY, not by prose', () => {
  // The defect this closes: while Anthropic served both shapes, the flat
  // `seven_day_fable` key and the scoped entry naming "Claude Fable 4.5" were
  // ONE lane under two spellings. Comparing labels could never see that, so the
  // lane rendered twice and alerted twice.
  it('one lane served under both spellings collapses to the flat one', () => {
    const out = parseLanes({
      seven_day_fable: flat(88, FUTURE),
      limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 88, scope: { model: { display_name: 'Claude Fable 4.5' } } }]
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('seven_day_fable')
    expect(out[0]?.label).toBe('Weekly (Fable)')
  })

  it('...and does NOT over-collapse: different lanes from different shapes both survive', () => {
    const out = parseLanes({
      five_hour: flat(12),
      limits: [{ kind: 'weekly_all', percent: 60 }]
    })
    expect(out.map((w) => w.id)).toEqual(['five_hour', 'seven_day'])
  })

  it('an unseen body that reduces two lanes to one id keeps both, suffixed — a shared id would share a latch', () => {
    const out = uniqueLaneIds([
      { id: 'seven_day_opus', label: 'Weekly (Opus 4.1)', usedPct: 10 },
      { id: 'seven_day_opus', label: 'Weekly (Opus 4.5)', usedPct: 90 }
    ])
    expect(out.map((w) => w.id)).toEqual(['seven_day_opus', 'seven_day_opus_2'])
    expect(out.map((w) => w.usedPct)).toEqual([10, 90])
  })
})

describe('parseLanes ordering and shape', () => {
  it('orders session first, all-models weekly second, model lanes after', () => {
    const out = parseLanes({
      seven_day_fable: flat(40),
      five_hour: flat(12),
      seven_day: flat(30)
    })
    expect(out.map((w) => w.id)).toEqual(['five_hour', 'seven_day', 'seven_day_fable'])
  })

  it('a key whose value carries no utilization number is not a lane', () => {
    const out = parseLanes({ five_hour: flat(12), rate_limit_tier: 'default_claude_max_20x', extra_usage: { is_enabled: true } })
    expect(out.map((w) => w.id)).toEqual(['five_hour'])
  })

  it('resets_at rides through verbatim; a non-string one is simply absent', () => {
    const [a, b] = parseLanes({ five_hour: flat(12, FUTURE), seven_day: { utilization: 3, resets_at: 12345 } })
    expect(a?.resetsAt).toBe(FUTURE)
    expect(b?.resetsAt).toBeUndefined()
  })

  it('pctWindow clamps to 0..100 and refuses a non-numeric utilization', () => {
    expect(pctWindow('five_hour', 'Session (5h)', SESSION_MS, { utilization: 140 })?.usedPct).toBe(100)
    expect(pctWindow('five_hour', 'Session (5h)', SESSION_MS, { utilization: -3 })?.usedPct).toBe(0)
    expect(pctWindow('five_hour', 'Session (5h)', SESSION_MS, { utilization: 'x' })).toBeNull()
    expect(pctWindow('five_hour', 'Session (5h)', SESSION_MS, null)).toBeNull()
  })
})
