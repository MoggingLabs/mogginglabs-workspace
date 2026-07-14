import type { AgentState } from '@contracts'

// The pane-state ENGINE (the dot in every pane header).
//
// THE VERDICT LAW. Every state this emits is raised by a signal that KNOWS. Output activity
// raises nothing. That is the whole of the change, and it exists because the old engine
// GUESSED: bytes flowing meant `busy`, 1.5s of silence meant `idle`, and the busy->idle edge —
// over a 2.5s duration floor — was read as a COMPLETION. Four ordinary things therefore stamped
// panes "finished working" that had finished nothing:
//
//   - typing. Keystrokes echo, echo is output, output was `busy`. Type a prompt for a second,
//     pause to think for the quiet window, and the pane went green.
//   - the workspace switch itself. Switching refits the pane, the refit resizes the pty, and
//     ConPTY answers a resize by repainting its entire viewport. That burst read as work.
//   - any mid-turn pause. An agent waiting on a slow tool call is silent, and silence was idle.
//   - any long command YOU ran in the pane. `npm install` finishing is not the agent finishing.
//
// The 2.5s floor was the only thing between that inference and nonsense, and its entire safety
// margin was about one second of repaint. Explicit direction: never guess that an agent is done.
// Be sure. So `done` is now a state of its own (contracts/domain/agent.ts) and it is the ONLY
// thing that can ever paint green.
//
//   unknown    the initial state, and the honest one: this pane has never spoken a verdict, so
//              we have nothing to say about it. It renders HOLLOW. A pane leaves `unknown` on
//              its first verdict and never returns — the dot going solid IS the proof that this
//              agent's hooks reach us, which is the only proof there is. (A config file we can
//              read is not one: a remote pane's config lives on the remote host, and a config
//              present is not a hook firing.) Silence must never read as "it never finished".
//   busy       turn-start (the user submitted a prompt), a subagent running, an explicit busy,
//              OSC 133;C — or THE DEDUCTION below.
//   attention  an explicit needs-input verdict, or an uncontradicted chime (see bell()).
//   done       an explicit completion verdict. Nothing infers it. No duration gates it.
//   idle       an explicit idle. Note it can never green a pane: nothing about `idle` claims
//              that anything finished, and `idle-prompt` in particular fires on a 60-second
//              TIMER, not on a completion.
//
// THE TWO DEDUCTIONS. Neither is a guess. Each combines two facts we are CERTAIN of into a
// conclusion that is therefore also certain — which is exactly what "bytes went quiet so it
// probably finished" never was.
//
//   1. ANSWERING A RED MEANS IT IS WORKING (input). The agent said BY NAME that it was blocked
//      on this human; the human answered it. It follows that it is no longer blocked and is
//      working. Without this the pane would go red -> [you approve] -> idle-yellow for the whole
//      three minutes it then works -> green: a working agent that looks asleep, because no hook
//      fires when you type `y` at a permission prompt.
//
//   2. A CHIME WITH NO `done` BEHIND IT MEANS BLOCKED (bell). See BELL_CONFIRM_MS.
//
// THE SUBAGENT GATE. Alerts are the MAIN agent's story. Subagents only ever raise and lower a
// counter; no subagent event may author a pane state. Their job is to hold the main's verdict
// at the gate, because an agent that fans work out ENDS ITS OWN TURN while the subagents run —
// it fires Stop with the work still in flight. Explicit direction: green requires main-done AND
// zero subagents. So a `done` arriving with subagents pending is DEFERRED, not dropped, and is
// redeemed the moment the last one lands (subagentStop).
//
// Emits only on CHANGE. Timers are unref'd; dispose() clears them. Electron-free; both PTY
// backends (daemon session + in-proc service) wire one tracker per pane.

/** How long a raw chime waits to be CONTRADICTED before it rings (see bell()).
 *
 *  It must outlast an explicit verdict's whole trip: the CLI spawns `node`, which connects to
 *  the daemon and speaks the handshake. Measured at 130-260ms idle — but that is the number to
 *  size AGAINST, not to trust: a cold process spawn on a machine running sixteen busy panes is
 *  the case that matters, and it is unbounded above. Undersize this and a completion's `done`
 *  lands AFTER its own chime has already rung: the pane latches red on an agent that finished
 *  perfectly well.
 *
 *  The only cost of generosity is that a genuine block — on a CLI whose chime is all we have —
 *  turns red this late. That is a "come here" signal, not a control input; a beat of latency is
 *  imperceptible, and it buys the completion story its correctness. */
const BELL_CONFIRM_MS = 2000

export class ActivityTracker {
  /** `unknown` until this pane speaks. Never returns to it. */
  private state: AgentState = 'unknown'
  private latched = false // attention holds until an answer or an explicit verdict
  private bellTimer: ReturnType<typeof setTimeout> | undefined // a chime, awaiting contradiction

