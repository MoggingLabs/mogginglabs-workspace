import type { AgentState } from '@contracts'

// The pane-state ENGINE (the dot in every pane header). The OSC parser alone was the
// original source, and on real setups it is nearly mute: cmd.exe emits no OSC 133,
// and neither does Claude Code (verified against the 2.1.205 bundle — zero `]133;`
// emitters), so the dot sat on 'idle' forever. This tracker fuses the signals that
// DO exist, in strict precedence:
//
//   attention  LATCHED by an explicit needs-input verdict (`mogging notify`, an agent
//              hook — HIGH confidence: it says by name that a human is blocking the
//              agent), and by an unclaimed raw bell (BEL outside an OSC, OSC 9/99/777
//              — LOW confidence, see THE BELL below). Cleared by the user TYPING into
//              the pane (they answered), or by an explicit busy/idle notify (the agent
//              says it moved on).
//   busy       OSC 133;C latches it until 133;D (integrated shells keep their exact
//              semantics — a silent long computation stays busy); otherwise plain
//              OUTPUT ACTIVITY: bytes flowing = working, quiet = not. Also held up by
//              pending SUBAGENTS — see the gate below.
//   idle       no latch, no recent output. 133;D forces it immediately and opens a
//              short grace so the prompt repaint that follows D doesn't flash busy.
//
// THE SUBAGENT GATE. Every alert the user sees — the pane dot, the workspace-rail badge
// and outline, the grid pulses — is the MAIN agent's story. Subagents are invisible: the
// SubagentStart/SubagentStop hooks only ever raise and lower a counter, and NO subagent
// event is ever allowed to author a pane state. Their sole job is to swallow the main's
// premature verdicts, because an agent that fans work out ENDS ITS OWN TURN while the
// subagents run: it fires Stop, goes quiet, and after 60s at the prompt fires an idle
// notification. Read literally, those say "finished" and then "blocked on you", so the
// pane pulsed green and then rang red with the work still in flight. While the count is
// up:
//   - a quiet terminal does not settle to idle (the work is elsewhere, not absent),
//   - the main's done/idle is DROPPED — that is the main parking, not finishing; the
//     green belongs to its NEXT done, once the results re-invoke it and it ends for real,
//   - an idle-prompt is dropped (parked-on-subagents is not blocked-on-you).
// A real permission prompt still rings red instantly — that one IS blocked on you — and
// a sibling subagent starting never clears it.
//
// THE BELL. A raw bell is a GUESS, not a verdict. Every CLI rings it on COMPLETION as
// well as when blocked (Codex notifies on turn-complete; Claude's terminal_bell channel
// fires for `agent_completed`), so "bell = blocked" painted finished panes red. It is
// therefore held for BELL_CONFIRM_MS and rings only if nothing contradicts it: the
// done/needs-input that rides a hook lands ~130-260ms behind and settles what the bell
// could only guess at. This is what makes Codex legible — its OSC 9 fires on both events,
// but its notify program fires ONLY on turn-complete, so a bell WITH a done behind it is
// a completion (green) and a bell ALONE is an approval (red). Output does not contradict
// a bell: an agent painting its approval dialog after ringing must still go red.
//
// Emits only on CHANGE — a streaming agent costs one 'busy' per burst, not one per
// chunk. Timer is unref'd; dispose() clears it. Electron-free; both PTY backends
// (daemon session + in-proc service) wire one tracker per pane.

/** Output must stay quiet this long before busy settles back to idle. */
const QUIET_MS = 1500
/** After a forced idle (133;D / notify idle/done), output inside this window does not
 *  re-mark busy. Sized for the SLOWEST legitimate straggler, not the fastest: a shell's
 *  prompt repaint follows D within a few frames, but an agent's done-hook races its own
 *  final repaint — the hook's socket message can beat the trailing frame (statusline
 *  re-run ~100-500ms of process spawn, ConPTY flush) through to the tracker. A trailing
 *  frame that lands past a short grace flips busy and CLEARS the just-stamped finished
 *  flag; the sub-noise-floor busy→idle round that follows never re-stamps it, so the
 *  green "done" halo silently vanished. Real new work always outlives this window. */
const IDLE_GRACE_MS = 1200
/** How long a raw bell waits to be CONTRADICTED before it rings (see bell()).
 *
 *  It must outlast an explicit verdict's whole trip: the CLI spawns `node`, which connects to
 *  the daemon and speaks the handshake. Measured at 130-260ms idle — but that is the number to
 *  size AGAINST, not to trust: a cold process spawn on a machine running sixteen busy panes is
 *  the case that matters, and it is unbounded above. Undersize this and a completion's `done`
 *  lands AFTER its own chime has already rung: the pane latches red, and the late done then
 *  arrives as an attention->idle edge — which by design never stamps green (attention-port).
 *  So an undersized window does not merely delay the truth, it DESTROYS it: a red pulse and a
 *  grey dot on a pane that finished perfectly well. Generous is the safe direction.
 *
 *  The only cost of generosity is that an unclaimed bell — a genuine block, on a CLI whose
 *  chime is all we have — turns red this late. That is a "come here" signal, not a control
 *  input; a beat of latency is imperceptible, and it buys the completion story its correctness.
 *
 *  It is deliberately ABOVE QUIET_MS. The quiet timer stands down while a bell is pending
 *  (armQuietTimer), precisely so this window is sized by the spawn it is waiting on rather than
 *  by an unrelated constant. */
