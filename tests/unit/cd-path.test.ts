import { describe, expect, it } from 'vitest'
import { parseCdLine, resolveCdTarget, resolvePathAgainst } from '../../src/ui/features/wizard/cd-path'
import { applyCompletion, commonPrefix, completionContext, filterCompletions } from '../../src/ui/features/wizard/cd-complete'

// The wizard's cd line is shell muscle memory — so it gets shell-shaped tests.
// Since the 2026-07-16 revamp the line is cd-ONLY: a bare path or any other
// command comes back `not-cd` for the UI to refuse in place, never navigate.

const HOME_WIN = 'C:\\Users\\dev'
const BASE_WIN = 'C:\\Users\\dev\\repos\\app'
const HOME_NIX = '/home/dev'
const BASE_NIX = '/home/dev/repos/app'

const target = (input: string, base: string, home: string, previous = ''): string | null => {
  const res = resolveCdTarget(input, base, home, previous)
  return res.ok ? res.target : null
}
const reason = (input: string, base: string, home: string, previous = ''): string | null => {
  const res = resolveCdTarget(input, base, home, previous)
  return res.ok ? null : res.reason
}

describe('resolveCdTarget', () => {
  it('cd <relative> resolves against the current folder', () => {
    expect(target('cd ../other', BASE_WIN, HOME_WIN)).toBe('C:\\Users\\dev\\repos\\other')
    expect(target('cd ../other', BASE_NIX, HOME_NIX)).toBe('/home/dev/repos/other')
    expect(target('cd packages/core', BASE_NIX, HOME_NIX)).toBe('/home/dev/repos/app/packages/core')
  })

  it('ONLY cd navigates: bare paths and other commands are refused, typed', () => {
    expect(reason('../other', BASE_WIN, HOME_WIN)).toBe('not-cd')
    expect(reason('sub', BASE_NIX, HOME_NIX)).toBe('not-cd')
    expect(reason('D:\\work', BASE_WIN, HOME_WIN)).toBe('not-cd')
    expect(reason('ls -la', BASE_NIX, HOME_NIX)).toBe('not-cd')
    expect(reason('git status', BASE_NIX, HOME_NIX)).toBe('not-cd')
    expect(reason('cdd x', BASE_NIX, HOME_NIX)).toBe('not-cd') // cd-prefixed is not cd
  })

  it('absolute paths pass through; quotes are shell-friendly', () => {
    expect(target('cd D:\\work', BASE_WIN, HOME_WIN)).toBe('D:\\work')
    expect(target('cd "C:\\My Repos\\x"', BASE_WIN, HOME_WIN)).toBe('C:\\My Repos\\x')
    expect(target('cd /srv/project', BASE_NIX, HOME_NIX)).toBe('/srv/project')
  })

  it('~ means home; bare cd goes home — and cd is the only spelling that does', () => {
    expect(target('cd ~', BASE_WIN, HOME_WIN)).toBe(HOME_WIN)
    expect(target('cd', BASE_WIN, HOME_WIN)).toBe(HOME_WIN)
    expect(target('cd~', BASE_WIN, HOME_WIN)).toBe(HOME_WIN)
    expect(target('cd ~/repos', BASE_NIX, HOME_NIX)).toBe('/home/dev/repos')
    expect(target('cd proj', '', HOME_NIX)).toBe('/home/dev/proj') // home as the fallback base
    expect(reason('cd', BASE_NIX, '')).toBe('no-home')
  })

  it('.. chains and . segments normalize; the root is a floor', () => {
    expect(target('cd ../../..', BASE_NIX, HOME_NIX)).toBe('/home')
    expect(target('cd ../../../..', BASE_NIX, HOME_NIX)).toBe('/')
    expect(target('cd ./a/./b', BASE_NIX, HOME_NIX)).toBe('/home/dev/repos/app/a/b')
    expect(target('cd ../../../../..', BASE_WIN, HOME_WIN)).toBe('C:\\')
  })

  it('the cmd spellings: cd.., chdir, drive-only, /d flag, UNC ..', () => {
    expect(target('cd..', BASE_WIN, HOME_WIN)).toBe('C:\\Users\\dev\\repos')
    expect(target('chdir ../other', BASE_WIN, HOME_WIN)).toBe('C:\\Users\\dev\\repos\\other')
    expect(target('cd C:', BASE_WIN, HOME_WIN)).toBe('C:\\')
    expect(target('cd /d D:\\work', BASE_WIN, HOME_WIN)).toBe('D:\\work')
    expect(target('cd /dev', BASE_NIX, HOME_NIX)).toBe('/dev') // with-arg /d only — /dev is a path
    expect(target('cd ..', '\\\\srv\\share\\dir', '')).toBe('\\\\srv\\share')
  })

  it('cd - returns to the folder the last cd left', () => {
    expect(target('cd -', BASE_NIX, HOME_NIX, '/srv/prev')).toBe('/srv/prev')
    expect(reason('cd -', BASE_NIX, HOME_NIX)).toBe('no-previous')
  })

  it('a POSIX-absolute slip against a Windows base lands on the drive (the cmd meaning)', () => {
    expect(target('cd /repos', BASE_WIN, HOME_WIN)).toBe('C:\\repos')
  })

  it('empty input is a no-op, typed as such', () => {
    expect(reason('   ', BASE_WIN, HOME_WIN)).toBe('empty')
  })
})

