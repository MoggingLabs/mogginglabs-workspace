import { describe, expect, it } from 'vitest'
import { sameClipboardText } from '@contracts'
import { sourceOf } from './source-body'

// "IS THIS THE SAME CLIPBOARD TEXT?" — ASKED FOUR TIMES, ANSWERED TWO WAYS.
//
// A copy can read back with `\n` rewritten to `\r\n`. That is real fidelity on Windows, not a
// failure, so a strict `===` answers NO to two spellings of the same content.
//
// The write handler knew that — it had a function-local `sameText` — because getting it wrong
// there is loud: every pasted code block would throw "clipboard write did not take". The
// delete handler asked the same question with `===` and got the opposite answer, quietly:
// deleting the history row that IS the current clipboard skipped `clipboard.clear()`, so the
// content the user had just deleted stayed on their clipboard.

describe('sameClipboardText', () => {
  it('identical text is the same', () => {
    expect(sameClipboardText('hello', 'hello')).toBe(true)
    expect(sameClipboardText('', '')).toBe(true)
  })

  // THE case. The OS rewrote the line endings on the way through.
  it('folds CRLF against LF, in both directions', () => {
    expect(sameClipboardText('a\r\nb', 'a\nb')).toBe(true)
    expect(sameClipboardText('a\nb', 'a\r\nb')).toBe(true)
    expect(sameClipboardText('a\r\nb\r\nc', 'a\nb\nc')).toBe(true)
  })

  it('still says no to genuinely different text', () => {
    expect(sameClipboardText('hello', 'goodbye')).toBe(false)
    // A locked clipboard reads back wholly different OLD content — the case the write check
    // exists to catch. Folding line endings must not blunt that.
    expect(sameClipboardText('the old thing', 'the new thing')).toBe(false)
  })

  it('does not fold a LONE CR — that is not a line-ending rewrite', () => {
    expect(sameClipboardText('a\rb', 'a\nb')).toBe(false)
  })

  it('is not whitespace-insensitive beyond line endings', () => {
    expect(sameClipboardText('a b', 'a  b')).toBe(false)
    expect(sameClipboardText('a\tb', 'a b')).toBe(false)
    expect(sameClipboardText(' a', 'a')).toBe(false)
  })

  it('is symmetric', () => {
    for (const [a, b] of [
      ['a\r\nb', 'a\nb'],
      ['x', 'y'],
      ['', 'z']
    ] as const) {
      expect(sameClipboardText(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(sameClipboardText(b, a))
    }
  })
})

describe('both write and delete ask it the same way', () => {
  const src = sourceOf('src/main/clipboard.ts')

  it('the write verification uses the shared predicate', () => {
    expect(src).toMatch(/if \(text && !sameClipboardText\(clipboard\.readText\(\), text\)\)/)
  })

  // THE regression.
  it('the delete handler does too, rather than a strict equality', () => {
    expect(src).toMatch(/sameClipboardText\(readClipboardText\(\), gone\.text\)/)
    expect(src, 'a strict === asks a different question than the write that put it there').not.toMatch(
      /readClipboardText\(\) === gone\.text/
    )
  })

  it('there is no second, local copy of the rule', () => {
    expect(src, 'a function-local sameText is how the two answers diverged').not.toMatch(/const sameText =/)
  })

  // Deliberately NOT folded: the poll watcher and the history-ring dedupe compare two values
  // from the SAME reader, where no rewrite can occur — and folding there would merge two
  // entries a user may legitimately want kept apart.
  it('the poll watcher still compares strictly', () => {
    expect(src).toMatch(/if \(text && text !== lastText\)/)
  })
})