const BELL_CONFIRM_MS = 2000

export class ActivityTracker {
  private state: AgentState = 'idle'
  private latched = false // attention holds until input or an explicit notify
  private oscBusy = false // 133;C .. 133;D bracket — outranks the quiet timer
  private graceUntil = 0
  private quietTimer: ReturnType<typeof setTimeout> | undefined
  private bellTimer: ReturnType<typeof setTimeout> | undefined // a raw bell, awaiting contradiction
  // Subagents in flight (SubagentStart/SubagentStop hooks). A GATE, never a source —
  // see the header. While > 0 it holds the pane busy and swallows the main's premature
  // verdicts; it never emits one of its own.
  //
  // It is also the only latch here a MISSING event could stick (a subagent killed hard,
  // Ctrl+C mid-fan-out): stuck above zero it would swallow every later done and strand
  // the pane on busy. turnStart() is the reset — at prompt-submit time no subagent of
  // THIS turn has started yet, so a nonzero count is by definition stale. The failure
  // direction is always busy, never a false green.
  private pendingSubagents = 0

  constructor(
    private readonly emit: (state: AgentState) => void,
    private readonly now: () => number = Date.now
  ) {}

  /** Output bytes arrived (call once per chunk, BEFORE parsing the chunk's OSC —
   *  a verdict carried IN the chunk must land after the activity it rides on). */
  data(): void {
    if (this.now() < this.graceUntil) return
    this.armQuietTimer()
    this.apply(this.latched ? 'attention' : 'busy')
  }

  /** A RAW "look at me" off the PTY stream: BEL outside an OSC, or an OSC 9/99/777
   *  notification. It is a GUESS, not a verdict — every agent CLI rings it on COMPLETION
   *  as well as when blocked (Codex notifies on turn-complete, Claude's terminal_bell
   *  channel fires for `agent_completed`), so on its own it cannot tell "done" from
   *  "blocked", and taking it for "blocked" painted finished panes red.
   *
   *  So it is held for a beat instead of latching outright. An explicit verdict landing
   *  inside the window — the done/needs-input riding ~130-260ms behind it on a hook —
   *  is KNOWLEDGE and cancels the guess. Only an unclaimed bell, from a CLI with no hook
   *  wired at all, actually rings; there it is the one signal we have, so it still must.
   *  A bell inside the idle grace is dropped outright: a done just landed, and this is
   *  that done's own completion chime arriving on the trailing frames.
   *
   *  Note that OUTPUT does not cancel it — an agent printing its approval dialog after
   *  ringing is exactly the case that must still go red. Only a verdict speaks. */
  bell(): void {
    if (this.now() < this.graceUntil) return
    if (this.bellTimer) return // already pending — one ring per episode
    this.bellTimer = setTimeout(() => {
      this.bellTimer = undefined
      this.raiseAttention()
    }, BELL_CONFIRM_MS)
    this.bellTimer.unref?.()
  }

  /** An EXPLICIT needs-input verdict (a hook said so, by name). High confidence: it rings
   *  at once, and never waits on the bell's confirmation window. */
  raiseAttention(): void {
    this.clearBellTimer()
    this.latched = true
    this.apply('attention')
  }

  /** An explicit state verdict: OSC 133 C/D, `mogging notify`, an agent hook. */
  notify(state: AgentState): void {
    // Knowledge outranks a guess: whatever this says, it settles what a pending bell was
    // trying to infer — including a `done` that the bell would otherwise have reddened.
    this.clearBellTimer()
    if (state === 'attention') {
      this.raiseAttention()
      return
    }
    // busy/idle are the agent explicitly moving on — they clear an attention latch.
    this.latched = false
    if (state === 'busy') {
      this.oscBusy = true
      this.apply('busy')
    } else if (this.pendingSubagents > 0) {
      // The main's turn ended while its subagents are still working. That is the main
      // PARKING, not the work finishing — so this done is DROPPED, not deferred. The
      // green belongs to the main's NEXT done: the results re-invoke it, it works, and
      // it ends for real. Replaying a dropped done from a subagent event would make the
      // subagent the author of the pulse — the one thing that must never happen.
      this.oscBusy = false
      this.apply('busy')
    } else {
      this.forceIdle()
    }
  }

