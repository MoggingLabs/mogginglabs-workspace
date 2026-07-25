import { describe, expect, it } from 'vitest'
import { OscParser, type OscEvent } from '../../src/backend/features/agent-state/osc-parser'

// The ESC-abort rule. `ESC ]` INSIDE an open OSC terminates that sequence and OPENS THE NEXT
// one — the same thing xterm/VT do with the same bytes. The parser used to consume the
// aborting byte unconditionally, so the successor's `]` was swallowed: its body then scanned
// as ordinary ground-state output and its terminating BEL fell through to the "a BEL outside
// any OSC is the terminal bell" branch. That rang a FALSE attention bell (latching a pane red
// for nothing — the exact class the MAX_OSC swallow exists to prevent) and silently dropped
// the successor sequence, which on this app is normally a prompt mark: an OSC is injected at
// every prompt, so an OSC is precisely what follows an interrupted one.
//
// Reachable whenever a program is interrupted mid-OSC (Ctrl+C during a large vim/tmux OSC 52
// yank) and the shell's own prompt sequence lands next.

const drive = (chunks: string[]): OscEvent[] => {
  const events: OscEvent[] = []
  const parser = new OscParser(
    () => {},
    (e) => events.push(e)
  )
  for (const c of chunks) parser.push(c)
  return events
}

describe('OscParser — an aborted OSC must not eat its successor', () => {
  it('rings NO bell when a truncated OSC is followed immediately by another OSC', () => {
    // ESC]9;hi  (never terminated)  ESC]133;A  BEL
    const events = drive(['\x1b]9;hi\x1b]133;A\x07'])
    expect(events.filter((e) => e.kind === 'bell')).toHaveLength(0)
  })

  it('still delivers the successor sequence (the prompt mark is not lost)', () => {
    const events = drive(['\x1b]9;hi\x1b]133;A\x07'])
    expect(events.some((e) => e.code === 133)).toBe(true)
  })

  it('survives the abort landing on a chunk boundary', () => {
    const events = drive(['\x1b]9;hi\x1b', ']133;A\x07'])
    expect(events.filter((e) => e.kind === 'bell')).toHaveLength(0)
    expect(events.some((e) => e.code === 133)).toBe(true)
  })

  it('aborts to GROUND on a non-] ESC, where a later bare BEL is still a real bell', () => {
    // The abort itself must keep working: ESC + 'A' is not an OSC intro, so the parser
    // returns to ground and the BEL that follows is the terminal's own.
    const events = drive(['\x1b]9;hi\x1bAplain text\x07'])
    expect(events.filter((e) => e.kind === 'bell')).toHaveLength(1)
  })

  it('a bare BEL outside any OSC is still the terminal bell (no over-correction)', () => {
    expect(drive(['ding\x07']).filter((e) => e.kind === 'bell')).toHaveLength(1)
  })
})
