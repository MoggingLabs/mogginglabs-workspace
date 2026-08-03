import { TerminalChannels, type PaneId } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { getPaneAgentSession } from '../../core/agents/agent-session-port'
import { readPaneBufferTail } from '../../core/terminal/pane-buffer-port'
import {
  DOUBLE_TAP_GAP_MS,
  GONE_WAIT_MS,
  INTERRUPT_ROUNDS,
  TRAP_SWEEP_GAP_MS,
  TRAP_SWEEP_TRIES,
  TRAP_TAIL_LINES,
  batchTrapAnswer
} from './interrupt-core'

// The deterministic interrupt (audit F2). The old failover sent ONE ^C and typed the
// resume command 900ms later on faith — a CLI that survived the tap received
// `claude --resume <id>` as a chat message INTO the capped account. This module types
// nothing but interrupts and trap answers, and succeeds only on the process table's own
// "agent gone" verdict — the same signal that guards the session port. The caller types
// the launch command only after `interruptAgent` returns true.
//
// The gone signal is fed by the agents feature's TerminalChannels.agent handler (the
// one subscriber to the wire) — NOT read off the session port, whose adopted-session
// stamp guard can legitimately keep a session after a null verdict. PTY exit reaches
// us through the session port's clear instead (index.ts wires both).

interface GoneWaiter {
  (gone: boolean): void
}

const goneNow = new Set<number>()
const waiters = new Map<number, Set<GoneWaiter>>()

/** The pane's agent is GONE (process-table null verdict, or the PTY itself exited). */
export function noteAgentGone(paneId: number): void {
  goneNow.add(paneId)
  const set = waiters.get(paneId)
  if (!set) return
  waiters.delete(paneId)
  for (const fn of set) fn(true)
}

/** A positive detection: an agent LIVES in the pane (the relaunch, or a hand-typed CLI). */
export function noteAgentPresent(paneId: number): void {
  goneNow.delete(paneId)
}

/** Resolve true once the pane's agent is gone, false after `timeoutMs`. */
export function whenAgentGone(paneId: number, timeoutMs: number): Promise<boolean> {
  if (goneNow.has(paneId)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const set = waiters.get(paneId) ?? new Set<GoneWaiter>()
    waiters.set(paneId, set)
    let settled = false
    const done: GoneWaiter = (gone) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      set.delete(done)
      resolve(gone)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    set.add(done)
  })
}

// ── The switch trace: gate evidence, not telemetry ─────────────────────────────
// The PROFSWITCH/PROFILES gates assert ORDER (agent-gone strictly before typed) —
// the exact claim F2 was about. Phases only, never buffer content or commands.

export type SwitchPhase = 'interrupt-start' | 'agent-gone' | 'typed' | 'continued' | 'done' | 'failed'

const traces = new Map<number, { phase: SwitchPhase; at: number }[]>()

export function resetSwitchTrace(paneId: number): void {
  traces.set(paneId, [])
}

export function recordSwitchPhase(paneId: number, phase: SwitchPhase): void {
  const list = traces.get(paneId) ?? []
  list.push({ phase, at: performance.now() })
  traces.set(paneId, list)
}

export function switchTrace(paneId: number): { phase: SwitchPhase; at: number }[] {
  return (traces.get(paneId) ?? []).map((e) => ({ ...e }))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function write(paneId: number, data: string): void {
  getBridge().send(TerminalChannels.write, { id: paneId as PaneId, data })
}

/** Read the tail and answer a LIVE "Terminate batch job (Y/N)?" if one is showing. */
function answerBatchTrap(paneId: number): boolean {
  const answer = batchTrapAnswer(readPaneBufferTail(paneId, TRAP_TAIL_LINES))
  if (!answer) return false
  write(paneId, answer)
  return true
}

/**
 * Interrupt the pane's agent CLI and PROVE it is gone. Up to four rounds of the
 * smoke-proven double-^C (a booting CLI ignores both — that is why it is a loop),
 * each round answering the Windows batch trap and then waiting on the process
 * table's verdict. After the verdict, a short trap sweep: the cmd prompt can
 * surface AS node dies, one beat after the verdict already fired.
 *
 * true  → the agent is gone and the pane is safe to type into.
 * false → the agent survived every round; the caller must type NOTHING.
 */
export async function interruptAgent(paneId: number): Promise<boolean> {
  recordSwitchPhase(paneId, 'interrupt-start')
  let gone = goneNow.has(paneId)
  for (let round = 0; !gone && round < INTERRUPT_ROUNDS; round++) {
    write(paneId, '\x03')
    await sleep(DOUBLE_TAP_GAP_MS)
    write(paneId, '\x03')
    answerBatchTrap(paneId)
    gone = await whenAgentGone(paneId, GONE_WAIT_MS)
    if (!gone && round >= 1) {
      // Two full rounds (~7s) with no verdict AND no CONFIRMED agent: the session was
      // typed but the process table never saw a CLI behind it (not installed, launch
      // failed) — there is nothing to kill, and no verdict will ever come. Proceeding
      // is safe: `running` is detection's own bit, and a REAL booting CLI is confirmed
      // within ~2-5s (track probe + retry), well inside these two rounds — so a live
      // agent always keeps the full wait.
      const s = getPaneAgentSession(paneId as PaneId)
      if (!s || s.running !== true) gone = true
    }
  }
  if (!gone) return false
  recordSwitchPhase(paneId, 'agent-gone')
  for (let sweep = 0; sweep < TRAP_SWEEP_TRIES; sweep++) {
    await sleep(TRAP_SWEEP_GAP_MS)
    if (!answerBatchTrap(paneId)) break
  }
  return true
}
