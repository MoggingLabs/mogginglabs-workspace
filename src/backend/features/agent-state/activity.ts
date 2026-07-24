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
// THE DEDUCTIONS. None is a guess. Each combines facts we are CERTAIN of into a conclusion
// that is therefore also certain — which is exactly what "bytes went quiet so it probably
// finished" never was.
//
//   1. ANSWERING A RED MEANS IT IS WORKING (input). The agent said BY NAME that it was blocked
//      on this human; the human fed it a submitted line OR a printable key (every permission
//      dialog takes single-key answers — Claude's digit menu, Codex/Gemini's `y` — and no hook
//      fires at approval time). It follows that it is no longer blocked and is working.
//      Navigation and signals (arrows, ^C, mouse reports) answer nothing and clear nothing.
//
//   2. A CHIME WITH NO `done` BEHIND IT MEANS BLOCKED (bell). See BELL_CONFIRM_MS.
//
//   3. AN UNKNOWN-TYPE NOTIFICATION MID-TURN IS NOT A BLOCK (notice). Its arrival proves the
//      hook channel works, and on a working channel every blocking type arrives as an explicit
//      needs-input — so mid-turn (busy) it is swallowed, and it retracts the raw-BEL twin that
//      rode ahead of it. Out of turn it is held for contradiction like any chime.
//
//   4. A SHELL PROMPT MEANS THE FOREGROUND PROGRAM IS GONE (shellPrompt). Real integration —
//      133;D or our own injected dialects — so `busy` and a latched red die with the program
//      that raised them. It never authors a first verdict and never spends a green.
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
export const BELL_CONFIRM_MS = 2000

/** How long after a `done` a chime is still THAT DONE'S OWN completion chime.
 *
 *  Sized for the trailing frames, not for a race: the Stop hook spawns a process and speaks the
 *  daemon's socket, while the chime is a single byte the CLI writes straight to the pty — so the
 *  done can, and routinely does, land FIRST, with the BEL arriving behind it on the final render
 *  flush (statusline re-run, ConPTY flush). Anything inside this window belongs to the turn that
 *  just ended. */
export const DONE_CHIME_GRACE_MS = 2500

export class ActivityTracker {
  /** `unknown` until this pane speaks. Never returns to it — with ONE exception: a red the
   *  bell GUESSED into existence, retracted by its own notification's late verdict (see
   *  notice()), restores whatever it displaced, and a retracted guess about a pane that had
   *  never spoken honestly restores `unknown`. Verdicts are never forgotten; guesses may be. */
  private state: AgentState = 'unknown'
  private latched = false // attention holds until an answer or an explicit verdict
  /** Provenance for a standing latch: the state the BELL TIMER displaced when it latched red
   *  (a confirmed guess), or null when the latch is explicit (needs-input said so, by name).
   *  Only a guess-latch may ever be retracted — see notice(). */
  private bellLatchedFrom: AgentState | null = null
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

  /** When this pane last went `done`. A chime inside DONE_CHIME_GRACE_MS of it is that turn's own
   *  completion chime, not a block — see bell(). Stamped in apply(), so EVERY road into `done`
   *  sets it: the plain verdict, and the deferred one redeemed when the last subagent lands. */
  private doneAt = -Infinity

