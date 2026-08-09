import { describe, it, expect } from 'vitest'
import {
  composeReplay,
  GROUND,
  isGround,
  modePrefix,
  TerminalModeTracker,
  type ModeState
} from '@backend/features/terminal/pane-modes'
import { RESTORE_MODE_RESET } from '@backend/features/terminal/pane-shared'
import { sourceOf } from './source-body'

const scan = (...chunks: string[]): TerminalModeTracker => {
  const t = new TerminalModeTracker()
  for (const c of chunks) t.push(c)
  return t
}

describe('TerminalModeTracker — the alternate screen', () => {
  it('records WHICH code took the screen', () => {
    expect(scan('\x1b[?1049h').snapshot().alt).toBe(1049)
    expect(scan('\x1b[?1047h').snapshot().alt).toBe(1047)
    expect(scan('\x1b[?47h').snapshot().alt).toBe(47)
  })

  it('lets ANY of the three exit codes leave — xterm has one alternate buffer', () => {
    for (const exit of ['\x1b[?47l', '\x1b[?1047l', '\x1b[?1049l']) {
      expect(scan('\x1b[?1049h', exit).snapshot().alt).toBe(0)
    }
  })

  it('reports the ESC offset of the enter still in force, and -1 once it is gone', () => {
    const t = scan('hello\x1b[?1049h')
    expect(t.lastAltEnterPos).toBe(5)
    t.push('\x1b[?1049l')
    expect(t.lastAltEnterPos).toBe(-1)
  })

  it('reports -1 when the alt screen was entered BEFORE this scan (a seeded head)', () => {
    const t = new TerminalModeTracker()
    t.reset({ ...GROUND, alt: 1049 })
    t.push('frames with no transitions')
    expect(t.snapshot().alt).toBe(1049)
    expect(t.lastAltEnterPos).toBe(-1) // no cut point inside this segment
  })
})

describe('TerminalModeTracker — mode parsing', () => {
  it('applies every parameter of a multi-mode set', () => {
    const s = scan('\x1b[?1002;1006;2004h').snapshot()
    const prefix = modePrefix(s, false)
    expect(prefix).toContain('\x1b[?1002h')
    expect(prefix).toContain('\x1b[?1006h')
    expect(prefix).toContain('\x1b[?2004h')
  })

  it('starts from the power-on state: wrap and cursor SET, everything else reset', () => {
    expect(isGround(scan('').snapshot())).toBe(true)
    expect(modePrefix(GROUND, false)).toBe('')
    // ...and emits the RESET when a default-set mode is turned off
    expect(modePrefix(scan('\x1b[?7l').snapshot(), false)).toContain('\x1b[?7l')
    expect(modePrefix(scan('\x1b[?25l').snapshot(), false)).toContain('\x1b[?25l')
  })

  it('records DECSTBM, and clears it on a bare ESC[r', () => {
    const s = scan('\x1b[5;20r').snapshot()
    expect([s.regionTop, s.regionBottom]).toEqual([5, 20])
    expect(scan('\x1b[5;20r', '\x1b[r').snapshot().regionTop).toBe(0)
  })

  it('does NOT read XTRESTORE (CSI ? Pm r) as a scroll region', () => {
    const s = scan('\x1b[?1049r').snapshot()
    expect([s.regionTop, s.regionBottom]).toEqual([0, 0])
  })

  it('tracks the application keypad (ESC = / ESC >)', () => {
    expect(modePrefix(scan('\x1b=').snapshot(), false)).toContain('\x1b=')
    expect(modePrefix(scan('\x1b=', '\x1b>').snapshot(), false)).not.toContain('\x1b=')
  })

  it('grounds on RIS, and soft-resets on DECSTR without leaving the alt buffer', () => {
    expect(isGround(scan('\x1b[?1049h\x1b[?2004h\x1b[5;20r', '\x1bc').snapshot())).toBe(true)
    const soft = scan('\x1b[?1049h\x1b[?1l\x1b[?7l\x1b[5;20r', '\x1b[!p').snapshot()
    expect(soft.alt).toBe(1049) // DECSTR deliberately leaves the alternate buffer alone
    expect(soft.regionTop).toBe(0)
    expect(modePrefix(soft, false)).not.toContain('\x1b[?7l')
  })
})

