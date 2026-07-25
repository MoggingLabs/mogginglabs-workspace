import { describe, expect, it } from 'vitest'
import { parseOsc52, OSC52_MAX_BASE64 } from '../../src/ui/core/clipboard/clipboard-port'

// An oversized OSC 52 body used to return `null` — the SAME answer as a parse failure — and the
// pane's handler consumed it silently. So nothing was copied and nothing was said, while the CLI
// that emitted it printed "Copied N characters to clipboard". That is the exact failure this
// module exists to end ("a copy must never pass for one that worked"), reappearing at the top of
// the size range. The cap itself is sound policy; the SILENCE was the defect.
//
// The distinction that has to hold: an oversize payload is REFUSED (and reportable), while an
// EMPTY payload stays null — declining to let a CLI wipe the clipboard is deliberate, not a
// refusal we owe the user a toast about.

const big = (n: number): string => 'A'.repeat(n)

describe('parseOsc52 oversize', () => {
  it('REFUSES an oversized payload instead of silently answering null', () => {
    expect(parseOsc52(`c;${big(OSC52_MAX_BASE64 + 4)}`)).toEqual({ kind: 'refused', reason: 'too-big' })
  })

  it('keeps an EMPTY payload as null (declining to clear the clipboard is by design)', () => {
    expect(parseOsc52('c;')).toBeNull()
  })

  it('still refuses malformed base64 as null, not as a reportable refusal', () => {
    expect(parseOsc52('c;!!!not base64!!!')).toBeNull()
  })

  it('still copies a normal payload', () => {
    const b64 = Buffer.from('hello', 'utf8').toString('base64')
    expect(parseOsc52(`c;${b64}`)).toEqual({ kind: 'copy', text: 'hello' })
  })

  it('still recognises the read form, which is never answered', () => {
    expect(parseOsc52('c;?')).toEqual({ kind: 'read' })
  })
})
