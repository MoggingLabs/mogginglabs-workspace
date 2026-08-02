import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  expandWindowsVars,
  loginRcFile,
  mergeEnv,
  parseRegPath,
  pathEntries,
  planWindowsPathWrite,
  rcBlock,
  type RunOutcome
} from '@backend/platform/env-path'

// THE STALE-PATH BUG, pinned.
//
// A desktop app inherits one environment block, captured at launch, and never learns
// anything again. On the install this module was written for, `C:\Program Files\Git\cmd`
// was in the registry and NOT in the app's PATH — Git had been installed after the app
// started — so `execFile('git', …)` was ENOENT and every `git worktree add` the wizard
// issued failed with "Could not isolate every agent". These tests fix the parsing and
// merging that stand between that registry value and this process actually seeing it.

/** A `reg query` that ran and exited 0. */
const ran = (stdout: string): RunOutcome => ({ ok: true, code: 0, stdout })
/** A `reg query` that did NOT run, or died: EDR, policy, a 6s timeout, spawn failure. */
const died = (code: number | null = null): RunOutcome => ({ ok: false, code, stdout: '' })

describe('parseRegPath', () => {
  const dump = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\me\\AppData\\Roaming\\npm',
    ''
  ].join('\r\n')

  it('reads the raw value and its type off a reg query dump', () => {
    expect(parseRegPath(ran(dump))).toEqual({
      kind: 'REG_EXPAND_SZ',
      value: '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\me\\AppData\\Roaming\\npm'
    })
  })

  it('keeps the value UNEXPANDED — writing an expanded PATH back would bake in today’s home', () => {
    const read = parseRegPath(ran(dump))
    expect(typeof read === 'string' ? '' : read.value.startsWith('%USERPROFILE%')).toBe(true)
  })

  it('does not mistake PATHEXT (or any Path-prefixed name) for Path', () => {
    const other = 'HKEY_CURRENT_USER\\Environment\r\n    PATHEXT    REG_SZ    .COM;.EXE\r\n'
    expect(parseRegPath(ran(other))).toBe('absent')
  })

  // The three-state answer. A query that SUCCEEDED and showed no Path row means the value
  // is genuinely missing (a fresh profile) — writing a fresh one there is correct. A query
  // that FAILED means we know nothing, and the two must never collapse together.
  it('separates a proven-absent value from a read that failed', () => {
    expect(parseRegPath(ran(''))).toBe('absent')
    expect(parseRegPath(died())).toBe('unknown')
    expect(parseRegPath(died(1))).toBe('unknown')
    expect(parseRegPath(null)).toBe('unknown')
  })
})

// THE PATH-WIPE, pinned.
//
// `run()` used to resolve null for BOTH "the value is not there" and "reg.exe timed out /
// was blocked / never spawned". persistWindows read that null as `raw = ''`, built `next`
// from the new dirs ALONE, and ran `reg add HKCU\Environment /v Path /d <next> /f` — which
// overwrites — then broadcast the result to every process started afterwards. One 6s
// timeout under AV, and the user's persisted PATH was gone with no undo and no backup.
describe('planWindowsPathWrite', () => {
  const wanted = ['C:\\Users\\me\\.npm-global']
  const user = ran('HKCU\\Environment\r\n    Path    REG_SZ    C:\\real;C:\\entries\r\n')

  it('REFUSES to write when the current PATH could not be read', () => {
    const plan = planWindowsPathWrite('unknown', 'absent', wanted)
    expect(plan.action).toBe('refuse')
  })

  it('refuses on an unreadable user PATH no matter what the machine read said', () => {
    // The guard must not be reachable-around via the second read.
    for (const machine of ['unknown', 'absent', parseRegPath(ran('  Path  REG_SZ  C:\\m\r\n'))] as const) {
      expect(planWindowsPathWrite('unknown', machine, wanted).action).toBe('refuse')
    }
  })

  it('a plan that writes always carries the existing value forward', () => {
    // The wipe, stated as an invariant: every entry we could see must survive the write.
    const plan = planWindowsPathWrite(parseRegPath(user), 'unknown', wanted)
    expect(plan.action).toBe('write')
    if (plan.action !== 'write') return
    for (const entry of ['C:\\real', 'C:\\entries']) expect(plan.value).toContain(entry)
  })

  it('appends to a real PATH, preserving the existing value and its registry type', () => {
    const plan = planWindowsPathWrite(parseRegPath(user), 'absent', wanted)
    expect(plan.action).toBe('write')
    if (plan.action !== 'write') return
    expect(plan.value).toBe('C:\\real;C:\\entries;C:\\Users\\me\\.npm-global')
    expect(plan.kind).toBe('REG_SZ')
    expect(plan.added).toEqual(wanted)
  })

  it('writes a fresh value only when absence was PROVEN, and types it REG_EXPAND_SZ', () => {
    const plan = planWindowsPathWrite('absent', 'absent', wanted)
    expect(plan.action).toBe('write')
    if (plan.action !== 'write') return
    expect(plan.value).toBe('C:\\Users\\me\\.npm-global')
    expect(plan.kind).toBe('REG_EXPAND_SZ')
  })

  it('does nothing when a machine entry already covers the dir', () => {
    const machine = ran('    Path    REG_SZ    C:\\Users\\me\\.npm-global\r\n')
    expect(planWindowsPathWrite(parseRegPath(user), parseRegPath(machine), wanted).action).toBe('noop')
  })
})

