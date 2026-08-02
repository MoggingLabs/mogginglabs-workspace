import { describe, expect, it } from 'vitest'
import { composePaneEnv, paneProcessEnv } from '@backend/features/terminal/pane-shared'

// THE WINDOWS PATH BUG, pinned.
//
// Windows env var names look up case-insensitively but are case-SENSITIVE as object keys,
// and process.env on Windows spells it `Path`. daemon-relay ships the app's live PATH with
// every spawn spec, spelled `PATH`. Layered with a plain object spread, BOTH keys survive —
// and node-pty emits its pairs in insertion order with no folding, so the pane process
// receives two PATH definitions and Windows takes the first: the stale inherited one.
//
// Every live-PATH repair the app performs was therefore landing in the losing key. Install
// an agent through the one-click setup, and its own pane could not see it.
//
// It could only ever fail on Windows — macOS has a single `PATH` key — so no gate on any
// other runner could catch it, and both PTY backends open-coded the same spread.
//
// These tests are therefore written to run everywhere: they assert on the SHAPE of the
// composed environment, not on process.platform.

/** How many PATH-ish keys survived, whatever their casing. */
const pathKeys = (env: NodeJS.ProcessEnv): string[] => Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')

/** Compose with WINDOWS semantics regardless of the runner. The bug is Windows-only, so a
 *  test that read process.platform would assert nothing on the two runners where it cannot
 *  happen — and those are two thirds of the sweep. */
const win32Env = (base: NodeJS.ProcessEnv, ...o: (Record<string, string | undefined> | undefined)[]): NodeJS.ProcessEnv =>
  composePaneEnv(true, base, ...o)

describe('paneProcessEnv', () => {
  it('collapses a case-variant overlay onto one key, keeping the overlay value', () => {
    const env = win32Env({ Path: 'C:\\stale' }, { PATH: 'C:\\fresh' })
    // The whole bug in one assertion: two survivors means the pty gets two definitions.
    expect(pathKeys(env)).toHaveLength(1)
    expect(env[pathKeys(env)[0]]).toBe('C:\\fresh')
  })

  it('keeps the LAST overlay to set a name, across several layers', () => {
    const env = win32Env({ Path: 'a' }, { PATH: 'b' }, { PATH: 'c' })
    expect(pathKeys(env)).toHaveLength(1)
    expect(env[pathKeys(env)[0]]).toBe('c')
  })

  it('leaves everything the overlays did not mention exactly as inherited', () => {
    const env = win32Env(
      { Path: 'C:\\stale', HOME: '/home/me', SSH_AUTH_SOCK: '/tmp/s', ComSpec: 'C:\\cmd.exe' },
      { PATH: 'C:\\fresh' }
    )
    expect(env.HOME).toBe('/home/me')
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/s')
    expect(env.ComSpec).toBe('C:\\cmd.exe')
  })

  it('carries the pane identity the last layer stamps', () => {
    const env = win32Env({ Path: 'a' }, { PATH: 'b' }, { MOGGING_PANE_ID: '3', MOGGING_PANE_TOKEN: 't' })
    expect(env.MOGGING_PANE_ID).toBe('3')
    expect(env.MOGGING_PANE_TOKEN).toBe('t')
    expect(pathKeys(env)).toHaveLength(1)
  })

  it('tolerates the undefined overlays both call sites really pass', () => {
    // spec.env and extraEnv are optional on the daemon path.
    const env = win32Env({ Path: 'a' }, undefined, { AIDER_ANALYTICS_LOG: '/l' }, undefined)
    expect(env.AIDER_ANALYTICS_LOG).toBe('/l')
    expect(pathKeys(env)).toHaveLength(1)
  })

  it('is a copy — composing a pane env never mutates the caller base', () => {
    const base = { Path: 'C:\\stale' }
    win32Env(base, { PATH: 'C:\\fresh' })
    expect(base).toEqual({ Path: 'C:\\stale' })
  })

  // The shipped entry point must be the parameterized one at this runner's platform —
  // otherwise the tests above could pass while the app composed some other way.
  it('paneProcessEnv is composePaneEnv at the running platform', () => {
    const base = { Path: 'C:\\stale', KEEP: '1' }
    const overlay = { PATH: 'C:\\fresh' }
    expect(paneProcessEnv(base, overlay)).toEqual(composePaneEnv(process.platform === 'win32', base, overlay))
  })

  it('layers the same way on POSIX, where distinct-case names are distinct variables', () => {
    // Not a bug there: `Path` and `PATH` really are two variables on POSIX, and folding
    // them would be wrong. The overlay still wins for its own name.
    const env = composePaneEnv(false, { Path: 'a' }, { PATH: 'b' })
    expect(env.PATH).toBe('b')
    expect(env.Path).toBe('a')
  })
})
