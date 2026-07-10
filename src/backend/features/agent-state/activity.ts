import type { AgentState } from '@contracts'

// The pane-state ENGINE (the dot in every pane header). The OSC parser alone was the
// original source, and on real setups it is nearly mute: cmd.exe emits no OSC 133,
// and neither does Claude Code (verified against the 2.1.205 bundle — zero `]133;`
// emitters), so the dot sat on 'idle' forever. This tracker fuses the signals that
// DO exist, in strict precedence:
//
//   attention  LATCHED by the terminal bell (BEL outside an OSC — the standard
//              "I need you" signal, and what Claude Code's terminal_bell notify
//              rings), by OSC 9/99/777 notifications, and by `mogging notify`.
//              Cleared by the user TYPING into the pane (they answered), or by an
//              explicit busy/idle notify (the agent says it moved on).
//   busy       OSC 133;C latches it until 133;D (integrated shells keep their exact
//              semantics — a silent long computation stays busy); otherwise plain
//              OUTPUT ACTIVITY: bytes flowing = working, quiet = not.
//   idle       no latch, no recent output. 133;D forces it immediately and opens a
//              short grace so the prompt repaint that follows D doesn't flash busy.
//
// Emits only on CHANGE — a streaming agent costs one 'busy' per burst, not one per
// chunk. Timer is unref'd; dispose() clears it. Electron-free; both PTY backends
// (daemon session + in-proc service) wire one tracker per pane.

/** Output must stay quiet this long before busy settles back to idle. */
const QUIET_MS = 1500
/** After a forced idle (133;D / notify idle), output inside this window does not
 *  re-mark busy — the shell's own prompt repaint follows D within a few frames. */
const IDLE_GRACE_MS = 300

export class ActivityTracker {
  private state: AgentState = 'idle'
  private latched = false // attention holds until input or an explicit notify
  private oscBusy = false // 133;C .. 133;D bracket — outranks the quiet timer
  private graceUntil = 0
  private quietTimer: ReturnType<typeof setTimeout> | undefined

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

  /** The terminal bell (BEL outside an OSC): the pane asked for a human. */
  bell(): void {
    this.latched = true
    this.apply('attention')
  }

  /** An explicit state verdict: OSC 133 C/D, OSC 9/99/777, `mogging notify`. */
  notify(state: AgentState): void {
    if (state === 'attention') {
      this.bell()
      return
    }
    // busy/idle are the agent explicitly moving on — they clear an attention latch.
    this.latched = false
    if (state === 'busy') {
      this.oscBusy = true
      this.apply('busy')
    } else {
      this.oscBusy = false
      this.graceUntil = this.now() + IDLE_GRACE_MS
      this.clearQuietTimer()
      this.apply('idle')
    }
  }

  /** The live verdict, for state-sync PULLS (a mounting pane asking "what am I now").
   *  Events only fire on CHANGE, so this is the one way to read the current truth. */
  current(): AgentState {
    return this.state
  }

  /** The user typed into the pane: whatever it was blocked on has been answered. */
  input(): void {
    if (!this.latched) return
    this.latched = false
    this.apply(this.oscBusy || this.quietTimer ? 'busy' : 'idle')
  }

  dispose(): void {
    this.clearQuietTimer()
  }

  private armQuietTimer(): void {
    this.clearQuietTimer()
    this.quietTimer = setTimeout(() => {
      this.quietTimer = undefined
      if (!this.latched && !this.oscBusy) this.apply('idle')
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