describe('expandWindowsVars', () => {
  const env = { USERPROFILE: 'C:\\Users\\me', SystemRoot: 'C:\\WINDOWS' }

  it('expands case-insensitively, the way Windows does', () => {
    expect(expandWindowsVars('%SYSTEMROOT%\\system32', env)).toBe('C:\\WINDOWS\\system32')
    expect(expandWindowsVars('%userprofile%\\bin', env)).toBe('C:\\Users\\me\\bin')
  })

  it('leaves an unknown variable literal instead of collapsing it to an empty entry', () => {
    // Collapsing would turn `%NOPE%\bin` into `\bin` — a path that resolves to the drive
    // root and silently puts a wrong directory on PATH.
    expect(expandWindowsVars('%NOPE%\\bin', env)).toBe('%NOPE%\\bin')
  })
})

describe('mergeEnv', () => {
  it('layers overlays in order', () => {
    expect(mergeEnv({ A: '1' }, { B: '2' }, { B: '3' })).toEqual({ A: '1', B: '3' })
  })

  it('ignores undefined overlays', () => {
    expect(mergeEnv({ A: '1' }, undefined)).toEqual({ A: '1' })
  })

  if (process.platform === 'win32') {
    it('REPLACES a case-variant key instead of stacking both (win32)', () => {
      // The bug this prevents: the daemon's inherited `Path` sitting beside the app's
      // repaired `PATH` in one env block, with no defined winner. A repair that lands in
      // the loser looks applied and changes nothing.
      const merged = mergeEnv({ Path: 'C:\\old' }, { PATH: 'C:\\new' })
      expect(Object.keys(merged).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH'])
      expect(merged.PATH).toBe('C:\\new')
    })
  } else {
    it('keeps distinct-case keys distinct (posix env vars are case-sensitive)', () => {
      const merged = mergeEnv({ Path: 'a' }, { PATH: 'b' })
      expect(merged.Path).toBe('a')
      expect(merged.PATH).toBe('b')
    })
  }
})

describe('pathEntries', () => {
  it('drops empty segments — a trailing separator is not a directory', () => {
    const raw = ['a', 'b'].join(process.platform === 'win32' ? ';' : ':')
    expect(pathEntries(`${raw}${process.platform === 'win32' ? ';' : ':'}`)).toEqual(['a', 'b'])
    expect(pathEntries(undefined)).toEqual([])
  })
})

describe('rcBlock', () => {
  it('is a fenced, rebuildable block — so persisting twice cannot append twice', () => {
    const block = rcBlock(['/home/me/.npm-global/bin'], 'posix')
    expect(block.startsWith('# >>> MoggingLabs Workspace PATH >>>')).toBe(true)
    expect(block.trimEnd().endsWith('# <<< MoggingLabs Workspace PATH <<<')).toBe(true)
    expect(block).toContain('export PATH="/home/me/.npm-global/bin":"$PATH"')
  })

  it('speaks fish in a fish rc', () => {
    expect(rcBlock(['/opt/x/bin'], 'fish')).toContain('fish_add_path -g "/opt/x/bin"')
  })

  it('quotes a path containing spaces', () => {
    expect(rcBlock(['/Users/me/My Tools/bin'], 'posix')).toContain('"/Users/me/My Tools/bin"')
  })
})

describe('loginRcFile', () => {
  it('picks the file each shell actually reads', () => {
    expect(loginRcFile('/bin/zsh', '/home/me').file).toBe(join('/home/me', '.zshrc'))
    expect(loginRcFile('/usr/bin/fish', '/home/me')).toEqual({
      file: join('/home/me', '.config', 'fish', 'conf.d', 'mogginglabs.fish'),
      flavour: 'fish'
    })
  })

  it('falls back to .profile for an unknown shell rather than guessing wrong', () => {
    expect(loginRcFile('/usr/bin/nu', '/home/me').file).toBe(join('/home/me', '.profile'))
    expect(loginRcFile(undefined, '/home/me').file).toBe(join('/home/me', '.profile'))
  })
})