describe('parseCdLine', () => {
  it('names the arg and where it starts (completion rewrites from there)', () => {
    expect(parseCdLine('cd al')).toEqual({ kind: 'cd', arg: 'al', argStart: 3 })
    expect(parseCdLine('  cd  al ')).toEqual({ kind: 'cd', arg: 'al', argStart: 6 })
    expect(parseCdLine('cd..')).toEqual({ kind: 'cd', arg: '..', argStart: 2 })
    expect(parseCdLine('CHDIR x')).toEqual({ kind: 'cd', arg: 'x', argStart: 6 })
  })
  it('everything else is not-cd, carrying the offending word', () => {
    expect(parseCdLine('ls -la')).toEqual({ kind: 'not-cd', word: 'ls' })
    expect(parseCdLine('cdd x')).toEqual({ kind: 'not-cd', word: 'cdd' })
  })
})

describe('completion math', () => {
  it('splits the argument into a folder to list and a leaf to match', () => {
    const flat = completionContext('cd al', BASE_WIN, HOME_WIN)
    expect(flat).toMatchObject({ dir: BASE_WIN, prefix: 'al', head: 'cd ', sep: '\\' })
    const nested = completionContext('cd alpha/su', BASE_NIX, HOME_NIX)
    expect(nested).toMatchObject({ dir: `${BASE_NIX}/alpha`, prefix: 'su', sep: '/' })
    const stepped = completionContext('cd ..', BASE_NIX, HOME_NIX)
    expect(stepped).toMatchObject({ dir: '/home/dev/repos', prefix: '', argDir: '../' })
    const tilde = completionContext('cd ~/re', BASE_NIX, HOME_NIX)
    expect(tilde).toMatchObject({ dir: HOME_NIX, prefix: 're' })
    expect(completionContext('ls al', BASE_NIX, HOME_NIX)).toBeNull()
  })

  it('a bare `cd` completes from the current folder, rebuilt with its space', () => {
    const bare = completionContext('cd', BASE_NIX, HOME_NIX)
    expect(bare).toMatchObject({ dir: BASE_NIX, prefix: '', head: 'cd ' })
    expect(applyCompletion(bare!, 'sub', true)).toBe('cd sub/')
  })

  it('keeps the /d flag and the typed directory part through a pick', () => {
    const flagged = completionContext('cd /d D:\\w', BASE_WIN, HOME_WIN)
    expect(flagged).toMatchObject({ dir: 'D:\\', prefix: 'w', head: 'cd /d ', argDir: 'D:\\' })
    expect(applyCompletion(flagged!, 'work', true)).toBe('cd /d D:\\work\\')
  })

  it('quotes stay through completion; spaces force them on', () => {
    const quoted = completionContext('cd "gam', BASE_NIX, HOME_NIX)
    expect(quoted).toMatchObject({ prefix: 'gam', quote: true })
    expect(applyCompletion(quoted!, 'gamma one', true)).toBe('cd "gamma one/"')
    const spacey = completionContext('cd gam', BASE_NIX, HOME_NIX)
    expect(applyCompletion(spacey!, 'gamma one', false)).toBe('cd "gamma one"')
  })

  it('filters case-insensitively and shares prefixes', () => {
    expect(filterCompletions(['Documents', 'downloads', 'src'], 'd')).toEqual(['Documents', 'downloads'])
    expect(filterCompletions(['alpha', 'Beta'], '')).toEqual(['alpha', 'Beta'])
    expect(commonPrefix(['subone', 'subtwo'])).toBe('sub')
    expect(commonPrefix(['Docs', 'docs-old'])).toBe('Docs')
    expect(commonPrefix([])).toBe('')
  })

  it('a dot prefix asks for the hidden world', () => {
    expect(completionContext('cd .hi', BASE_NIX, HOME_NIX)).toMatchObject({ wantHidden: true, prefix: '.hi' })
    expect(completionContext('cd hi', BASE_NIX, HOME_NIX)).toMatchObject({ wantHidden: false })
  })
})

describe('resolvePathAgainst (the shared path math)', () => {
  it('normalizes typed absolutes and refuses only the truly baseless', () => {
    expect(resolvePathAgainst('C:\\a\\..\\b', BASE_WIN, HOME_WIN)).toBe('C:\\b')
    expect(resolvePathAgainst('rel', '', '')).toBeNull()
    expect(resolvePathAgainst('', BASE_NIX, '')).toBeNull() // '' means home, and there is none
  })
})
