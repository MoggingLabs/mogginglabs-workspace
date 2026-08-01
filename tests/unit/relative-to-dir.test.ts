import { describe, expect, it } from 'vitest'
import { relativeToDir } from '@contracts/domain/cwd'

// The one containment rule behind "type a path into a pane" (11/06 recut): the drop
// side — pane-drop for a drag, insertTextFor for send-to-pane — relativizes against
// the RECEIVING pane's cwd through this, so every answer to "is this under that"
// agrees, renderer-wide, without host path APIs.

describe('relativeToDir', () => {
  it('relativizes a child, keeping the caller\'s own separators', () => {
    expect(relativeToDir('C:\\repo\\src\\main.ts', 'C:\\repo')).toBe('src\\main.ts')
    expect(relativeToDir('/home/dev/repo/src/main.ts', '/home/dev/repo')).toBe('src/main.ts')
  })

  it('is separator-boundary safe: /a/bc is not under /a/b', () => {
    expect(relativeToDir('/a/bc', '/a/b')).toBeNull()
    expect(relativeToDir('C:\\repo-two\\f.ts', 'C:\\repo')).toBeNull()
  })

  it('returns null for the dir itself — "" would be a lie', () => {
    expect(relativeToDir('C:\\repo', 'C:\\repo')).toBeNull()
    expect(relativeToDir('/home/dev', '/home/dev/')).toBeNull()
  })

  it('is case-insensitive ONLY for drive-lettered paths', () => {
    expect(relativeToDir('c:\\Repo\\src\\a.ts', 'C:\\repo')).toBe('src\\a.ts')
    expect(relativeToDir('/home/Dev/x', '/home/dev')).toBeNull() // POSIX case matters
  })

  it('tolerates a trailing separator on the dir', () => {
    expect(relativeToDir('C:\\repo\\a.ts', 'C:\\repo\\')).toBe('a.ts')
    expect(relativeToDir('/repo/a.ts', '/repo/')).toBe('a.ts')
  })

  it('crosses separator spellings: a forward-slashed cwd still contains a backslashed child', () => {
    expect(relativeToDir('C:\\repo\\src\\a.ts', 'C:/repo')).toBe('src\\a.ts')
  })

  it('refuses disjoint namespaces (a remote cwd never contains a local path)', () => {
    expect(relativeToDir('C:\\repo\\a.ts', '/home/dev')).toBeNull()
    expect(relativeToDir('', '/home/dev')).toBeNull()
    expect(relativeToDir('/home/dev/a', '')).toBeNull()
  })
})