  // Subagents in flight (SubagentStart/SubagentStop). A GATE, never a source.
  //
  // It is the only latch here that a MISSING event could stick (a subagent killed hard, ^C
  // mid-fan-out): stuck above zero it would swallow every later done and strand the pane on
  // busy. turnStart() is the reset — at prompt-submit time no subagent of THIS turn has started
  // yet, so a nonzero count is by definition stale. The failure direction is always busy, never
  // a false green.
  private pendingSubagents = 0

  /** The main said `done` while its subagents were still running. Held, not discarded: green
   *  requires main-done AND zero subagents, and the first half of that is now true. Redeemed by
   *  the last subagentStop. Any evidence that the main is NOT finished after all — it went busy,
   *  a new turn began, it blocked on the user — throws it away. */
  private deferredDone = false

  // No injected clock any more: nothing here is TIMED except the chime's confirmation window,
  // which is a real setTimeout. The old tracker needed one because it measured output silence.
  constructor(private readonly emit: (state: AgentState) => void) {}

  /** A RAW "look at me" off the PTY stream: BEL outside an OSC, or an OSC 9/99/777 notification.
   *
   *  On its own it is ambiguous, not wrong — every agent CLI rings it on COMPLETION as well as
   *  when blocked (Codex notifies on turn-complete; Claude's terminal_bell channel fires for
   *  `agent_completed`; OpenCode's chime vocabulary is question/permission/error/done/
   *  subagent_done). Taken for "blocked" it painted finished panes red.
   *
   *  So it is HELD for a beat and asked whether an explicit `done` lands behind it:
   *
   *      chime + a `done` inside the window  -> a completion  -> green (the done applies)
   *      chime + NO `done`                   -> a block       -> red
   *
   *  Both inputs are certain: the CLI did ring, and no `done` did arrive. That makes the
   *  conclusion certain too — this is a deduction, not the output-quiescence guess. It is also
   *  load-bearing: it is the ONLY red Gemini and OpenCode have (Gemini's Notification hook is
   *  deliberately not wired — it fires for warnings and errors, which are not "blocked on you"),
   *  so removing it would leave three of five CLIs unable to say they need you.
   *
   *  Output does NOT cancel it: an agent painting its approval dialog after ringing is exactly
   *  the case that must still go red. Only a verdict speaks.
   *
   *  RESIDUAL, accepted: the deduction's soundness rests on the CLI being ABLE to say `done`.
   *  For a known provider whose hooks were never installed, "no done arrived" proves nothing,
   *  and its completion chime will ring red. That is a false red, which costs a glance and
   *  self-heals on the next verdict — the safe direction to be wrong in, and the one we choose
   *  everywhere here. A false green costs a task you believe is finished and is not. */
  bell(): void {
    if (this.bellTimer) return // already pending — one ring per episode
    this.bellTimer = setTimeout(() => {
      this.bellTimer = undefined
      this.raiseAttention()
    }, BELL_CONFIRM_MS)
    this.bellTimer.unref?.()
  }

  /** An EXPLICIT needs-input verdict (a hook said so, by name). High confidence: it rings at
   *  once and never waits on the chime's confirmation window. */
  raiseAttention(): void {
    this.clearBellTimer()
    this.latched = true
    this.deferredDone = false // blocked on a human is not finished, whatever it said earlier
    this.apply('attention')
  }

  /** An explicit state verdict: OSC 133 C/D, `mogging notify`, an agent hook. */
  notify(state: AgentState): void {
    // Knowledge outranks the guess it was holding: whatever this says settles what a pending
    // chime was trying to infer — including a `done` that would otherwise have rung red.
    this.clearBellTimer()

    if (state === 'attention') {
      this.raiseAttention()
      return
    }

    // busy/done/idle are all the agent explicitly moving on — they release an attention latch.
    this.latched = false

    if (state === 'busy') {
      this.deferredDone = false // it is working: whatever it said before, it did not finish
      this.apply('busy')
      return
    }

    if (state === 'done') {
      if (this.pendingSubagents > 0) {
        // The main's turn ended while its subagents are still working. Explicit direction: it
        // cannot go green until everything under it is also done. DEFER the verdict — it is the
        // main's own, and it stays the main's own; the gate only decides WHEN it is due.
        this.deferredDone = true
        this.apply('busy')
        return
      }
      this.apply('done')
      return
    }

    // Plain idle (OSC 133;D, an explicit `idle`, an idle-prompt). The pane settled, but NOTHING
    // completed — this may never green it. Still held busy while subagents run: the work is
    // elsewhere, not absent.
    this.apply(this.pendingSubagents > 0 ? 'busy' : 'idle')
  }