  /** SubagentStart hook: bookkeeping + hold busy. Never clears an attention latch —
   *  a sibling subagent starting must not wipe the red the MAIN raised (one subagent
   *  asking for permission while three others run is exactly this shape). */
  subagentStart(): void {
    this.clearBellTimer() // a hook spoke: work started, so a pending bell was not a block
    this.pendingSubagents++
    this.apply(this.latched ? 'attention' : 'busy')
  }

  /** SubagentStop hook: bookkeeping ONLY — it emits no verdict of its own. Green is the
   *  main's story to tell and it will: the results re-invoke it, and its next done is
   *  the real one. The re-armed quiet timer is a BACKSTOP, not the path: a main that
   *  never comes back settles through the same output-quiescence baseline as a hookless
   *  CLI, instead of stranding the pane on busy forever. */
  subagentStop(): void {
    // Cancel the guess BEFORE the stray guard: a subagent landing is exactly what some
    // CLIs chime for (OpenCode fires its attention notification on `subagent_done`), and
    // that bell must not ring red for a subagent that finished. This is a hook speaking,
    // so it contradicts a pending bell even when the counter says nothing is owed.
    this.clearBellTimer()
    // A stop with nothing pending is STRAY — a background subagent outliving the turnStart
    // that reset the counter, or a CLI that reports child completions without starts.
    // Ignore it: re-arming the settle timer here would let a stale event from the last turn
    // quietly idle (and green) a pane that is working on this one.
    if (this.pendingSubagents === 0) return
    this.pendingSubagents--
    if (this.pendingSubagents === 0) this.armQuietTimer()
  }

  /** Claude Code's "Claude is waiting for your input" notice. It fires on an idle TIMER,
   *  not on a block — so it is an IDLE verdict, not an attention one. Ringing it red was
   *  a lie in both directions: it turned a finished pane's green halo red a minute after
   *  it finished (nothing was blocking; it had simply gone quiet), and it said "act now"
   *  about a pane that only wanted reading. Green already carries "come look".
   *  Dropped while subagents are in flight (parked on them is not idle) and while a real
   *  block is latched (it must never clear a genuine red). Otherwise it settles the pane —
   *  which also rescues one whose Stop we somehow missed. */
  idlePrompt(): void {
    if (this.pendingSubagents > 0 || this.latched) return
    this.notify('idle')
  }

  /** UserPromptSubmit hook: a new turn begins. Nothing this turn has fanned out yet, so
   *  any surviving pending count is stale (a subagent killed before its stop event) —
   *  drop it rather than let it swallow every future done and strand the pane on busy.
   *  The prompt itself is also new WORK, and a MAIN event: it answers whatever was
   *  blocking, and it reclaims a pane still wearing the last turn's green (the grace
   *  window from that forced idle must not swallow the flip). */
  turnStart(): void {
    this.clearBellTimer() // the user is here and typing; nothing is owed a ring
    this.pendingSubagents = 0
    this.latched = false
    this.graceUntil = 0
    this.armQuietTimer()
    this.apply('busy')
  }

  /** The live verdict, for state-sync PULLS (a mounting pane asking "what am I now").
   *  Events only fire on CHANGE, so this is the one way to read the current truth. */
  current(): AgentState {
    return this.state
  }

  /** The user typed into the pane: whatever it was blocked on has been answered. */
  input(): void {
    this.clearBellTimer() // the human is already here — a pending ring has nothing to say
    if (!this.latched) return
    this.latched = false
    this.apply(this.oscBusy || this.pendingSubagents > 0 || this.quietTimer ? 'busy' : 'idle')
  }

  private forceIdle(): void {
    this.oscBusy = false
    this.graceUntil = this.now() + IDLE_GRACE_MS
    this.clearQuietTimer()
    this.apply('idle')
  }

  dispose(): void {
    this.clearQuietTimer()
    this.clearBellTimer()
  }

  private clearBellTimer(): void {
    if (this.bellTimer) {
      clearTimeout(this.bellTimer)
      this.bellTimer = undefined
    }
  }

  private armQuietTimer(): void {
    this.clearQuietTimer()
    this.quietTimer = setTimeout(() => {
      this.quietTimer = undefined
      // A bell is pending: a verdict is imminent and it decides this pane. Settling to idle
      // now would stamp GREEN a moment before a genuine block rings RED — a green flash on
      // a pane that needs you. Re-arm and let the bell resolve first; whatever it resolves
      // to, the next tick settles normally. (This is also what frees BELL_CONFIRM_MS from
      // having to hide under QUIET_MS — see the constant.)
      if (this.bellTimer) {
        this.armQuietTimer()
        return
      }
      if (!this.latched && !this.oscBusy && this.pendingSubagents === 0) this.apply('idle')
    }, QUIET_MS)
    this.quietTimer.unref?.()
  }

  private clearQuietTimer(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer)
      this.quietTimer = undefined
    }
  }

  private apply(state: AgentState): void {
    if (state === this.state) return
    this.state = state
    this.emit(state)
  }
}
