import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// THE FAIL-OPEN BUDGET, pinned.
//
// MOGGING_PERCEPTION guards docs/07's interaction budgets, and two of its clauses read as
// budget checks while doing the opposite:
//
//     (homeMax   === -1 || homeMax   <= B.actionMs) &&
//     (echoMedian === -1 || echoMedian <= B.echoMs) &&
//
// -1 is the sentinel for "we measured NOTHING". It satisfied the clause. So the Board
// button's selector drifting, or pane 1 never existing, or every keystroke round trip
// timing out, each produced a GREEN gate over an unmeasured budget — and echo is the one
// line docs/07 says is never relaxed.
//
// The test LIFTS the pass expression out of the smoke's source rather than restating it.
// A restated copy would pass forever while the shipped rule rotted underneath it, which is
// the same class of defect as the sentinel itself.
const SRC = 'src/main/smokes/perception-smoke.ts'

function liftPassExpression(): string {
  const src = readFileSync(SRC, 'utf8')
  const m = /const pass =\n([\s\S]*?)\n\n {2}return \{/.exec(src)
  if (!m) throw new Error(`could not lift the pass expression from ${SRC} — its shape changed`)
  return m[1].trim()
}

interface Run {
  switchMax: number
  homeMeasured: boolean
  homeMax: number
  zoomMax: number
  echoMeasured: boolean
  echoMedian: number
  churn: { over100: number }
  sizeChurn: { over100: number }
  torrent: { over100: number }
}

const B = { actionMs: 150, echoMs: 60 }

function verdict(run: Run): boolean {
  const fn = new Function(
    'B',
    'switchMax',
    'homeMeasured',
    'homeMax',
    'zoomMax',
    'echoMeasured',
    'echoMedian',
    'churn',
    'sizeChurn',
    'torrent',
    `return (${liftPassExpression()})`
  ) as (...a: unknown[]) => boolean
  return fn(
    B,
    run.switchMax,
    run.homeMeasured,
    run.homeMax,
    run.zoomMax,
    run.echoMeasured,
    run.echoMedian,
    run.churn,
    run.sizeChurn,
    run.torrent
  )
}

const measured: Run = {
  switchMax: 100,
  homeMeasured: true,
  homeMax: 100,
  zoomMax: 100,
  echoMeasured: true,
  echoMedian: 40,
  churn: { over100: 0 },
  sizeChurn: { over100: 0 },
  torrent: { over100: 0 }
}

describe('perception smoke verdict', () => {
  it('passes a run that measured everything and stayed in budget', () => {
    expect(verdict(measured)).toBe(true)
  })

  it('FAILS when echo was never measured', () => {
    expect(verdict({ ...measured, echoMeasured: false, echoMedian: -1 })).toBe(false)
  })

  it('FAILS when the Board interaction was never measured', () => {
    // The concrete trigger: `.titlebar-right .icon-btn[aria-label="Board"]` stops matching.
    expect(verdict({ ...measured, homeMeasured: false, homeMax: -1 })).toBe(false)
  })

  it('still fails a real budget breach', () => {
    expect(verdict({ ...measured, echoMedian: B.echoMs + 1 })).toBe(false)
    expect(verdict({ ...measured, homeMax: B.actionMs + 1 })).toBe(false)
    expect(verdict({ ...measured, switchMax: B.actionMs + 1 })).toBe(false)
    expect(verdict({ ...measured, torrent: { over100: 1 } })).toBe(false)
  })

  it('names presence as its own invariant, so a miss reads as a miss', () => {
    // Both flags must appear in the shipped verdict — if a later edit folds presence back
    // into a budget clause, this is the line that notices.
    const expr = liftPassExpression()
    expect(expr).toContain('homeMeasured')
    expect(expr).toContain('echoMeasured')
    expect(expr).not.toContain('=== -1')
  })
})
