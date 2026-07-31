import { describe, expect, it } from 'vitest'
import { RESTORE_MODE_RESET, trimTornStart } from '@backend/features/terminal/pane-shared'

// The tear trimmer guards BOTH blind suffix cuts (the live ring's slice(-SCROLLBACK_CHARS)
// and the persisted tail consumed by the daemon's restore()): a cut that lands mid escape
// sequence replays the sequence's tail as literal garbage. The ESC boundary is what saves
// TUI frames — kilobytes of CUP/EL redraws with no newline anywhere near the cut.

describe('trimTornStart', () => {
  it('drops a lone low surrogate at the cut', () => {
    const s = '\udc00after'
    expect(trimTornStart(s)).toBe('after')
  })

  it('cuts past a nearby newline (the line-output fast path)', () => {
    expect(trimTornStart('orn line\nnext line\n')).toBe('next line\n')
  })

  it('cuts a torn CSI tail at the first ESC when no newline is near (the TUI-frame case)', () => {
    // A cut inside \x1b[38;2;255;100;0m leaves "55;100;0m" — literal garbage pre-fix.
    const torn = '55;100;0m' + '\x1b[2;5H\x1b[Kframe content'.repeat(3)
    expect(trimTornStart(torn)).toBe('\x1b[2;5H\x1b[Kframe content'.repeat(3))
  })

  it('cuts a torn OSC payload at its own ST (an ESC boundary, ground-state no-op)', () => {
    // Cut mid-OSC-payload: the remainder holds no ESC until the terminating ESC-backslash.
    const torn = 'rest-of-title-payload' + '\x1b\\' + '\x1b[1mreal'
    const out = trimTornStart(torn)
    expect(out.startsWith('\x1b')).toBe(true)
    expect(out.includes('payload')).toBe(false)
  })

  it('prefers the EARLIER clean boundary', () => {
    // ESC before newline: keep the sequence-led tail (more content retained).
    expect(trimTornStart('89m\x1b[0mkeep\nline')).toBe('\x1b[0mkeep\nline')
    // Newline before ESC: classic line cut.
    expect(trimTornStart('tail\nkeep\x1b[0m')).toBe('keep\x1b[0m')
  })

  it('keeps a pure-text tear unchanged (plain text renders as plain text)', () => {
    const text = 'x'.repeat(5000)
    expect(trimTornStart(text)).toBe(text)
  })
})

describe('RESTORE_MODE_RESET', () => {
  it('grounds the modes a dead TUI can leak into a restored pane', () => {
    for (const seq of ['?1049l', '?1000l', '?1006l', '?2004l', '?25h']) {
      expect(RESTORE_MODE_RESET).toContain(seq)
    }
    // Never a full reset: \x1bc would ERASE the replayed history it follows.
    expect(RESTORE_MODE_RESET).not.toContain('\x1bc')
  })
})
