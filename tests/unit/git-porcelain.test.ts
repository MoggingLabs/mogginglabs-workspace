import { describe, expect, it } from 'vitest'
import { parseStatusFiles } from '@backend/features/git/probe'
import { GIT_FILES_CAP } from '@contracts'

// GIT STATUS --PORCELAIN=v2, PARSED.
//
// Every per-pane git badge and the whole Changes lens read this. A regression here does not
// throw — it silently mislabels a file, or drops one, and the decoration lies about the
// working tree. The parser has always been exported and never had a table.
//
// Records: `1` ordinary · `2` rename (NEW path first, original after a TAB) · `u` conflict
// `?` untracked · `#` headers, which are not ours.

const ORD = (xy: string, path: string): string => `1 ${xy} N... 100644 100644 100644 abc def ${path}`

describe('parseStatusFiles', () => {
  it('reads ordinary records and their state', () => {
    const { files } = parseStatusFiles([ORD('.M', 'src/a.ts'), ORD('M.', 'src/b.ts')].join('\n'))
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
    for (const f of files) expect(f.state).toBeTruthy()
  })

  it('takes the NEW path from a rename, not the original', () => {
    const line = `2 R. N... 100644 100644 100644 abc def R100 src/new.ts\tsrc/old.ts`
    const { files } = parseStatusFiles(line)
    expect(files).toEqual([{ path: 'src/new.ts', state: 'renamed' }])
  })

  it('marks a conflict as conflicted', () => {
    const line = `u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts`
    expect(parseStatusFiles(line).files).toEqual([{ path: 'src/conflict.ts', state: 'conflicted' }])
  })

  it('reads untracked entries', () => {
    expect(parseStatusFiles('? src/new-file.ts').files).toEqual([{ path: 'src/new-file.ts', state: 'untracked' }])
  })

  it('ignores header and ignored records rather than inventing files from them', () => {
    const { files } = parseStatusFiles(['# branch.oid abc', '# branch.head main', '! node_modules/', ORD('.M', 'a.ts')].join('\n'))
    expect(files.map((f) => f.path)).toEqual(['a.ts'])
  })

  // Git C-quotes any path that is not plain ASCII. Dropping the octal branch yields a literal
  // `sp\303\251c.txt` in the UI — a filename that does not exist.
  it('decodes a C-quoted non-ASCII path', () => {
    expect(parseStatusFiles('? "sp\\303\\251c.txt"').files).toEqual([{ path: 'spéc.txt', state: 'untracked' }])
  })

  it('decodes C-quoted escapes for characters that would break the record', () => {
    expect(parseStatusFiles('? "a\\tb.txt"').files[0]?.path).toBe('a\tb.txt')
    expect(parseStatusFiles('? "a\\"b.txt"').files[0]?.path).toBe('a"b.txt')
  })

  // A path may legally begin or end with a space, and Git does not quote for that alone.
  it('preserves leading and trailing spaces in a pathname', () => {
    expect(parseStatusFiles('?  leading.txt').files[0]?.path).toBe(' leading.txt')
    expect(parseStatusFiles('? trailing.txt ').files[0]?.path).toBe('trailing.txt ')
  })

  it('strips only a CRLF record delimiter, never a CR inside a name', () => {
    expect(parseStatusFiles('? plain.txt\r').files[0]?.path).toBe('plain.txt')
  })

  it('handles a path containing spaces', () => {
    expect(parseStatusFiles(ORD('.M', 'src/my file.ts')).files[0]?.path).toBe('src/my file.ts')
  })

  it('sorts by path, so the lens order does not depend on git’s', () => {
    const { files } = parseStatusFiles([ORD('.M', 'z.ts'), ORD('.M', 'a.ts'), ORD('.M', 'm.ts')].join('\n'))
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'm.ts', 'z.ts'])
  })

  it('is empty for empty input rather than throwing', () => {
    expect(parseStatusFiles('')).toEqual({ files: [], truncated: false })
  })

  describe('the cap', () => {
    const many = (n: number): string =>
      Array.from({ length: n }, (_, i) => ORD('.M', `f${String(i).padStart(6, '0')}.ts`)).join('\n')

    it('does not report truncation at exactly the cap', () => {
      const out = parseStatusFiles(many(GIT_FILES_CAP))
      expect(out.files).toHaveLength(GIT_FILES_CAP)
      expect(out.truncated).toBe(false)
    })

    it('caps and SAYS SO one past it — a silent cap is a lie about the tree', () => {
      const out = parseStatusFiles(many(GIT_FILES_CAP + 1))
      expect(out.files).toHaveLength(GIT_FILES_CAP)
      expect(out.truncated).toBe(true)
    })
  })
})