  constructor(
    private readonly emit: (state: AgentState) => void,
    /** Injectable only so the gates can drive the chime windows without sleeping through them. */
    private readonly now: () => number = Date.now
  ) {}

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
    // A CHIME ON A FINISHED TURN IS THAT TURN'S OWN CHIME. This guard is not an optimisation;
    // without it the most common event in the product ends in red.
    //
    // Every CLI rings on COMPLETION as well as when blocked, and for Claude the app itself turns
    // that on — the notify-hook overlay wires the `terminal_bell` channel, which fires for
    // `agent_completed`. So the end of a normal turn is: the Stop hook lands `done` (the pane
    // goes green), and then a BEL arrives on the trailing frames. The `done` is already spent, so
    // there is nothing left to contradict the chime, and BELL_CONFIRM_MS later it would latch the
    // pane RED — "needs your input" — on an agent that had just finished perfectly well.
    //
    // The deduction still holds, because it was never symmetric in TIME: a chime is ambiguous
    // only while the turn might still be running. Once the agent has SAID it finished, a chime
    // cannot mean "blocked on you" — a turn that has ended is not waiting for anything. A CLI
    // with no `done` at all never reaches this state, so its chime rings exactly as before.
    //
    // (A grace window like this existed, hung off the old forced-idle path, and was removed
    // along with the output-quiescence machinery it sat in — it was doing separate,
    // load-bearing work. Found live on v0.11.0: every finished turn went green and then red.)
    if (this.state === 'done' || this.now() - this.doneAt < DONE_CHIME_GRACE_MS) return
    if (this.bellTimer) return // already pending — one ring per episode
    this.bellTimer = setTimeout(() => {
      this.bellTimer = undefined
      const displaced = this.state
      this.raiseAttention()
      // Provenance, stamped AFTER the raise (raiseAttention nulls it, because an EXPLICIT red
      // must never be retractable): this red is a confirmed GUESS, and `displaced` is what it
      // pushed aside. notice() may retract it — the hook that was racing this window can lose
      // the race (a cold node spawn under a sixteen-pane load is unbounded) and still win the
      // argument when it lands. A pane already wearing attention records nothing: the standing
      // red was explicit, or an earlier guess whose own record stands.
      if (displaced !== 'attention') this.bellLatchedFrom = displaced
    }, BELL_CONFIRM_MS)
    this.bellTimer.unref?.()
  }

  /** An EXPLICIT needs-input verdict (a hook said so, by name). High confidence: it rings at
   *  once and never waits on the chime's confirmation window. */
  raiseAttention(): void {
    this.clearBellTimer()
    this.latched = true
    this.bellLatchedFrom = null // explicit: this red is a verdict, and no notice may retract it
    this.deferredDone = false // blocked on a human is not finished, whatever it said earlier
    this.apply('attention')
  }

  /** A notification whose TYPE the hook script did not recognize — a guess, but a guess that
   *  arrived THROUGH the rich hook channel, and that arrival is itself a fact: the hooks work.
   *
   *  While the pane is BUSY, that fact decides it. A turn is in flight, and on a working hook
   *  channel every notification type that genuinely blocks arrives as an explicit needs-input —
   *  the script's whitelist enumerates all of them (permission, elicitation, input asks). So an
   *  unknown type mid-turn is certainly NOT a block: swallow it, and cancel the chime it rode
   *  in on (`preferredNotifChannel: terminal_bell` rings the raw BEL the instant the
   *  notification shows; this hook spawns a process to say the same thing and lands a beat
   *  later — without the cancel, the BEL's timer outlives its own retraction and latches red
   *  anyway). Before this rule, every new notification type a CLI shipped painted WORKING panes
   *  red for whole turns, on exactly the panes nobody was watching.
   *
   *  If the BEL's timer already RANG (the spawn lost the race outright), the standing red is a
   *  confirmed guess — bellLatchedFrom records what it displaced — and this notice is that same
   *  notification's verdict arriving late. Retract it: restore the displaced state. An explicit
   *  needs-input latch records no provenance and is never retracted.
   *
   *  Anywhere else (idle, unknown, done) the busy certainty is gone — out-of-turn notifications
   *  (auth expiry, a dropped connection) are exactly the class the whitelist cannot enumerate
   *  and CAN be a genuine come-here — so it takes the bell's held-for-contradiction path, as
   *  before: swallowed on a done pane, rung one confirmation beat later everywhere else. */
  notice(): void {
    if (this.state === 'busy') {
      this.clearBellTimer()
      return
    }
    if (this.state === 'attention' && this.bellLatchedFrom !== null) {
      const displaced = this.bellLatchedFrom
      this.bellLatchedFrom = null
      this.latched = false
      this.apply(displaced)
      return
    }
    this.bell()
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
    this.bellLatchedFrom = null

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
   *  wearing the last turn's green.
   *
   *  It also ENDS the previous done's chime grace. The grace exists for a finished turn's
   *  trailing frames; once a new turn has begun, a chime belongs to the NEW turn — without the
   *  reset, a block in the first beats of turn N+1 (Gemini asking approval for its very first
   *  tool) was swallowed as turn N's completion chime, and the pane wore busy while blocked. */
  turnStart(): void {
    this.clearBellTimer() // the user is here and typing; nothing is owed a ring
    this.pendingSubagents = 0
    this.deferredDone = false
    this.latched = false
    this.bellLatchedFrom = null
    this.doneAt = -Infinity
    this.apply('busy')
  }

  /**
   * The user wrote to the pane. `submitted` = the chunk carried a SUBMITTED line — a bare CR/LF,
   * i.e. Enter (see isSubmittedInput). `engaged` = the chunk carried at least one PRINTABLE key —
   * content fed to the pane's foreground program (see isEngagedInput; ESC-introduced sequences
   * and bare control bytes fail it, so arrows, ^C, mouse reports, focus events and bracketed
   * paste all stay excluded).
   *
   * EITHER clears the latch. It was submit-only for a while, and that rule left the most common
   * answer in the product stuck red: every CLI's permission dialog takes single-key answers
   * (Claude Code's digit menu applies `1`/`2`/`3` instantly; Codex and Gemini take `y`) which
   * submit no line and fire no hook — nothing runs at approval time — and no CLI re-raises a
   * needs-input it has already raised. So the human answered, the agent worked on, and the pane
   * wore "blocked on you" for the remainder of the turn. A digit IS the whole answer.
   *
   * The original any-keystroke bug stays fixed by the printable/sequence split: navigation and
   * signals (arrows, ^C, a mouse click) still never clear it — none of them answer anything.
   * RESIDUAL, accepted: a printable typed at a latched pane and then abandoned mid-answer reads
   * as answered. The human was AT the dialog — seconds from resolution in any real case, against
   * the hours of false red this replaces.
   *
   * On a clear, DEDUCTION 1 applies: the agent said it was blocked on this human, and the human
   * just answered. It is working.
   *
   * A SUBMIT into a pane wearing `done` additionally ENDS that done. The line is new work handed
   * to a finished agent (or to its shell), and the green was already spent by the focus that
   * preceded the keystroke (the renderer acknowledges on click/keyboard-landing). Left standing,
   * the done DEAFENED the bell: bell() swallows every chime on a done pane, and the CLIs with no
   * turn-start hook (Codex, OpenCode) never leave `done` between turns — so from their second
   * turn on, an approval could never ring red again. The pane rests at idle (the honest claim
   * after an acknowledged done); the next real done re-greens it, and the grace resets so the
   * new turn's chimes are its own.
   */
  input(submitted: boolean, engaged: boolean = submitted): void {
    if (!submitted && !engaged) return
    // You answered (or are answering): whatever a pending chime was about, it is handled. (A
    // navigation key or a ^C must NOT cancel it — the chime may be a real block, and those say
    // nothing about which.)
    this.clearBellTimer()
    if (submitted && this.state === 'done') {
      this.doneAt = -Infinity // the grace belonged to the turn that ended; new work starts here
      this.apply('idle')
      return
    }
    if (!this.latched) return
    this.latched = false
    this.bellLatchedFrom = null
    this.apply('busy')
  }

  /** OSC 133;C — real shell integration marking a command LAUNCH. A verdict about the SHELL, so
   *  it may move a pane that has already spoken, but it must never author a pane's FIRST state:
   *  the claim is the shell's, and a hand-typed agent adopted minutes later would inherit it as
   *  its own solid dot (the hollow-dot contract — agent.ts `unknown`). */
  shellCmdStart(): void {
    if (this.state === 'unknown') return
    this.notify('busy')
  }

  /** The pane's shell is back at its PROMPT — OSC 133;D, or any of the dialects we inject
   *  ourselves (OSC 9;9 on cmd.exe, OSC 633 MoggingPrompt on PowerShell/POSIX/remote). The
   *  foreground program is GONE, and two claims die with it:
   *
   *    attention  a latch must not outlive the program that raised it. Kill a blocked agent
   *               (^C, a crash, /exit) and the pane sat RED at an empty prompt with nothing
   *               left that could ever clear it: none of OUR injected integrations emit 133;D,
   *               so the idle verdict never fired — and a remote pane has no process detector
   *               to retire the session either. The prompt IS the shell saying "nothing is
   *               running here", which is exactly what 133;D was already trusted to mean.
   *    busy       the same fact — and a dead program's turn leftovers (a pending-subagent
   *               count, a deferred done) are that program's story, reset with it.
   *
   *  Two claims deliberately survive:
   *
   *    done       a green is the USER's to spend. An agent that finished and then exited to
   *               the shell has still finished — 133;D used to silently eat that halo on the
   *               shells that emit it, an unwatched pane's completion vanishing unseen.
   *    unknown    a prompt is the SHELL speaking; the dot's first solid state is reserved for
   *               the agent's own channels (the hollow contract), and every fresh pane prints
   *               a prompt before anything else ever runs in it.
   *
   *  A pending CHIME deliberately survives too: `long_build; printf '\x1b]9;done\x07'` rings AT
   *  the prompt — the chime outlives its command; the block-claim does not. */
  shellPrompt(): void {
    this.settle()
  }

  /** The TURN died without a verdict — Claude Code's StopFailure (an API error ended the turn;
   *  the hook command still runs, its output merely goes unread) or OpenCode's session.error.
   *
   *  This is the stuck-busy fix (audit G2): a turn that dies emits no `done` and no `idle`,
   *  ever, so without this the pane wears busy until the next prompt. The claim is the same
   *  one a shell prompt makes — the thing that was running is GONE — so it settles the same
   *  way: `busy` and a latched red die with the turn that raised them, the dead turn's
   *  leftovers (pending subagents, a deferred done) are reset, and it never authors a first
   *  verdict nor spends a green (a failure completed nothing, and a standing done predates it). */
  turnFailed(): void {
    this.settle()
  }

  /** The shared settling rule: the foreground story is over with no completion. Guarded to
   *  busy/attention so it can neither author a first verdict (`unknown` stays hollow) nor
   *  spend a green (`done` is the user's to acknowledge). */
  private settle(): void {
    if (this.state !== 'busy' && this.state !== 'attention') return
    this.pendingSubagents = 0
    this.deferredDone = false
    this.latched = false
    this.bellLatchedFrom = null
    this.apply('idle')
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
    // Every road into `done` — the plain verdict AND the deferred one redeemed by the last
    // subagent — arms the chime grace. Stamping it at the call sites would have missed one.
    if (state === 'done') this.doneAt = this.now()
    this.state = state
    this.emit(state)
  }
}
