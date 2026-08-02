import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeValues } from '@backend/features/agent-settings/merge'

// HOW ONE CONFIG LAYER COMBINES WITH THE LAYERS BENEATH IT.
//
// `AgentConfigMerge` has three members and the merge took a BOOLEAN — the call site passed
// `loaded.source.merge === 'deep-concat-arrays'`. Narrowing three values to one bit made
// 'replace' and 'deep' the SAME function: both recursed into objects and unioned their keys.
//
// A layer declaring merge: 'replace' therefore could not replace anything object-valued. The
// nearer layer's object was merged into the farther one's, so the effective value shown to the
// user contained keys from a file the provider does not read at that path. Aider declares
// 'replace' on all three of its layers.
//
// `base` is what the further layers already produced; `next` is the nearer layer.

describe("'replace' — the nearer layer IS the value", () => {
  // THE regression: identical inputs, and only this mode may not recurse.
  it('does not merge object keys', () => {
    expect(mergeValues({ a: 1 }, { b: 2 }, 'replace')).toEqual({ b: 2 })
  })

  it('does not merge nested objects either', () => {
    expect(mergeValues({ model: { name: 'x', temp: 1 } }, { model: { name: 'y' } }, 'replace')).toEqual({
      model: { name: 'y' }
    })
  })

  it('replaces arrays whole', () => {
    expect(mergeValues([1, 2], [3], 'replace')).toEqual([3])
  })

  it('still yields the nearer layer for scalars and null', () => {
    expect(mergeValues(1, 2, 'replace')).toBe(2)
    expect(mergeValues({ a: 1 }, null, 'replace')).toBeNull()
  })
})

describe("'deep' — recurse, but arrays are replaced", () => {
  it('unions object keys', () => {
    expect(mergeValues({ a: 1 }, { b: 2 }, 'deep')).toEqual({ a: 1, b: 2 })
  })

  it('recurses into nested objects, nearer layer winning per key', () => {
    expect(mergeValues({ m: { name: 'x', temp: 1 } }, { m: { name: 'y' } }, 'deep')).toEqual({
      m: { name: 'y', temp: 1 }
    })
  })

  it('replaces arrays rather than concatenating them', () => {
    expect(mergeValues([1], [2], 'deep')).toEqual([2])
  })
})

describe("'deep-concat-arrays' — the only mode that unions arrays", () => {
  it('appends what is not already there', () => {
    expect(mergeValues([1], [2], 'deep-concat-arrays')).toEqual([1, 2])
  })

  it('is a UNION, not an append — a duplicate does not repeat', () => {
    expect(mergeValues([1, 2], [2, 3], 'deep-concat-arrays')).toEqual([1, 2, 3])
  })

  it('dedupes structurally, not just by reference', () => {
    expect(mergeValues([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }], 'deep-concat-arrays')).toEqual([
      { id: 'a' },
      { id: 'b' }
    ])
  })

  it('carries the mode down into nested arrays', () => {
    expect(mergeValues({ tools: ['x'] }, { tools: ['y'] }, 'deep-concat-arrays')).toEqual({ tools: ['x', 'y'] })
  })
})

describe('the call site hands over the MODE, not a comparison', () => {
  // The defect was never in the merge — it was the argument. A correct three-way merge called
  // with `merge === 'deep-concat-arrays'` is the same bug with more code, and no test of this
  // function alone can see that. Asserted over the caller's source.
  const src = readFileSync(
    resolve(import.meta.dirname, '../../src/backend/features/agent-settings/service.ts'),
    'utf8'
  )
  const call = src.slice(src.indexOf('mergeValues('), src.indexOf('\n', src.indexOf('mergeValues(')))

  it('passes loaded.source.merge through', () => {
    expect(call).toContain('loaded.source.merge')
  })

  it('does not collapse the mode to a comparison on the way in', () => {
    expect(call, `the third argument must be the mode itself: ${call}`).not.toMatch(/merge\s*===/)
  })
})

describe('shared by every mode', () => {
  it('an absent base is the nearer layer, whatever the mode', () => {
    for (const m of ['replace', 'deep', 'deep-concat-arrays'] as const) {
      expect(mergeValues(undefined, { a: 1 }, m), m).toEqual({ a: 1 })
    }
  })

  it('a type mismatch takes the nearer layer rather than half-merging', () => {
    for (const m of ['deep', 'deep-concat-arrays'] as const) {
      expect(mergeValues({ a: 1 }, [1], m), m).toEqual([1])
      expect(mergeValues([1], { a: 1 }, m), m).toEqual({ a: 1 })
      expect(mergeValues({ a: 1 }, null, m), m).toBeNull()
    }
  })

  it('does not mutate the layer it was handed', () => {
    const base = { a: 1, list: [1] }
    mergeValues(base, { b: 2, list: [2] }, 'deep-concat-arrays')
    expect(base).toEqual({ a: 1, list: [1] })
  })

  // The three modes must be distinguishable. If any two agree on every input, the parameter
  // is decorative and the boolean is back.
  it('the three modes genuinely differ', () => {
    const base = { a: 1, list: [1] }
    const next = { b: 2, list: [2] }
    const results = (['replace', 'deep', 'deep-concat-arrays'] as const).map((m) =>
      JSON.stringify(mergeValues(base, next, m))
    )
    expect(new Set(results).size, `modes collapsed: ${results.join(' | ')}`).toBe(3)
  })
})