describe('TerminalModeTracker — hostile and split input', () => {
  const SAMPLE = '\x1b[?1049h\x1b[?1002;1006h\x1b[5;20r\x1b[?2004h\x1b[?25lpayload\x1b=\x1b[?7l'

  it('is split-invariant at EVERY index — the head tracker is fed arbitrary cut points', () => {
    const whole = scan(SAMPLE).snapshot()
    for (let i = 0; i <= SAMPLE.length; i++) {
      const split = scan(SAMPLE.slice(0, i), SAMPLE.slice(i)).snapshot()
      expect(split, `split at ${i}`).toEqual(whole)
    }
  })

  it('keeps the alt-enter OFFSET correct across a split mid-sequence', () => {
    const s = 'ab\x1b[?1049h'
    for (let i = 0; i <= s.length; i++) {
      expect(scan(s.slice(0, i), s.slice(i)).lastAltEnterPos, `split at ${i}`).toBe(2)
    }
  })

  it('ignores mode bytes inside an OSC payload — a clipboard write cannot spoof state', () => {
    expect(isGround(scan('\x1b]52;c;\x1b[?1049h\x07').snapshot())).toBe(true)
    expect(isGround(scan('\x1b]0;title \x1b[?2004h\x1b\\').snapshot())).toBe(true)
    // ...and plain text that merely looks like a sequence is just text
    expect(isGround(scan('[?1049h').snapshot())).toBe(true)
  })

  it('bounds an absurd CSI run and resyncs on the next real sequence', () => {
    const flood = '\x1b[?' + '1;'.repeat(5000) + 'h'
    const t = scan(flood)
    expect(isGround(t.snapshot())).toBe(true) // the overflowed sequence is dropped whole
    t.push('\x1b[?1049h')
    expect(t.snapshot().alt).toBe(1049) // ...and the machine is healthy afterwards
  })
})

describe('composeReplay — say nothing when there is nothing to say', () => {
  it('returns a ground normal-buffer ring BYTE-IDENTICAL', () => {
    const ring = 'C:\\> dir\r\nfile.txt\r\nC:\\> '
    expect(composeReplay(ring, GROUND)).toBe(ring)
  })

  it('returns a cold-restore-shaped ring byte-identical (RESTORE_MODE_RESET grounds it)', () => {
    const ring = 'old history\r\n' + RESTORE_MODE_RESET + 'C:\\> '
    expect(composeReplay(ring, GROUND)).toBe(ring)
  })

  it('grounds a segment whose head held modes, without moving the cursor', () => {
    const head: ModeState = { ...GROUND, regionTop: 5, regionBottom: 20 }
    const out = composeReplay('tail text', head)
    expect(out.endsWith('tail text')).toBe(true)
    // DECSTBM homes the cursor, so a head prefix must wrap it — and ESC[m goes AFTER the
    // DECRC, which restores SGR and would otherwise undo it.
    expect(out.indexOf('\x1b7')).toBeLessThan(out.indexOf('\x1b[5;20r'))
    expect(out.indexOf('\x1b[5;20r')).toBeLessThan(out.indexOf('\x1b8'))
    expect(out.indexOf('\x1b8')).toBeLessThan(out.indexOf('\x1b[m'))
  })
})

