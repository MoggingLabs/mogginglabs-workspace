import { describe, expect, it } from 'vitest'
import { runtimeIsolationError } from '../../src/main/runtime-isolation'

// The MOGGING_USERDATA isolation guard (src/main/runtime-isolation.ts): an unpackaged launch
// that isolates userData WITHOUT redirecting the runtime base runs prod-shaped against the
// REAL run/v<N> dir — its build-stamp check then retires the installed app's live daemon and
// starts a retire war (observed 2026-07-15). The pure function is the behaviour; boot.ts only
// wires its non-null result to a refusal. These goldens are the refusal matrix.

const HOME_WIN = 'C:\\Users\\pedro'
const HOME_MAC = '/Users/pedro'
const HOME_LINUX = '/home/pedro'

describe('runtimeIsolationError — no MOGGING_USERDATA means no opinion', () => {
  it('passes with nothing set (plain npm run dev, any platform)', () => {
    expect(runtimeIsolationError({}, 'win32', HOME_WIN)).toBeNull()
    expect(runtimeIsolationError({}, 'darwin', HOME_MAC)).toBeNull()
    expect(runtimeIsolationError({}, 'linux', HOME_LINUX)).toBeNull()
  })

  it('passes even with a default runtime base when MOGGING_USERDATA is absent', () => {
    expect(
      runtimeIsolationError({ LOCALAPPDATA: 'C:\\Users\\pedro\\AppData\\Local' }, 'win32', HOME_WIN)
    ).toBeNull()
    expect(runtimeIsolationError({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux', HOME_LINUX)).toBeNull()
  })
})

describe('runtimeIsolationError — win32', () => {
  it('refuses MOGGING_USERDATA with LOCALAPPDATA at the OS default', () => {
    const err = runtimeIsolationError(
      { MOGGING_USERDATA: 'C:\\t\\u', LOCALAPPDATA: 'C:\\Users\\pedro\\AppData\\Local' },
      'win32',
      HOME_WIN
    )
    expect(err).toMatch(/LOCALAPPDATA/)
  })

  it('refuses case-insensitively and ignores trailing separators', () => {
    expect(
      runtimeIsolationError(
        { MOGGING_USERDATA: 'C:\\t\\u', LOCALAPPDATA: 'c:\\users\\PEDRO\\appdata\\local\\' },
        'win32',
        HOME_WIN
      )
    ).not.toBeNull()
    expect(
      runtimeIsolationError(
        { MOGGING_USERDATA: 'C:\\t\\u', LOCALAPPDATA: 'C:/Users/pedro/AppData/Local' },
        'win32',
        HOME_WIN
      )
    ).not.toBeNull()
  })

  it('refuses MOGGING_USERDATA with LOCALAPPDATA missing entirely', () => {
    expect(runtimeIsolationError({ MOGGING_USERDATA: 'C:\\t\\u' }, 'win32', HOME_WIN)).not.toBeNull()
  })

  it('passes when LOCALAPPDATA is redirected (the qa-smokes shape)', () => {
    expect(
      runtimeIsolationError(
        { MOGGING_USERDATA: 'C:\\t\\iso\\userdata', LOCALAPPDATA: 'C:\\t\\iso\\local' },
        'win32',
        HOME_WIN
      )
    ).toBeNull()
  })
})

describe('runtimeIsolationError — darwin', () => {
  it('refuses MOGGING_USERDATA with XDG_RUNTIME_DIR unset (mac default has none)', () => {
    expect(runtimeIsolationError({ MOGGING_USERDATA: '/tmp/u' }, 'darwin', HOME_MAC)).toMatch(/XDG_RUNTIME_DIR/)
  })

  it('passes when XDG_RUNTIME_DIR is redirected', () => {
    expect(
      runtimeIsolationError({ MOGGING_USERDATA: '/tmp/iso/u', XDG_RUNTIME_DIR: '/tmp/iso/local' }, 'darwin', HOME_MAC)
    ).toBeNull()
  })
})

describe('runtimeIsolationError — linux', () => {
  it('refuses MOGGING_USERDATA with XDG_RUNTIME_DIR unset', () => {
    expect(runtimeIsolationError({ MOGGING_USERDATA: '/tmp/u' }, 'linux', HOME_LINUX)).not.toBeNull()
  })

  it('refuses the systemd login default /run/user/<uid> — that IS the real tree', () => {
    expect(
      runtimeIsolationError({ MOGGING_USERDATA: '/tmp/u', XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux', HOME_LINUX)
    ).toMatch(/login default/)
  })

  it('passes when XDG_RUNTIME_DIR is redirected (the CI/harness shape)', () => {
    expect(
      runtimeIsolationError({ MOGGING_USERDATA: '/tmp/iso/u', XDG_RUNTIME_DIR: '/tmp/iso/local' }, 'linux', HOME_LINUX)
    ).toBeNull()
  })
})