  /** SubagentStart: bookkeeping + hold busy. Never clears an attention latch — a sibling
   *  subagent starting must not wipe the red the MAIN raised (one subagent asking for
   *  permission while three others run is exactly this shape). */
  subagentStart(): void {
    this.clearBellTimer() // a hook spoke: work started, so a pending chime was not a block
    this.pendingSubagents++
    this.apply(this.latched ? 'attention' : 'busy')
  }

  /** SubagentStop: bookkeeping, and the moment a deferred `done` comes due. */
  subagentStop(): void {
    // Cancel the guess BEFORE the stray guard: a subagent landing is exactly what some CLIs
    // chime for (OpenCode fires its attention notification on `subagent_done`), and that chime
    // must not ring red for a subagent that merely finished. A hook is speaking, so it
    // contradicts a pending chime even when the counter says nothing is owed.
    this.clearBellTimer()
    // A stop with nothing pending is STRAY — a background subagent outliving the turnStart that
    // reset the counter, or a CLI that reports child completions without starts. Ignore it.
    if (this.pendingSubagents === 0) return
    this.pendingSubagents--
    if (this.pendingSubagents > 0) return

    // The last one landed. If the main had already said `done`, both halves of the rule are now
    // true — main is done AND nothing runs beneath it — so its deferred verdict is due. This is
    // still the MAIN's verdict, released from the gate; the subagent only opened the gate.
    //
    // RESIDUAL, accepted (explicit direction): if the main is one of the CLIs that ends its turn
    // mid-fan-out and is then RE-INVOKED by the results, it will work again — and with output
    // inference gone we cannot see that happen, so the pane would wear green while it works,
    // until its real Stop lands and re-greens it. The alternative is worse: leaving the done
    // unredeemed strands the pane on busy forever whenever that second Stop never comes.
    if (this.deferredDone && !this.latched) {
      this.deferredDone = false
      this.apply('done')
    }
    // Otherwise the main has not finished. Stay busy and wait for its verdict.
  }

  /** Claude Code's "Claude is waiting for your input" notice. It fires on an idle TIMER, not on
   *  a block — so it is an IDLE verdict, and it must never ring red (that turned a finished
   *  pane's green halo red a minute after it finished) nor green one (nothing completed; it had
   *  simply gone quiet). Dropped while subagents are in flight (parked on them is not idle) and
   *  while a real block is latched (it must never clear a genuine red). */
  idlePrompt(): void {
    if (this.pendingSubagents > 0 || this.latched) return
    this.notify('idle')
  }

  /** UserPromptSubmit: a new turn begins. Nothing this turn has fanned out yet, so any surviving
   *  pending count is stale (a subagent killed before its stop event) — drop it rather than let
   *  it swallow every future done and strand the pane on busy. The prompt itself is also new
   *  WORK and a MAIN event: it answers whatever was blocking, and it reclaims a pane still
   *  wearing the last turn's green. */
  turnStart(): void {
    this.clearBellTimer() // the user is here and typing; nothing is owed a ring
    this.pendingSubagents = 0
    this.deferredDone = false
    this.latched = false
    this.apply('busy')
  }

  /**
   * The user wrote to the pane. `submitted` = the chunk carried a SUBMITTED line — a bare CR/LF,
   * i.e. Enter (see isSubmittedInput, which is where Shift+Enter and bracketed paste are ruled
   * out). Only a submit may clear the latch.
   *
   * It used to clear on ANY keystroke, and that was a lie with no way back: an arrow key, a ^C,
   * a stray character each turned a blocked pane's red dot green and claimed it was WORKING —
   * while the agent sat there still blocked, and no CLI re-raises a needs-input it has already
   * raised. Red lingering a beat too long self-heals on the next verdict. A false "working" does
   * not heal at all.
   *
   * On a submit into a latched pane, DEDUCTION 1 applies: the agent said it was blocked on this
   * human, and the human just answered. It is working.
   */
  input(submitted: boolean): void {
    if (!submitted) return
    // You answered: whatever a pending chime was about, it is handled. (A stray keystroke must
    // NOT cancel it — the chime may be a real block, and a keypress says nothing about which.)
    this.clearBellTimer()
    if (!this.latched) return
    this.latched = false
    this.apply('busy')
  }

  /** The live verdict, for state-sync PULLS (a mounting pane asking "what am I now"). Events
   *  only fire on CHANGE, so this is the one way to read the current truth — including
   *  `unknown`, which is how a reattaching pane learns it must stay hollow. */
  current(): AgentState {
    return this.state
  }

  dispose(): void {
    this.clearBellTimer()
  }

  private clearBellTimer(): void {
    if (this.bellTimer) {
      clearTimeout(this.bellTimer)
      this.bellTimer = undefined
    }
  }

  private apply(state: AgentState): void {
    if (state === this.state) return
    this.state = state
    this.emit(state)
  }
}
