import { describe, expect, it } from 'vitest'
import { applyIndent, eolOfLine, indentOfLine, lineStarts } from '@backend/features/brain/writes'

// THE BYTE ARITHMETIC UNDER AN AGENT'S SYMBOL WRITE.
//
// `brain` write verbs splice a payload into the user's SOURCE FILE at a line range. Everything
// outside that range must round-trip byte-for-byte, which makes these four functions the whole
// safety story: an off-by-one in `lineStarts` eats or duplicates a line, the wrong `eolOfLine`
// converts a CRLF file to LF on one line only, and a wrong indent produces code that does not
// compile in a language where indentation is syntax.
//
// None of this throws when it is wrong. It just quietly edits the wrong bytes.

const buf = (s: string): Buffer => Buffer.from(s, 'utf8')

describe('lineStarts', () => {
  it('gives the 0-based offset each 1-based line begins at', () => {
    // "a\nbb\nccc\n" — line 1 at 0, line 2 at 2, line 3 at 5.
    expect(lineStarts(buf('a\nbb\nccc\n'))).toEqual([0, 2, 5])
  })

  // The rule the comment states: a trailing newline does not open a phantom last line. Get
  // this wrong and every splice past the end appends into a line that does not exist.
  it('a trailing newline does not open a phantom last line', () => {
    expect(lineStarts(buf('a\n'))).toEqual([0])
    expect(lineStarts(buf('a\nb\n'))).toEqual([0, 2])
  })

  it('a file with no trailing newline still counts its last line', () => {
    expect(lineStarts(buf('a\nb'))).toEqual([0, 2])
  })

  it('counts CRLF lines by the LF, so offsets stay byte-true', () => {
    // "a\r\nbb\r\n" — line 2 starts at byte 3, not 2.
    expect(lineStarts(buf('a\r\nbb\r\n'))).toEqual([0, 3])
  })

  it('an empty file is one line at offset 0', () => {
    expect(lineStarts(buf(''))).toEqual([0])
  })

  it('a blank line is a line', () => {
    expect(lineStarts(buf('a\n\nb\n'))).toEqual([0, 2, 3])
  })

  // Offsets are BYTES, not characters. A multi-byte character before a newline shifts every
  // later line, and a character-based count would splice mid-codepoint.
  it('counts bytes, not characters', () => {
    expect(lineStarts(buf('é\nb\n'))).toEqual([0, 3])
  })
})

describe('eolOfLine', () => {
  const withEol = (text: string, line: number): string => eolOfLine(buf(text), lineStarts(buf(text)), line)

  it('reports each line’s own terminator', () => {
    expect(withEol('a\nb\n', 1)).toBe('\n')
    expect(withEol('a\r\nb\r\n', 1)).toBe('\r\n')
  })

  // A file may be mixed. Assuming the file's dominant ending would rewrite the other lines.
  it('reports per LINE, not per file', () => {
    const mixed = 'a\r\nb\nc\r\n'
    expect(withEol(mixed, 1)).toBe('\r\n')
    expect(withEol(mixed, 2)).toBe('\n')
  })

  it('is empty at EOF without a terminator — there is nothing to preserve', () => {
    expect(withEol('a\nb', 2)).toBe('')
  })

  it('a blank CRLF line still reports CRLF', () => {
    expect(withEol('a\r\n\r\nb\r\n', 2)).toBe('\r\n')
  })
})

describe('indentOfLine', () => {
  const at = (text: string, line: number): string => indentOfLine(buf(text), lineStarts(buf(text)), line)

  it('takes the leading blanks, spaces or tabs', () => {
    expect(at('    x\n', 1)).toBe('    ')
    expect(at('\t\tx\n', 1)).toBe('\t\t')
    expect(at('  \tx\n', 1)).toBe('  \t')
  })

  it('is empty at column zero', () => {
    expect(at('x\n', 1)).toBe('')
  })

  it('stops at the first non-blank, so it never swallows content', () => {
    expect(at('  x  y\n', 1)).toBe('  ')
  })

  it('reads the line asked for, not the first', () => {
    expect(at('x\n      y\n', 2)).toBe('      ')
  })
})

describe('applyIndent', () => {
  it('prepends the anchor’s indent to every payload line', () => {
    expect(applyIndent('a\nb\n', '  ')).toBe('  a\n  b\n')
  })

  // A blank line with trailing whitespace is a diff nobody asked for, and in a repo with a
  // whitespace linter it is a failing build.
  it('leaves blank lines BARE rather than indenting whitespace', () => {
    expect(applyIndent('a\n\nb\n', '  ')).toBe('  a\n\n  b\n')
  })

  it('does nothing when the anchor is at column zero', () => {
    expect(applyIndent('a\nb\n', '')).toBe('a\nb\n')
  })

  it('preserves CRLF while indenting', () => {
    expect(applyIndent('a\r\nb\r\n', '  ')).toBe('  a\r\n  b\r\n')
  })

  it('indents a final line with no terminator', () => {
    expect(applyIndent('a\nb', '  ')).toBe('  a\n  b')
  })

  it('treats a whitespace-only line as blank', () => {
    expect(applyIndent('a\n   \nb\n', '  ')).toBe('  a\n   \n  b\n')
  })
})