describe('composeReplay — an alt-screen session', () => {
  const FRAMES = '\x1b[1;1HFRAME_A\x1b[2;1HFRAME_B'

  it('truncates at the alt ENTER and keeps the pre-alt history', () => {
    const ring = 'SHELL_HISTORY\r\n\x1b[?1049h' + FRAMES
    const out = composeReplay(ring, GROUND)
    expect(out).toContain('SHELL_HISTORY')
    expect(out).not.toContain('FRAME_A')
    expect(out).not.toContain('FRAME_B')
    expect(out.indexOf('\x1b[?1049h')).toBeLessThan(out.indexOf('\x1b[2J'))
    expect(out.endsWith('\x1b[2J\x1b[H')).toBe(true)
  })

  it('replays NO ring bytes when the enter has already rolled off the head', () => {
    // The field case: hours of frames, the one ?1049h long since trimmed.
    const head: ModeState = { ...GROUND, alt: 1049, flags: GROUND.flags | 0 }
    const out = composeReplay(FRAMES, head)
    expect(out).not.toContain('FRAME_A')
    expect(out).not.toContain('FRAME_B')
    expect(out.startsWith('\x1b[?1049h')).toBe(true)
    expect(out.length).toBeLessThan(64)
  })

  it('carries the modes the session holds into the alt prefix', () => {
    const ring = '\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[3;40r' + FRAMES
    const out = composeReplay(ring, GROUND)
    for (const expected of ['\x1b[?1049h', '\x1b[?1002h', '\x1b[?1006h', '\x1b[?2004h', '\x1b[?25l', '\x1b[3;40r']) {
      expect(out, expected).toContain(expected)
    }
    // The tail prefix wants DECSTBM's homing, so it is NOT wrapped in DECSC/DECRC.
    expect(out).not.toContain('\x1b7')
  })
})

describe('composeReplay — the three prohibitions', () => {
  const CASES: Array<[string, string, ModeState]> = [
    ['alt, enter present', '\x1b[?1049h\x1b[?2026h\x1b[?1003hFRAME', GROUND],
    ['alt, enter rolled off', '\x1b[?2026hFRAME', { ...GROUND, alt: 1049 }],
    ['normal buffer, head holds modes', 'text', { ...GROUND, regionTop: 2, regionBottom: 9 }]
  ]

  for (const [name, ring, head] of CASES) {
    it(`never emits 1049l, 2026h, or a query — ${name}`, () => {
      const emitted = composeReplay(ring, head).replace(ring, '')
      expect(emitted).not.toContain('\x1b[?1049l')
      expect(emitted).not.toContain('\x1b[?2026h')
      // Anything that makes xterm write back would be typed into the running agent.
      expect(emitted).not.toMatch(/\x1b\[[0-9;]*n/) // DSR / CPR
      expect(emitted).not.toMatch(/\x1b\[[>=?]?[0-9;]*c/) // DA1 / DA2
      expect(emitted).not.toMatch(/\x1b\][0-9]+;\?/) // OSC colour query
    })
  }
})

describe('composeReplay — the invariant, as a property', () => {
  // Whatever the split between "already evicted" and "still in the ring", replaying the
  // composed payload must leave a terminal in the SAME state the full stream would have.
  // This is the test that catches whoever adds a mode to the table and forgets the emitter.
  const TRANSITIONS = [
    '\x1b[?1049h',
    '\x1b[?1049l',
    '\x1b[?1002h',
    '\x1b[?1006h',
    '\x1b[?2004h',
    '\x1b[?2004l',
    '\x1b[?25l',
    '\x1b[?25h',
    '\x1b[?7l',
    '\x1b[?1h',
    '\x1b=',
    '\x1b[4;30r',
    '\x1b[r',
    'plain output\r\n'
  ]

  const stream = (seed: number): string => {
    let s = ''
    let x = seed
    for (let i = 0; i < 40; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff
      s += TRANSITIONS[x % TRANSITIONS.length]
    }
    return s
  }

  it('head + composed payload reproduces the full stream state, at every seed and split', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const full = stream(seed)
      const truth = scan(full).snapshot()
      for (const frac of [0, 0.17, 0.5, 0.83, 1]) {
        const cut = Math.floor(full.length * frac)
        const head = scan(full.slice(0, cut)).snapshot()
        const replayed = scan(composeReplay(full.slice(cut), head)).snapshot()
        // The alt branch deliberately drops frame CONTENT, never state.
        expect(replayed, `seed ${seed} cut ${cut}`).toEqual(truth)
      }
    }
  })
})

describe('pane-modes source hygiene', () => {
  it('spells control bytes as escapes, never raw (pane-shared.test.ts’s rule)', () => {
    const src = sourceOf('src/backend/features/terminal/pane-modes.ts')
    expect(src).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/)
  })
})
