import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ActivityTracker, BELL_CONFIRM_MS, isSubmittedInput, OscParser } from '@backend/features/agent-state'

// Env-gated tab-attention smoke (MOGGING_ATTENTION): create a 2nd workspace so Workspace 1 is
// backgrounded, flip a pane in that background workspace to attention, assert its tab rings, then
// focus it and assert the ring clears. Exercises the per-workspace attention aggregation + latch.
// Plus (A) a main-side unit assert on the ONE parser rule that manufactures false attention.
//
// It is ALSO the gate on THE VERDICT LAW — that green has exactly one source, an explicit `done`,
// and that silence is never mistaken for a completion. Those asserts are written to fail on the
// engine this replaced: it derived "finished" from a busy->idle edge over a 2.5s duration floor,
// so a pane that merely went quiet for long enough was stamped as having finished work.

/** Count the terminal bells a chunk sequence produces — the signal that latches a pane red. */
function bellsFor(chunks: string[]): number {
  let bells = 0
  const p = new OscParser(
    () => {},
    (ev) => {
      if (ev.kind === 'bell') bells++
    }
  )
  for (const c of chunks) p.push(c)
  return bells
}

/**
 * B. THE TRACKER'S RULES, asserted directly. The ActivityTracker is Electron-free and pure, so
 * this is a unit test wearing a gate's clothes — deterministic, no app timing, no DOM.
 *
 * It exists because the two hardest rules in the whole alerts system had NO coverage at all, and
 * both of them fail silently when they break:
 *
 *   THE SUBAGENT GATE. An agent that fans work out ends its own turn while the subagents run — it
 *   fires Stop with the work still in flight. Green requires main-done AND zero subagents, so that
 *   Stop is DEFERRED and redeemed only when the last child lands. Break it and a pane pulses green
 *   in the middle of a job.
 *
 *   THE BELL DEDUCTION. A chime is ambiguous — every CLI rings it on COMPLETION as well as when
 *   blocked. It is held for BELL_CONFIRM_MS and asked whether a `done` lands behind it: chime WITH
 *   a done is a completion (green), chime ALONE is a block (red). Break the first half and every
 *   Codex/Gemini/OpenCode completion rings red; break the second and three of five CLIs can never
 *   say they need you, because a chime is the only signal they have.
 */
async function trackerAsserts(): Promise<Record<string, boolean>> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const mk = (): ActivityTracker => new ActivityTracker(() => {})

  // SILENCE IS NOT A COMPLETION — and is no longer even a state. A tracker that hears no verdict
  // says nothing at all: there is no `data()` to call, and `unknown` is where it rests.
  const a = mk()
  const silentStaysUnknown = a.current() === 'unknown'

  // The ONLY path to green.
  const b = mk()
  b.turnStart()
  b.notify('done')
  const doneGreens = b.current() === 'done'

  // `idle` may never green a pane — nothing about it claims anything finished. `idle-prompt` in
  // particular fires on a 60-SECOND TIMER, not on a completion; reading it as one greened panes
  // that had merely gone quiet.
  const c = mk()
  c.turnStart()
  c.notify('idle')
  const idleNeverGreens = c.current() === 'idle'
  const c2 = mk()
  c2.turnStart()
  c2.idlePrompt()
  const idlePromptNeverGreens = c2.current() === 'idle'

  // THE SUBAGENT GATE: defer, then redeem.
  const d = mk()
  d.turnStart()
  d.subagentStart()
  d.subagentStart()
  d.notify('done') // the main ends its turn mid-fan-out — DEFERRED, not dropped
  const deferredStaysBusy = d.current() === 'busy'
  d.subagentStop()
  const oneLeftStaysBusy = d.current() === 'busy'
  d.subagentStop() // the last one lands: main-done AND zero subagents, so the verdict is due
  const redeemedOnLastStop = d.current() === 'done'

  // A STRAY stop (a background child outliving the turnStart that reset the counter) must not
  // settle a pane that is working on THIS turn.
  const e = mk()
  e.turnStart()
  e.subagentStop()
  const strayStopIgnored = e.current() === 'busy'

  // ...and turnStart UNSTICKS a counter left high by a subagent killed before its stop event.
  // Without it, that count swallows every future done and strands the pane on busy forever.
  const f = mk()
  f.subagentStart()
  f.subagentStart()
  f.turnStart() // nothing has fanned out yet this turn, so a nonzero count is stale by definition
  f.notify('done')
  const turnStartUnsticks = f.current() === 'done'

  // A BLOCK OUTRANKS A DEFERRED DONE. Blocked-on-a-human is not finished, whatever it said before.
  const g = mk()
  g.turnStart()
  g.subagentStart()
  g.notify('done') // deferred...
  g.raiseAttention() // ...but it needs you now. That done is stale.
  g.subagentStop()
  const blockOutranksDeferred = g.current() === 'attention'

  // ...as does going back to work.
  const h = mk()
  h.turnStart()
  h.subagentStart()
  h.notify('done')
  h.notify('busy') // it is working: whatever it said, it did not finish
  h.subagentStop()
  const busyOutranksDeferred = h.current() === 'busy'

  // THE BELL DEDUCTION. Both halves, armed together so one wait covers both.
  const withDone = mk()
  withDone.turnStart()
  withDone.bell() // the CLI chimes — on what?
  withDone.notify('done') // ...its own completion, riding ~130-260ms behind on a hook
  const alone = mk()
  alone.turnStart()
  alone.bell() // nothing behind it
  await sleep(BELL_CONFIRM_MS + 400) // outlive the confirmation window
  const chimeWithDoneIsGreen = withDone.current() === 'done' // never red
  const chimeAloneIsRed = alone.current() === 'attention' // the only red 3 of 5 CLIs have

  // THE SUBMIT RULE. A stray key must never clear a red and claim the agent is working — no CLI
  // re-raises a needs-input it has already raised, so that lie has no way back.
  const i = mk()
  i.raiseAttention()
  i.input(false) // an arrow key, a ^C, a bare character
  const strayHoldsRed = i.current() === 'attention'
  i.input(true) // Enter: the agent said it was blocked on this human, and the human answered
  const submitClearsToBusy = i.current() === 'busy'

  // ...and the byte rule that decides which is which.
  const submitBytes =
    isSubmittedInput('\r') &&
    isSubmittedInput('\n') &&
    isSubmittedInput('abc\r') && // a coalesced chunk ending in Enter
    !isSubmittedInput('x') &&
    !isSubmittedInput('\x1b\r') && // Shift+Enter (meta-CR) — composing, not answering
    !isSubmittedInput('\x1b[13;2u') && // Shift+Enter (CSI-u, kitty/modifyOtherKeys)
    !isSubmittedInput('\x1b[A') && // an arrow key
    !isSubmittedInput('\x03') && // ^C
    !isSubmittedInput('\x1b[200~a\rb\x1b[201~') // bracketed paste — composing

  return {
    silentStaysUnknown,
    doneGreens,
    idleNeverGreens,
    idlePromptNeverGreens,
    deferredStaysBusy,
    oneLeftStaysBusy,
    redeemedOnLastStop,
    strayStopIgnored,
    turnStartUnsticks,
    blockOutranksDeferred,
    busyOutranksDeferred,
    chimeWithDoneIsGreen,
    chimeAloneIsRed,
    strayHoldsRed,
    submitClearsToBusy,
    submitBytes
  }
}

