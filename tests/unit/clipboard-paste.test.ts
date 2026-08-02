import { describe, expect, it } from 'vitest'
import { OSC52_MAX_BASE64, parseOsc52, sanitizePaste } from '@ui/core/clipboard/clipboard-port'

// PASTE-JACKING DEFENCE, AND THE OSC 52 CODEC.
//
// A pasted payload goes straight into a shell's stdin. Bracketed paste is what tells the shell
// "this is data, not typing" — and a payload containing the END sentinel closes the bracket
// early, so everything after it is typed as commands. That is the whole attack.
//
// OSC 52 is the terminal's clipboard escape: an agent can ask to WRITE the user's clipboard,
// and (in the read form) to read it. Both need bounds.

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

describe('sanitizePaste', () => {
  it('wraps in the bracket when the shell asked for bracketed paste', () => {
    expect(sanitizePaste('hello', true)).toBe(`${PASTE_START}hello${PASTE_END}`)
  })

  it('does not wrap when it did not', () => {
    expect(sanitizePaste('hello', false)).toBe('hello')
  })

  // THE attack. A payload carrying the end sentinel closes the bracket early; the shell then
  // treats the remainder as typed input and runs it.
  it('strips an embedded END sentinel so the bracket cannot be closed early', () => {
    const out = sanitizePaste(`safe${PASTE_END}rm -rf /`, true)
    expect(out.indexOf(PASTE_END), 'the only end sentinel is the one we appended').toBe(
      out.length - PASTE_END.length
    )
    expect(out).toBe(`${PASTE_START}saferm -rf /${PASTE_END}`)
  })

  it('strips it in the UNBRACKETED form too — the shell is what varies, not the payload', () => {
    expect(sanitizePaste(`a${PASTE_END}b`, false)).toBe('ab')
  })

  // A terminal wants CR for "the user pressed Enter". A multi-line paste carrying LF would be
  // half-submitted by some shells and not others.
  it('normalizes every newline form to CR', () => {
    expect(sanitizePaste('a\nb', false)).toBe('a\rb')
    expect(sanitizePaste('a\r\nb', false)).toBe('a\rb')
    expect(sanitizePaste('a\r\nb\nc', false)).toBe('a\rb\rc')
  })

  it('leaves an empty paste empty', () => {
    expect(sanitizePaste('', false)).toBe('')
  })
})

describe('parseOsc52', () => {
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

  it('reads a copy request and decodes the payload as UTF-8', () => {
    expect(parseOsc52(`c;${b64('hi')}`)).toEqual({ kind: 'copy', text: 'hi' })
  })

  // atob yields a BINARY string, one char per byte. Reading it straight would mangle every
  // accent and every CJK character.
  it('decodes non-ASCII correctly rather than one byte per char', () => {
    for (const text of ['héllo', '日本語', '🎯 done']) {
      expect(parseOsc52(`c;${b64(text)}`), text).toEqual({ kind: 'copy', text })
    }
  })

  it('recognises the READ form', () => {
    expect(parseOsc52('c;?')).toEqual({ kind: 'read' })
  })

  it('refuses a payload with no selection separator', () => {
    expect(parseOsc52('nosemicolon')).toBeNull()
  })

  it('refuses an empty payload rather than treating it as "clear"', () => {
    expect(parseOsc52('c;')).toBeNull()
  })

  it('refuses invalid base64 instead of emitting mojibake', () => {
    expect(parseOsc52('c;!!!not base64!!!')).toBeNull()
  })

  // An unbounded write lets a pane hand the app an arbitrarily large string to hold.
  it('refuses a payload past the cap', () => {
    expect(parseOsc52(`c;${'A'.repeat(OSC52_MAX_BASE64 + 1)}`)).toBeNull()
  })

  it('accepts one exactly at the cap', () => {
    // 'A'.repeat(cap) is valid base64 when the length is a multiple of 4.
    const at = 'A'.repeat(OSC52_MAX_BASE64 - (OSC52_MAX_BASE64 % 4))
    expect(parseOsc52(`c;${at}`)).not.toBeNull()
  })
})
