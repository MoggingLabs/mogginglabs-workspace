import { afterEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { calmMotion, scrollBehavior } from '@ui/core/a11y/motion-port'

// CALM MOTION HAD NO TWIN FOR SCROLLING.
//
// F010 · `.motion-calm`'s entire reach is CSS: animation-duration / iteration-count /
// transition-duration clamps in global.css. A scroll driven by the `behavior: 'smooth'` OPTION
// is neither an animation nor a transition, so NO class can reach it — the in-app switch,
// documented as the twin of the OS reduce-motion preference, simply had no twin here. Two call
// sites (settings/integrations.ts, settings/library.ts) scrolled smoothly through a Calm-motion
// session and through an OS `prefers-reduced-motion: reduce`.
//
// The rule is a two-parter and both halves are pinned: the helper must answer correctly, and
// nothing in src/ui may bypass it. The second half is also enforced by the MOTION gate
// (scripts/check-reduced-motion.mjs) — restated here so `npm run test` alone cannot go green
// over a reintroduced literal.

/** localStorage + matchMedia, the two things the helper reads. */
function env(opts: { calm?: boolean; osReduce?: boolean; noMatchMedia?: boolean } = {}): void {
  const store = new Map<string, string>()
  if (opts.calm) store.set('mogging.calmMotion', '1')
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v)
  })
  vi.stubGlobal('window', {
    matchMedia: opts.noMatchMedia
      ? () => {
          throw new Error('matchMedia unavailable')
        }
      : (q: string) => ({ matches: !!opts.osReduce && q.includes('reduce') })
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('scrollBehavior()', () => {
  it('is smooth when neither the switch nor the OS asks otherwise', () => {
    env()
    expect(calmMotion()).toBe(false)
    expect(scrollBehavior()).toBe('smooth')
  })

  // THE DEFECT, from the in-app side: the switch the user actually flipped.
  it('is auto under Calm motion', () => {
    env({ calm: true })
    expect(scrollBehavior()).toBe('auto')
  })

  it('is auto under the OS reduce-motion preference', () => {
    env({ osReduce: true })
    expect(scrollBehavior()).toBe('auto')
  })

  it('Calm motion wins even where the OS says nothing', () => {
    env({ calm: true, osReduce: false })
    expect(scrollBehavior()).toBe('auto')
  })

  // The helper is called from render paths; it must never be the thing that throws.
  it('falls back to smooth when matchMedia is unavailable', () => {
    env({ noMatchMedia: true })
    expect(scrollBehavior()).toBe('smooth')
  })
})

describe('no renderer scroll bypasses the helper', () => {
  const UI = resolve(import.meta.dirname, '../../src/ui')
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name)
      return e.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
    })

  it('src/ui holds no raw behavior: "smooth" outside motion-port.ts', () => {
    const offenders: string[] = []
    for (const file of walk(UI)) {
      const posix = file.split(sep).join('/')
      if (posix.endsWith('core/a11y/motion-port.ts')) continue // the helper's own home
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((text, i) => {
          if (/behavior:\s*['"`]smooth['"`]/.test(text)) offenders.push(`${posix}:${i + 1}`)
        })
    }
    expect(offenders, 'route these through scrollBehavior()').toEqual([])
  })

  // Anti-vacuity: the walk must actually be reading files. A glob that silently found nothing
  // would satisfy the assertion above forever.
  it('and the walk really covered src/ui', () => {
    const files = walk(UI)
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((f) => f.endsWith('library.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('integrations.ts'))).toBe(true)
  })

  it('both former call sites now ask the helper', () => {
    for (const rel of ['features/settings/library.ts', 'features/settings/integrations.ts']) {
      const src = readFileSync(join(UI, rel), 'utf8')
      expect(src, rel).toContain('behavior: scrollBehavior()')
    }
  })
})