/** A. An OSC body over MAX_OSC used to drop the parser to ground state mid-sequence, so the
 *  sequence's OWN terminator scanned as output: a >4KB OSC 52 clipboard write (vim/tmux emit
 *  exactly this) rang a bell and latched the pane red — "needs your input" for a yank. The
 *  overflow now discards to the real terminator instead. Both halves are asserted: the false
 *  bell is gone, and a GENUINE bell still rings (an overzealous swallow would be the same bug
 *  wearing the other mask). */
function oscOverflowAsserts(): { pass: boolean; falseBells: number; realBell: number; splitBells: number; stBells: number; cwdOk: boolean } {
  const big = 'A'.repeat(5000)
  const falseBells = bellsFor(['\x1b]52;c;' + big + '\x07'])
  // Same payload, arriving in small chunks: the discard state must survive push() boundaries.
  const payload = '\x1b]52;c;' + 'B'.repeat(6000) + '\x07'
  const chunks: string[] = []
  for (let i = 0; i < payload.length; i += 137) chunks.push(payload.slice(i, i + 137))
  const splitBells = bellsFor(chunks)
  // ST-terminated overflow with ESC and '\' landing in DIFFERENT chunks.
  const stBells = bellsFor(['\x1b]52;c;' + 'C'.repeat(5000) + '\x1b', '\\', 'plain output\n'])
  // The other half of the contract: a real bell, and a normal OSC 7, still work.
  const realBell = bellsFor(['some output\x07more'])
  let cwd: string | undefined
  const p = new OscParser(
    () => {},
    (ev) => {
      if (ev.kind === 'cwd') cwd = ev.payload
    }
  )
  p.push('\x1b]7;file:///C:/repo\x07')
  const cwdOk = cwd === 'file:///C:/repo'
  return {
    pass: falseBells === 0 && splitBells === 0 && stBells === 0 && realBell === 1 && cwdOk,
    falseBells,
    splitBells,
    stBells,
    realBell,
    cwdOk
  }
}
const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const m = window.__mogging
  if (!m || !m.workspace || !m.attention) return { pass: false, error: 'no dev handles' }
  // Launcher-first boot: provision Workspace 1 (ordinal 0 -> pane 1) ourselves.
  if (m.workspace.count() === 0) {
    m.workspace.create({ name: 'Workspace 1' })
    await sleep(600)
  }
  m.workspace.create({ name: 'Foreground' }) // ordinal 1, active -> Workspace 1 (ordinal 0) backgrounded
  await sleep(700)
  const bgTab = document.querySelectorAll('.workspace-tab')[0] // Workspace 1
  m.attention.setPaneState(1, 'attention') // pane 1 lives in Workspace 1 (base 0)
  await sleep(400)
  const ringed = bgTab.getAttribute('data-attention')
  m.workspace.switchByIndex(0) // focus Workspace 1 -> its ring clears
  await sleep(400)
  const afterFocus = bgTab.getAttribute('data-attention')

  // THE VERDICT LAW. Green has exactly ONE source — an explicit \`done\` verdict — and this is
  // the gate that says so. It is written to FAIL on the old engine, which derived "finished"
  // from a busy->idle EDGE over a 2.5s duration floor and therefore could not tell a Stop hook
  // from a terminal that had merely gone quiet. Under that rule, typing a prompt slowly, or
  // switching workspaces (the refit resizes the pty and ConPTY repaints its whole viewport),
  // or an agent pausing on a slow tool call, each stamped a pane "finished working".
  const slot = () => document.querySelector('.layout-slot[data-pane-id="1"]')
  const chip = () => { const e = document.querySelector('.layout-slot[data-pane-id="1"] .pane-state'); return e ? e.getAttribute('data-state') : null }
  const alert = () => { const s = slot(); return s ? s.getAttribute('data-alert') : null }
  const click = () => { const s = slot(); if (s) s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) }

  // 1. SILENCE IS NOT A COMPLETION. A long busy stretch that simply settles to idle greens
  //    NOTHING — this is the phantom green, and it is the whole reason for the rewrite.
  m.attention.setPaneState(1, 'busy')
  await sleep(2700) // outlive the OLD 2.5s work floor — under the old rule this WOULD have greened
  m.attention.setPaneState(1, 'idle')
  await sleep(300)
  const quietIsNotGreen = chip() === 'idle' && !alert()

  // 2. A VERDICT IS. \`done\` greens the pane, and the duration floor is gone with the guess that
  //    needed it: a done is a done whether the task took 300ms or 30 seconds.
  m.attention.setPaneState(1, 'busy')
  await sleep(150) // deliberately FAR under the old floor
  m.attention.setPaneState(1, 'done')
  await sleep(300)
  const doneGreensFast = chip() === 'finished' && alert() === 'finished'

  // 3. A click acknowledges it: dot back to yellow, resting outline gone.
  click()
  await sleep(300)
  const ackClears = chip() === 'idle' && !alert()

  // 4. A blocked pane wears a RED resting outline — the pane carries its own state now, rather
  //    than fading to nothing and leaving a 13px dot to tell the whole story.
  m.attention.setPaneState(1, 'attention')
  await sleep(300)
  const blockedOutline = chip() === 'attention' && alert() === 'input'

  // 5. ...and answering it is not finishing it. An attention->idle edge completed nothing.
  m.attention.setPaneState(1, 'idle')
  await sleep(300)
  const blockedNotFinished = chip() === 'idle' && !alert()

  // 6. A pane that has never spoken a verdict is HOLLOW, not yellow. \`unknown\` is the absence
  //    of a claim; \`idle\` is a claim ("nothing is running") we would have no basis for.
  const pane2 = document.querySelector('.layout-slot[data-pane-id="101"] .pane-state')
  const unknownIsHollow = !pane2 || pane2.getAttribute('data-state') === 'unknown'

  const pass = ringed === 'attention' && !afterFocus &&
    quietIsNotGreen && doneGreensFast && ackClears && blockedOutline && blockedNotFinished && unknownIsHollow
  return {
    pass,
    ringed,
    afterFocus,
    quietIsNotGreen,
    doneGreensFast,
    ackClears,
    blockedOutline,
    blockedNotFinished,
    unknownIsHollow,
    chipFinal: chip(),
    tabs: document.querySelectorAll('.workspace-tab').length
  }
})()`

export function runAttentionSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 45000) // safety net (the tracker's bell asserts wait out a real window)
  const run = async (): Promise<void> => {
    let result: { pass?: boolean; osc?: unknown; tracker?: unknown; error?: string } = { pass: false }
    const osc = oscOverflowAsserts()
    const tracker = await trackerAsserts()
    const trackerOk = Object.values(tracker).every(Boolean)
    try {
      const ui = (await win.webContents.executeJavaScript(SCRIPT, true)) as { pass?: boolean }
      result = { ...ui, osc, tracker, pass: ui.pass === true && osc.pass && trackerOk }
    } catch (e) {
      result = { pass: false, osc, tracker, ...{ error: String(e) } }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'attention-result.json'), JSON.stringify(result))
    } catch {
      /* best effort */
    }
    app.exit(result?.pass ? 0 : 1)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 2500))
  else setTimeout(run, 2500)
}
