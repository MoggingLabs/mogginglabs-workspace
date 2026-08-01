import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandWindowsVars, loginRcFile, mergeEnv, parseRegPath, pathEntries, rcBlock } from '@backend/platform/env-path'

// THE STALE-PATH BUG, pinned.
//
// A desktop app inherits one environment block, captured at launch, and never learns
// anything again. On the install this module was written for, `C:\Program Files\Git\cmd`
// was in the registry and NOT in the app's PATH — Git had been installed after the app
// started — so `execFile('git', …)` was ENOENT and every `git worktree add` the wizard
// issued failed with "Could not isolate every agent". These tests fix the parsing and
// merging that stand between that registry value and this process actually seeing it.

describe('parseRegPath', () => {
  const dump = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\me\\AppData\\Roaming\\npm',
    ''
  ].join('\r\n')

  it('reads the raw value and its type off a reg query dump', () => {
    expect(parseRegPath(dump)).toEqual({
      kind: 'REG_EXPAND_SZ',
      value: '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\me\\AppData\\Roaming\\npm'
    })
  })

  it('keeps the value UNEXPANDED — writing an expanded PATH back would bake in today’s home', () => {
    expect(parseRegPath(dump)?.value.startsWith('%USERPROFILE%')).toBe(true)
  })

  it('does not mistake PATHEXT (or any Path-prefixed name) for Path', () => {
    const other = 'HKEY_CURRENT_USER\\Environment\r\n    PATHEXT    REG_SZ    .COM;.EXE\r\n'
    expect(parseRegPath(other)).toBeNull()
  })

  it('is null on an empty or failed query rather than inventing an empty PATH', () => {
    expect(parseRegPath(null)).toBeNull()
    expect(parseRegPath('')).toBeNull()
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
