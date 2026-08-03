import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// INVALIDATIONS ARE PER TRANSACTION, NOT PER ROW.
//
// `reconcileRows` groups rows by the file they write, opens ONE mutation per group, and then
// looped over the rows again to persist each one. The `changed` callback was emitted inside
// that second loop — once per ROW.
//
// The renderer reloads on every `changed` and blanks the panel to a spinner while it does, so
// an account-defaults fan-out (6 managed keys x 4 homes) produced 24 reloads for what is a
// handful of document writes. One document write is one thing that changed.
//
// AgentSettingsService is a large stateful class whose constructor wants a repository, a
// catalog port, a mutation coordinator and a context resolver; standing all of that up here
// would test the fakes more than the fix. The property that matters is structural and local —
// where the emission sits relative to the row loop — so it is asserted over the source.

const src = readFileSync(
  resolve(import.meta.dirname, '../../src/backend/features/agent-settings/service.ts'),
  'utf8'
)

/** The body of a method, brace-matched. */
const bodyOf = (signature: string): string => {
  const start = src.indexOf(signature)
  expect(start, `${signature} not found`).toBeGreaterThan(-1)
  // The BODY brace, which is the first one followed by a newline. A plain indexOf('{')
  // latches onto a brace in the SIGNATURE and matches an entirely wrong span (see
  // tests/unit/source-body.ts, where this is shared for new tests).
  let i = src.indexOf('{\n', start)
  let depth = 0
  const from = i
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1)
  }
  throw new Error(`unbalanced braces after ${signature}`)
}

describe('reconcileRows emits one invalidation per target', () => {
  const body = bodyOf('private async reconcileRows(')

  /** The `for (const item of group)` loop that persists each row. */
  const rowLoop = (): string => {
    const marker = 'for (const item of group) {\n          this.options.repository.saveAgentConfigOverride('
    const start = body.indexOf(marker)
    expect(start, 'the per-row persist loop moved — re-anchor this test rather than deleting it').toBeGreaterThan(-1)
    let i = body.indexOf('{', start + 'for (const item of group) '.length - 1)
    let depth = 0
    const from = i
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++
      else if (body[i] === '}' && --depth === 0) return body.slice(from, i + 1)
    }
    throw new Error('unbalanced braces in the row loop')
  }

  // THE regression.
  it('does not call changed() inside the per-row loop', () => {
    expect(rowLoop(), 'one emission per row is what made the panel flicker').not.toContain('this.options.changed')
  })

  it('accumulates the touched targets instead', () => {
    expect(rowLoop()).toContain('touched.set(')
  })

  it('emits after every group, from the accumulator', () => {
    expect(body).toMatch(/for \(const \{ provider, target \} of touched\.values\(\)\) this\.options\.changed\?\.\(/)
  })

  it('dedupes by provider AND target, so two files for one account are one event', () => {
    // A Map keyed by provider+scope+targetId. Keyed by provider alone, a fan-out across four
    // accounts would collapse into one event and three panels would keep stale values.
    expect(body).toMatch(/touched\.set\(`\$\{item\.row\.provider\}[\s\S]{0,80}targetId\}`/)
  })

  it('emits exactly once — the accumulator is drained in one place', () => {
    expect(body.match(/this\.options\.changed\?\./g) ?? []).toHaveLength(1)
  })
})

describe('promotableDefaults parses each document once', () => {
  // Not bodyOf(): this method's return TYPE contains a brace (`Promise<Array<{ … }>>`), which
  // a naive brace-match latches onto instead of the body. Anchored on two strings inside it.
  const body = (() => {
    const from = src.indexOf('async promotableDefaults(provider')
    expect(from, 'promotableDefaults not found').toBeGreaterThan(-1)
    const to = src.indexOf('\n    return out\n', from)
    expect(to, 'the promotableDefaults body no longer ends in `return out`').toBeGreaterThan(from)
    return src.slice(from, to)
  })()

  // The old shape called codec.read(text, path) with the settings loop OUTSIDE the homes loop,
  // so each home's file was fully re-parsed once per catalog setting — 422 of them for claude.
  it('reads many paths at once rather than one per setting', () => {
    expect(body).toContain('.readMany(')
    expect(body, 'a per-path read inside the loops is the thing being removed').not.toMatch(/\.read\(loaded\.text/)
  })

  it('resolves the path context once per home, not once per surface', () => {
    const surfaceLoop = body.slice(body.indexOf("for (const surface of ['runtime', 'tui'] as const)"))
    expect(surfaceLoop.slice(0, surfaceLoop.indexOf('texts.push'))).not.toContain('resolveContext')
  })

  it('still caps the SUGGESTION list at 40', () => {
    expect(body).toContain('if (out.length >= 40) break')
  })
})
