import { describe, expect, it } from 'vitest'
import { scrubBreadcrumb, scrubHomePaths, scrubSentryEvent } from '@contracts'
import { sourceOf } from './source-body'

// WHAT MAY LEAVE THIS MACHINE IN AN ERROR REPORT.
//
// ADR 0005 requires the Sentry adapter to set BOTH `beforeSend` and `beforeBreadcrumb`, and to
// drop console breadcrumbs. `beforeSend` deleted three top-level fields and nothing else;
// `beforeBreadcrumb` did not exist, so the SDK's default console integration attached whatever
// the app had logged to every event.
//
// This repo logs absolute paths as a matter of course — `[env] PATH repaired — <abs dirs>` —
// and an installer step reports `C:\Users\<name>\…`. A home directory IS a username.

const HOME = 'C:\\Users\\pedro'

describe('scrubHomePaths', () => {
  it('replaces the home directory with ~', () => {
    expect(scrubHomePaths('C:\\Users\\pedro\\code\\app', HOME)).toBe('~\\code\\app')
  })

  // A path can be reported with either separator on Windows, and the filesystem is
  // case-insensitive — so a scrubber that matches only the exact spelling leaks the rest.
  it('matches either separator and any case', () => {
    expect(scrubHomePaths('C:/Users/pedro/code', HOME)).toBe('~/code')
    expect(scrubHomePaths('c:\\users\\PEDRO\\code', HOME)).toBe('~\\code')
  })

  it('replaces EVERY occurrence, not just the first', () => {
    const out = scrubHomePaths(`${HOME}\\a and ${HOME}\\b`, HOME)
    expect(out).toBe('~\\a and ~\\b')
    expect(out).not.toContain('pedro')
  })

  it('leaves unrelated text alone', () => {
    expect(scrubHomePaths('nothing to see', HOME)).toBe('nothing to see')
  })

  it('does nothing when there is no home to scrub', () => {
    expect(scrubHomePaths('C:\\Users\\pedro\\x', '')).toBe('C:\\Users\\pedro\\x')
  })
})

describe('scrubBreadcrumb', () => {
  // Their content is whatever the app chose to log, which is not a category anyone reviews
  // before it ships. Dropped outright rather than scrubbed.
  it('drops console and debug breadcrumbs entirely', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'anything' }, HOME)).toBeNull()
    expect(scrubBreadcrumb({ category: 'debug', message: 'anything' }, HOME)).toBeNull()
  })

  it('keeps a breadcrumb that carries real signal, scrubbed', () => {
    const out = scrubBreadcrumb({ category: 'navigation', message: `opened ${HOME}\\proj` }, HOME)
    expect(out).toBeTruthy()
    expect(out!.message).toBe('opened ~\\proj')
  })

  it('scrubs nested data, not just the message', () => {
    const out = scrubBreadcrumb({ category: 'ui', data: { path: `${HOME}\\a`, nested: { p: `${HOME}\\b` } } }, HOME)
    expect(JSON.stringify(out)).not.toContain('pedro')
  })

  it('keeps a breadcrumb with no category', () => {
    expect(scrubBreadcrumb({ message: 'hi' }, HOME)).toBeTruthy()
  })
})

describe('scrubSentryEvent', () => {
  it('still drops the three identity fields', () => {
    const out = scrubSentryEvent({ server_name: 'host', user: { id: 'x' }, request: { url: 'u' } }, HOME)
    expect('server_name' in out).toBe(false)
    expect('user' in out).toBe(false)
    expect('request' in out).toBe(false)
  })

  it('scrubs home paths wherever they appear, not only in listed fields', () => {
    const event = {
      exception: { values: [{ value: `ENOENT ${HOME}\\missing.txt` }] },
      extra: { cwd: `${HOME}\\code` },
      tags: { path: `${HOME}\\x` }
    }
    expect(JSON.stringify(scrubSentryEvent(event, HOME))).not.toContain('pedro')
  })

  // THE case that a `beforeBreadcrumb` hook alone cannot cover: renderer breadcrumbs arrive
  // pre-embedded and never pass through main's hook.
  it('walks embedded breadcrumbs, dropping console ones and scrubbing the rest', () => {
    const out = scrubSentryEvent(
      {
        breadcrumbs: [
          { category: 'console', message: `[env] PATH repaired — ${HOME}\\bin` },
          { category: 'navigation', message: `opened ${HOME}\\proj` }
        ]
      },
      HOME
    )
    expect(out.breadcrumbs).toHaveLength(1)
    expect(JSON.stringify(out)).not.toContain('pedro')
    expect(JSON.stringify(out)).not.toContain('PATH repaired')
  })

  it('does not mutate the event it was given', () => {
    const event = { server_name: 'host', extra: { p: `${HOME}\\x` } }
    scrubSentryEvent(event, HOME)
    expect(event.server_name, 'the caller may still need it').toBe('host')
  })

  it('survives a cyclic payload rather than hanging', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => scrubSentryEvent({ extra: cyclic }, HOME)).not.toThrow()
  })
})

describe('both Sentry inits carry the hooks', () => {
  // ADR 0005 says MUST for both. The renderer's crumbs are the ones that ride pre-embedded
  // into main's event, so the drop has to happen there or it does not happen for them at all.
  it('main sets beforeSend AND beforeBreadcrumb', () => {
    const src = sourceOf('src/main/sentry-telemetry.ts')
    expect(src).toMatch(/beforeSend\(event\)/)
    expect(src).toMatch(/beforeBreadcrumb\(crumb\)/)
    expect(src).toContain('scrubSentryEvent(')
  })

  it('the renderer sets beforeBreadcrumb', () => {
    const src = sourceOf('src/renderer/telemetry.ts')
    expect(src).toMatch(/beforeBreadcrumb\(crumb\)/)
    expect(src).toContain('scrubBreadcrumb(')
  })

  it('neither hand-rolls the field deletions any more', () => {
    expect(sourceOf('src/main/sentry-telemetry.ts'), 'one policy, in contracts').not.toMatch(
      /delete e\.server_name/
    )
  })
})
