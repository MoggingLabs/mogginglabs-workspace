import { describe, expect, it } from 'vitest'
import { claimsOverlap, normalizeClaimPattern } from '@contracts'

// THE FILE-CLAIM REFEREE.
//
// Two agents must not both be granted a claim that may cover the same file. The rule the
// module states is conservative-deny: only a PURE-LITERAL segment mismatch proves the branches
// diverge, and anything else denies, "because the ledger is a referee, not an oracle".
//
// The implementation tested `x.includes('*')`, which treats `?` and `[…]` as ordinary text. So
// `router?.ts` vs `router1.ts` read as proven divergence and BOTH claims were granted — the
// exact opposite of the stated rule, on a pattern shape the docstring names explicitly.

describe('claimsOverlap denies unless divergence is PROVEN', () => {
  it('identical and prefix-contained claims overlap', () => {
    expect(claimsOverlap('src/a.ts', 'src/a.ts')).toBe(true)
    expect(claimsOverlap('src', 'src/deep/a.ts')).toBe(true)
    expect(claimsOverlap('src/deep/a.ts', 'src')).toBe(true)
  })

  it('a literal mismatch is the ONE thing that separates them', () => {
    expect(claimsOverlap('src/a.ts', 'src/b.ts')).toBe(false)
    expect(claimsOverlap('src/one/a.ts', 'src/two/a.ts')).toBe(false)
    expect(claimsOverlap('docs/x.md', 'src/x.md')).toBe(false)
  })

  it('** swallows everything after it', () => {
    expect(claimsOverlap('src/**', 'src/deep/nested/a.ts')).toBe(true)
    expect(claimsOverlap('**', 'anything/at/all')).toBe(true)
  })

  it('a * segment may match, so the walk continues rather than concluding', () => {
    expect(claimsOverlap('src/*.ts', 'src/a.ts')).toBe(true)
    expect(claimsOverlap('src/*/a.ts', 'src/one/a.ts')).toBe(true)
    // A wildcard earlier does not excuse a literal mismatch later.
    expect(claimsOverlap('src/*/a.ts', 'src/one/b.ts')).toBe(false)
  })

  // THE regression. Both of these may name the same file.
  it('treats ? and […] as wildcards, not as literal text', () => {
    expect(claimsOverlap('src/router?.ts', 'src/router1.ts')).toBe(true)
    expect(claimsOverlap('src/router[12].ts', 'src/router1.ts')).toBe(true)
    expect(claimsOverlap('src/router1.ts', 'src/router?.ts'), 'symmetric').toBe(true)
    expect(claimsOverlap('src/a[bc]d.ts', 'src/abd.ts')).toBe(true)
  })

  it('is symmetric', () => {
    const pairs: Array<[string, string]> = [
      ['src/a.ts', 'src/b.ts'],
      ['src/**', 'src/a.ts'],
      ['src/router?.ts', 'src/router1.ts'],
      ['src', 'src/a.ts']
    ]
    for (const [a, b] of pairs) expect(claimsOverlap(a, b), `${a} vs ${b}`).toBe(claimsOverlap(b, a))
  })
})

describe('normalizeClaimPattern', () => {
  it('refuses traversal and empty segments', () => {
    expect(normalizeClaimPattern('../secrets')).toBeNull()
    expect(normalizeClaimPattern('src/../../etc')).toBeNull()
    expect(normalizeClaimPattern('src//a.ts')).toBeNull()
  })

  it('accepts an ordinary relative pattern', () => {
    expect(normalizeClaimPattern('src/**/*.ts')).toBe('src/**/*.ts')
  })
})
