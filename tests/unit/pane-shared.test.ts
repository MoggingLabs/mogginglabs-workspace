import { describe, expect, it } from 'vitest'
import { sourceOf } from './source-body'
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
    for (const seq of ['?1000l', '?1002l', '?1003l', '?1006l', '?2004l', '?25h']) {
      expect(RESTORE_MODE_RESET).toContain(seq)
    }
    // Never a full reset: \x1bc would ERASE the replayed history it follows.
    expect(RESTORE_MODE_RESET).not.toContain('\x1bc')
  })

  // THE defect this string had. It is appended directly after the replayed history, so any
  // sequence in it that moves the cursor paints the fresh prompt over row 0 of the history it
  // was meant to follow. Two of them did.
  //
  // The row above previously asserted `?1049l` — it pinned the bug. Replaced, not extended.
  it('leaves the alt screen WITHOUT homing the cursor', () => {
    // ?1049l calls restoreCursor; with no prior DECSC — and there is none, the history came
    // from a process that is gone — that restores to (0,0). ?1047l is the same exit without
    // the cursor move, which is why both codes exist.
    expect(RESTORE_MODE_RESET).toContain('[?1047l')
    expect(RESTORE_MODE_RESET, '?1049l homes the cursor over the replayed history').not.toContain('[?1049l')
  })

  it('brackets the scroll-region reset in DECSC/DECRC', () => {
    // A default `ESC [ r` homes the cursor too, per DECSTBM. Saved and restored around it.
    expect(RESTORE_MODE_RESET).toContain('\x1b7\x1b[r\x1b8')
    expect(RESTORE_MODE_RESET, 'a bare region reset homes the cursor').not.toMatch(/[^7]\x1b\[r/)
  })

  it('restores the region BEFORE clearing SGR', () => {
    // DECRC restores SGR as well as the position, so `ESC 8` after `ESC [ m` would undo it.
    expect(RESTORE_MODE_RESET.indexOf('\x1b8')).toBeLessThan(RESTORE_MODE_RESET.indexOf('\x1b[m'))
  })

  it('every sequence is written from escapes, never a raw control byte', () => {
    // The clipboard-port rule, applied here: a literal ESC in a source file is invisible in a
    // diff and survives a copy-paste into somewhere it must not go.
    const src = sourceOf('src/backend/features/terminal/pane-shared.ts')
    // The pattern is BUILT FROM A STRING for the same reason: writing it as a regex literal
    // would require putting the very byte being refused into this file.
    const RAW_CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]')
    expect(RAW_CONTROL.test(src), 'a raw control byte in the source').toBe(false)
  })
})
