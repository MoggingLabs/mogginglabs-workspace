import { describe, expect, it } from 'vitest'
import { resolveCdTarget } from '../../src/ui/features/wizard/cd-path'

// The wizard's cd line is shell muscle memory — so it gets shell-shaped tests.

const HOME_WIN = 'C:\\Users\\dev'
const BASE_WIN = 'C:\\Users\\dev\\repos\\app'
const HOME_NIX = '/home/dev'
const BASE_NIX = '/home/dev/repos/app'

describe('resolveCdTarget', () => {
  it('cd <relative> resolves against the current folder', () => {
    expect(resolveCdTarget('cd ../other', BASE_WIN, HOME_WIN)).toBe('C:\\Users\\dev\\repos\\other')
    expect(resolveCdTarget('cd ../other', BASE_NIX, HOME_NIX)).toBe('/home/dev/repos/other')
    expect(resolveCdTarget('cd packages/core', BASE_NIX, HOME_NIX)).toBe('/home/dev/repos/app/packages/core')
  })

  it('a bare path works without the cd verb', () => {
    expect(resolveCdTarget('../other', BASE_WIN, HOME_WIN)).toBe('C:\\Users\\dev\\repos\\other')
    expect(resolveCdTarget('sub', BASE_NIX, HOME_NIX)).toBe('/home/dev/repos/app/sub')
  })

  it('absolute paths pass through; quotes are shell-friendly', () => {
    expect(resolveCdTarget('cd D:\\work', BASE_WIN, HOME_WIN)).toBe('D:\\work')
    expect(resolveCdTarget('cd "C:\\My Repos\\x"', BASE_WIN, HOME_WIN)).toBe('C:\\My Repos\\x')
    expect(resolveCdTarget('cd /srv/project', BASE_NIX, HOME_NIX)).toBe('/srv/project')
  })

  it('~ means home; bare cd goes home — with home as the fallback base', () => {
    expect(resolveCdTarget('cd ~', BASE_WIN, HOME_WIN)).toBe(HOME_WIN)
    expect(resolveCdTarget('cd', BASE_WIN, HOME_WIN)).toBe(HOME_WIN)
    expect(resolveCdTarget('cd ~/repos', BASE_NIX, HOME_NIX)).toBe('/home/dev/repos')
    expect(resolveCdTarget('proj', '', HOME_NIX)).toBe('/home/dev/proj')
  })

  it('.. chains and . segments normalize; the root is a floor', () => {
    expect(resolveCdTarget('cd ../../..', BASE_NIX, HOME_NIX)).toBe('/home')
    expect(resolveCdTarget('cd ../../../..', BASE_NIX, HOME_NIX)).toBe('/')
    expect(resolveCdTarget('cd ./a/./b', BASE_NIX, HOME_NIX)).toBe('/home/dev/repos/app/a/b')
    expect(resolveCdTarget('cd ../../../../..', BASE_WIN, HOME_WIN)).toBe('C:\\')
  })

  it('a POSIX-absolute slip against a Windows base lands on the drive (the cmd meaning)', () => {
    expect(resolveCdTarget('cd /repos', BASE_WIN, HOME_WIN)).toBe('C:\\repos')
  })

  it('empty input is a no-op', () => {
    expect(resolveCdTarget('   ', BASE_WIN, HOME_WIN)).toBeNull()
  })
})
