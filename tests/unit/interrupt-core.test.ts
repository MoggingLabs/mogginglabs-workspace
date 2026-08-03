import { describe, expect, it } from 'vitest'
import {
  DOUBLE_TAP_GAP_MS,
  GONE_WAIT_MS,
  INTERRUPT_ROUNDS,
  TRAP_SWEEP_GAP_MS,
  TRAP_SWEEP_TRIES,
  batchTrapAnswer,
  endProvesAgentGone
} from '@ui/features/agents/interrupt-core'

// The deterministic-interrupt decision core (audit F2). The trap answer is the part a
// wrong regex turns dangerous: a stray `Y\r` typed into a shell prompt runs `Y`, and a
// missed trap eats the resume command the whole interrupt exists to protect.
describe('batchTrapAnswer', () => {
  it('answers a live trap on the last line', () => {
    expect(batchTrapAnswer('some output\nTerminate batch job (Y/N)? ')).toBe('Y\r')
  })

  it('is case-insensitive and tolerates trailing blank lines (xterm pads the tail)', () => {
    expect(batchTrapAnswer('TERMINATE BATCH JOB (Y/N)?\n\n\n')).toBe('Y\r')
  })

  it('ignores an ALREADY-ANSWERED trap higher in the tail', () => {
    // The echoed answer and the next prompt are below the old trap — a stray Y here
    // would be typed into the SHELL.
    expect(batchTrapAnswer('Terminate batch job (Y/N)? Y\nPS C:\\repo>')).toBeNull()
  })

  it('says nothing for a plain prompt, empty tail, or no visibility', () => {
    expect(batchTrapAnswer('PS C:\\repo>')).toBeNull()
    expect(batchTrapAnswer('')).toBeNull()
    expect(batchTrapAnswer(null)).toBeNull()
  })

  it('a trap line with the echoed answer on the SAME line is spent', () => {
    expect(batchTrapAnswer('Terminate batch job (Y/N)? Y')).toBeNull()
  })
})

// WHICH session end may authorize a keystroke. The interrupt exists to never type into a
// live agent, so this predicate is the fail-closed guarantee itself: every `true` here is
// the app promising there is no process left on the other end of the keyboard.
describe('endProvesAgentGone', () => {
  it('accepts only ends that PROVE there is no process left', () => {
    expect(endProvesAgentGone('verdict')).toBe(true) // the process table walked the subtree
    expect(endProvesAgentGone('exited')).toBe(true) // the pty process exited
    expect(endProvesAgentGone('pane-gone')).toBe(true) // the pane closed, its pty killed with it
  })

  it('REFUSES the shell prompt guess — the fail-closed hole this closed', () => {
    // OSC 133;D/A says the SHELL is prompting. It is true of a backgrounded agent and of
    // a ^C at an idle prompt, and the backend already refuses to read it as a verdict
    // (agent-proc.ts promptSeen spends a process listing instead). Trusting it here made
    // a profile switch type `gemini …` into an agent that had never been reported dead.
    expect(endProvesAgentGone('prompt-guess')).toBe(false)
  })
})

describe('the budget', () => {
  it('stays under ~15s worst case — a stuck switch must fail, not hang', () => {
    const worst = INTERRUPT_ROUNDS * (DOUBLE_TAP_GAP_MS + GONE_WAIT_MS) + TRAP_SWEEP_TRIES * TRAP_SWEEP_GAP_MS
    expect(worst).toBeLessThanOrEqual(15_000)
  })

  it('retries more than once — a booting CLI ignores its first round', () => {
    expect(INTERRUPT_ROUNDS).toBeGreaterThanOrEqual(2)
  })
})
