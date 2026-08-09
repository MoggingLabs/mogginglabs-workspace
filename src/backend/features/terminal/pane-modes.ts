/**
 * Terminal MODE state for a pane's replay — the half the scrollback ring cannot carry.
 *
 * The ring is a CONTENT model, and a correct one for the normal buffer: history there is
 * linear text, so trimming the head only costs the oldest lines. It carries no STATE at
 * all, though, and `trimTornStart` only promises that the first byte after a cut is not
 * garbage — never that it will be INTERPRETED correctly. A mode whose enter was trimmed
 * while its exit survived (or the reverse) leaves the fresh xterm receiving that replay in
 * a state the live process never put it in.
 *
 * pane-shared's RESTORE_MODE_RESET already solves this for cold restore, and its comment
 * closes with "this never touches a live reattach, whose process still owns its modes".
 * That conflates two terminals. The PROCESS owns its modes; the freshly-constructed xterm
 * owns nothing — and the case that bit was the worst one: Claude Code emits `?1049h` ONCE,
 * ~2.5s after launch, so on any session past 200k characters of output the alternate-screen
 * ENTER has rolled off the head while thousands of alt-screen frames remain. Replayed
 * verbatim, those absolute-addressed cell diffs land in the NORMAL buffer, where LF scrolls.
 *
 * The fix is two rules, and both fall out of one scanner:
 *
 *   HEAD state grounds the segment being replayed. Not the tail: the segment carries every
 *   transition after its own start, so applying head-state then the segment reproduces the
 *   true current state exactly. Prefixing the TAIL and then replaying the whole ring would
 *   enter the alt buffer and let a surviving `?1049l` inside the ring kick it straight back
 *   out — the same bug in a new dress.
 *
 *   The ALT-SCREEN SUFFIX is not replayable content. The alternate screen has no scrollback
 *   by definition, so there is no history there to preserve — only "the current frame", and
 *   the current frame is not in the ring. What the ring holds is the diffs that PRODUCED it,
 *   computed against screen states nobody captured. Replayed into any buffer they are a
 *   superposition of frames from different moments.
 *
 * Zero imports, for the same reason attach-dims.ts has none: it keeps node-pty out of the
 * unit test. Shared rather than duplicated for the reason pane-shared.ts exists: the
 * in-proc PtyService replays its ring into a fresh xterm too, and a second copy of this
 * would be a parity break waiting to happen.
 */

// ── The tracked set ────────────────────────────────────────────────────────────────────
//
// Chosen by asking "what does the user experience when this bit is wrong?", which is also
// the argument for where the set STOPS.
//
// A — wrong buffer or wrong scrolling (the reported bug): the alt screen, DECSTBM, DECOM,
//     DECAWM. A trimmed margin leaves xterm scrolling the full screen while the app
//     believes rows are locked; a trimmed DECAWM shifts a whole frame down a row.
//
// B — corrupted INPUT, and the worst class because nobody attributes it to this bug:
//     bracketed paste (an unbracketed multi-line paste reads as Enter and AUTO-SUBMITS a
//     partial prompt), mouse tracking and its encoding (clicks inject escapes into the
//     prompt, or land on the wrong widget), focus reporting, DECCKM and the keypad (arrow
//     keys stop working — xterm sends ESC[A where the app expects ESC O A).
//
// C — pixels, plus one structural hook: cursor visibility, and DEC 2026 synchronized
//     output — TRACKED BUT NEVER MIRRORED. It is a per-frame bracket held for
//     milliseconds, not session state, and a replay must never begin inside an open frame:
//     pane-anchor early-returns while term.modes.synchronizedOutputMode is true, so a
//     stuck bit silently kills auto-scroll for the pane's whole life.
//
// NOT tracked, each a trap rather than an omission:
//   CURSOR POSITION — tracking it means emulating the terminal (every printable advances
//     it, plus wrap, scroll, CUP/CUU/CUD/CHA/VPA, tabs, CR/LF/BS, DECSC/DECRC, and reflow
//     on resize). It is also unnecessary: the alt branch emits ESC[H and the app repaints
//     from home, and in the normal branch the ring's own bytes place the cursor exactly as
//     they did live.
//   SGR — same reason (an attribute stack with 256-colour and truecolour parameter forms),
//     same non-necessity. Cost of omission: the first replayed line may render in default
//     attributes. That is the honest boundary — fix this class where it breaks the buffer
//     or the input, not where it costs one line of colour.
//   CHARSET DESIGNATION (ESC ( 0) — needs G0/G1 plus SI/SO shift state, and the agent CLIs
//     in scope draw with Unicode box characters. Known gap, stated rather than hidden.
//   XTSAVE/XTRESTORE (CSI ? Pm s / CSI ? Pm r) — can flip the alt buffer without an h/l.
//     Rare; degrades to today's behaviour. Note the `?` discriminator below exists so that
//     XTRESTORE is at least never MISREAD as a scroll region.

const F_DECCKM = 1 << 0 // ?1    application cursor keys
const F_DECOM = 1 << 1 // ?6    origin mode
const F_DECAWM = 1 << 2 // ?7    autowrap                    (DEFAULT SET)
const F_CURSOR = 1 << 3 // ?25   cursor visible              (DEFAULT SET)
const F_MOUSE_NORMAL = 1 << 4 // ?1000
const F_MOUSE_BUTTON = 1 << 5 // ?1002
const F_MOUSE_ANY = 1 << 6 // ?1003
const F_FOCUS = 1 << 7 // ?1004  focus in/out reporting
const F_EXT_UTF8 = 1 << 8 // ?1005  mouse coordinate encoding
const F_EXT_SGR = 1 << 9 // ?1006  mouse coordinate encoding
const F_EXT_URXVT = 1 << 10 // ?1015 mouse coordinate encoding
const F_BRACKETED = 1 << 11 // ?2004 bracketed paste
const F_SYNC = 1 << 12 // ?2026 synchronized output — tracked, NEVER emitted
const F_KEYPAD = 1 << 13 // ESC = / ESC >  application keypad

/** Modes whose power-on state is SET. A tracker starts here, and a prefix emits only what
 *  DIFFERS from here — so a session holding nothing produces no bytes at all. */
const DEFAULT_FLAGS = F_DECAWM | F_CURSOR

/** DEC private mode number -> flag. Absent numbers are consumed and ignored. */
const FLAG_BY_MODE = new Map<number, number>([
  [1, F_DECCKM],
  [6, F_DECOM],
  [7, F_DECAWM],
  [25, F_CURSOR],
  [1000, F_MOUSE_NORMAL],
  [1002, F_MOUSE_BUTTON],
  [1003, F_MOUSE_ANY],
  [1004, F_FOCUS],
  [1005, F_EXT_UTF8],
  [1006, F_EXT_SGR],
  [1015, F_EXT_URXVT],
  [2004, F_BRACKETED],
  [2026, F_SYNC]
])

/** Emission order for the flags a prefix may carry. Encoding before tracking (an app that
 *  gets coordinates in the wrong dialect misparses every click), and NO F_SYNC — see the
 *  prohibitions on modePrefix. */
const EMIT_ORDER: ReadonlyArray<readonly [number, number]> = [
  [F_DECOM, 6],
  [F_DECAWM, 7],
  [F_DECCKM, 1],
  [F_EXT_UTF8, 1005],
  [F_EXT_SGR, 1006],
  [F_EXT_URXVT, 1015],
  [F_MOUSE_NORMAL, 1000],
  [F_MOUSE_BUTTON, 1002],
  [F_MOUSE_ANY, 1003],
  [F_FOCUS, 1004],
  [F_BRACKETED, 2004],
  [F_CURSOR, 25]
]

/** Which code took the alternate screen, or 0 for the normal buffer. WHICH matters: 1049h
 *  saves the cursor and clears the alt buffer, 1047h does neither, and 1047l clears on the
 *  way out — so a synthesized enter must match what actually entered, or a surviving exit
 *  in the replayed segment pops a save point that was never pushed. */
export type AltCode = 0 | 47 | 1047 | 1049

export interface ModeState {
  flags: number
  alt: AltCode
  /** 1-based inclusive DECSTBM margins; 0/0 means "no region set" (full screen). */
  regionTop: number
  regionBottom: number
}

export const GROUND: ModeState = Object.freeze({
  flags: DEFAULT_FLAGS,
  alt: 0 as AltCode,
  regionTop: 0,
  regionBottom: 0
})

export function isGround(s: ModeState): boolean {
  return s.flags === DEFAULT_FLAGS && s.alt === 0 && s.regionTop === 0 && s.regionBottom === 0
}

// Parser states. A state MACHINE rather than a residual string, exactly as OscParser does
// it: the machine's own fields ARE the carry, so an arbitrary split is the ordinary case
// and not an edge one. That matters more here than there — the head tracker is fed the
// slices EVICTED from the ring, whose cut points are arbitrary by construction.
const S_GROUND = 0
const S_ESC = 1
const S_CSI = 2
const S_STRING = 3 // OSC/DCS/APC/PM/SOS body: skipped, never parsed
const S_STRING_ESC = 4

const ESC = 0x1b
const BEL = 0x07

/** Cap on one CSI's parameter+intermediate run. Comfortably fits the longest real
 *  sequence (`ESC[?1000;1002;1003;1004;1006;2004h` is 34); past it we stop RECORDING but
 *  keep consuming to the final byte, so the tail of an absurd sequence can never be
 *  mistaken for output. Failure mode of the bound is "we miss one mode" — today's
 *  behaviour — never unbounded growth. */
const MAX_CSI = 64

export class TerminalModeTracker {
  private flags = DEFAULT_FLAGS
  private altCode: AltCode = 0
  private top = 0
  private bottom = 0

  private state: number = S_GROUND
  private params = ''
  private overflow = false
  private seqStart = 0
  private consumed = 0
  private altAt = -1

  /** Characters consumed since construction (or the last reset) — the basis for altEnter. */
  get pos(): number {
    return this.consumed
  }

  /** Offset of the ESC that began the alt-screen enter still in force, or -1 when the alt
   *  screen is off OR was entered before this scan began (a tracker seeded from a head
   *  snapshot). Both answers mean the same thing to the composer: there is no cut point
   *  inside this segment, so nothing of it is normal-buffer history. */
  get lastAltEnterPos(): number {
    return this.altCode ? this.altAt : -1
  }

  snapshot(): ModeState {
    return { flags: this.flags, alt: this.altCode, regionTop: this.top, regionBottom: this.bottom }
  }

  /** Seed the machine. Mode state is adopted; PARSER state is always reset — a seed is a
   *  fresh scan, never a continuation of someone else's half-read sequence. */
  reset(state: ModeState = GROUND): void {
    this.flags = state.flags
    this.altCode = state.alt
    this.top = state.regionTop
    this.bottom = state.regionBottom
    this.state = S_GROUND
    this.params = ''
    this.overflow = false
    this.seqStart = 0
    this.consumed = 0
    this.altAt = -1
  }

  push(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i)
      const at = this.consumed
      this.consumed++

      switch (this.state) {
        case S_GROUND:
          if (code === ESC) {
            this.state = S_ESC
            this.seqStart = at
          }
          break

        case S_ESC:
          this.state = S_GROUND
          if (code === 0x5b) {
            // '['
            this.state = S_CSI
            this.params = ''
            this.overflow = false
          } else if (code === 0x5d || code === 0x50 || code === 0x5f || code === 0x5e || code === 0x58) {
            // ']' OSC, 'P' DCS, '_' APC, '^' PM, 'X' SOS — string-terminated. SKIPPED, not
            // parsed: ten lines that remove the whole class of an OSC payload (a clipboard
            // write, a window title) carrying the literal bytes of a mode sequence.
            this.state = S_STRING
          } else if (code === 0x63) {
            // 'c' RIS — a total reset. Apps emit it on exit, and a tracker that missed it
            // would be wrong forever after.
            this.groundAll()
          } else if (code === 0x3d) {
            this.flags |= F_KEYPAD // '=' DECKPAM
          } else if (code === 0x3e) {
            this.flags &= ~F_KEYPAD // '>' DECKPNM
          } else if (code === ESC) {
            this.state = S_ESC
            this.seqStart = at
          }
          break

        case S_CSI:
          if (code >= 0x40 && code <= 0x7e) {
            if (!this.overflow) this.dispatchCsi(code)
            this.state = S_GROUND
          } else {
            if (this.params.length >= MAX_CSI) this.overflow = true
            else this.params += chunk[i]
          }
          break

        case S_STRING:
          if (code === BEL) this.state = S_GROUND
          else if (code === ESC) this.state = S_STRING_ESC
          break

        case S_STRING_ESC:
          // ESC \ is ST. An ESC followed by anything else aborts the string (OscParser's
          // rule); re-arm on a further ESC so a split terminator cannot swallow a sequence.
          if (code === 0x5c) {
            this.state = S_GROUND
          } else if (code === ESC) {
            this.state = S_STRING_ESC
          } else {
            this.state = S_GROUND
          }
          break
      }
    }
  }

  private groundAll(): void {
    this.flags = DEFAULT_FLAGS
    this.altCode = 0
    this.altAt = -1
    this.top = 0
    this.bottom = 0
  }

  private dispatchCsi(final: number): void {
    const p = this.params
    const priv = p.charCodeAt(0) === 0x3f // '?'

    if (final === 0x68 || final === 0x6c) {
      // 'h' set / 'l' reset
      if (!priv) return // ANSI (non-private) modes: none tracked
      const set = final === 0x68
      for (const part of p.slice(1).split(';')) {
        const n = Number(part)
        if (!Number.isInteger(n)) continue
        if (n === 1049 || n === 1047 || n === 47) {
          if (set) {
            this.altCode = n as AltCode
            this.altAt = this.seqStart
          } else {
            // ANY of the three exits — xterm has one alternate buffer, so the model must
            // not pretend otherwise just because a different code let it in.
            this.altCode = 0
            this.altAt = -1
          }
          continue
        }
        const flag = FLAG_BY_MODE.get(n)
        if (flag === undefined) continue
        if (set) this.flags |= flag
        else this.flags &= ~flag
      }
      return
    }

    if (final === 0x72 && !priv) {
      // 'r' DECSTBM. The `!priv` guard is what keeps XTRESTORE (`CSI ? Pm r`) from being
      // misread as a scroll region — same final byte, unrelated meaning.
      const [a, b] = p.split(';')
      const t = Number(a)
      const bm = Number(b)
      if (p === '' || !Number.isInteger(t) || !Number.isInteger(bm) || t <= 0 || bm <= 0) {
        this.top = 0
        this.bottom = 0
      } else {
        this.top = t
        this.bottom = bm
      }
      return
    }

    if (final === 0x70 && p.indexOf('!') !== -1) {
      // 'p' with a '!' intermediate: DECSTR soft reset. Resets DECCKM/DECOM/DECAWM/DECTCEM
      // and the margins, and deliberately leaves the alternate buffer alone.
      this.flags = DEFAULT_FLAGS | (this.flags & F_SYNC)
      this.top = 0
      this.bottom = 0
    }
  }
}

/**
 * The bytes that put a terminal into `state`, assuming it starts at ground.
 *
 * THREE ABSOLUTE PROHIBITIONS, each earned:
 *
 *   Never `ESC[?1049l`. It calls restoreCursor, and with no prior DECSC — and there is
 *   none, the terminal is fresh — that homes to (0,0), so a prompt paints over row 0 of
 *   the history it was meant to follow. This is a confirmed HIGH finding in the terminal
 *   audit and it must not be re-earned. It never arises here (a prefix only ever ENTERS
 *   the alt screen, because the target is always at ground) and the emitter has no code
 *   path that could produce it.
 *
 *   Never `ESC[?2026h`. Synchronized output is a per-frame bracket, and a replay that
 *   begins inside an open frame leaves xterm holding paints — and pane-anchor refusing to
 *   re-pin — for the rest of the pane's life. F_SYNC is tracked and never emitted.
 *
 *   Never a query (`ESC[c`, `ESC[6n`, `ESC]10;?`). A replay that makes xterm write back
 *   into the pty is a replay that TYPES INTO THE RUNNING AGENT.
 *
 * `headSafe` is the cursor discipline, and it is asymmetric on purpose. A head prefix
 * precedes replayed content, so it must not move the cursor: DECSTBM homes as a side
 * effect, so the region set is wrapped in DECSC/DECRC and `ESC[m` goes AFTER the DECRC
 * (which restores SGR and would otherwise undo it — pane-shared's rule). A tail prefix is
 * followed by an erase and an explicit home, so there the homing is desired and the region
 * set is bare.
 */
export function modePrefix(state: ModeState, headSafe: boolean): string {
  let out = ''
  if (state.alt) out += `\x1b[?${state.alt}h`

  const region = state.regionTop && state.regionBottom ? `\x1b[${state.regionTop};${state.regionBottom}r` : ''
  if (region) out += headSafe ? `\x1b7${region}\x1b8` : region

  for (const [flag, mode] of EMIT_ORDER) {
    const on = (state.flags & flag) !== 0
    if (on === ((DEFAULT_FLAGS & flag) !== 0)) continue // already the power-on state
    out += `\x1b[?${mode}${on ? 'h' : 'l'}`
  }
  if ((state.flags & F_KEYPAD) !== 0) out += '\x1b='

  if (headSafe && region) out += '\x1b[m'
  return out
}

/**
 * The replay payload for a ring, given the mode state at the ring's HEAD (i.e. the state
 * left by everything already evicted from it).
 *
 * The tail state and the alt-enter offset are derived HERE, by one scan seeded from the
 * head — never passed in — so the two can never disagree about the same bytes.
 *
 *   alt session:  headPrefix + ring[0 .. altEnter) + tailPrefix + erase + home
 *   otherwise:    ring, byte-identical, unless the head held something
 *
 * SAY NOTHING WHEN THERE IS NOTHING TO SAY. A ground head on a normal-buffer session
 * returns the ring unchanged, so every ordinary shell pane — which is most panes, and
 * every pane the existing gates drive — sees not one new byte. New bytes appear only for a
 * session that actually holds modes.
 *
 * The cut is at the alt ENTER rather than at 0 because the ring's pre-alt prefix is genuine
 * normal-buffer history (the shell prompt, the launch line). xterm keeps the normal buffer
 * behind the alt buffer, so that is what the user sees when they quit the agent; dropping
 * it would trade this bug for a blank terminal on exit. When the enter has already rolled
 * off the head — the field case, and the one that produced the report — the cut is 0 and no
 * ring bytes replay at all.
 *
 * One consequence worth stating because it looks like a bug six months later: a synthesized
 * `?1049h` performs the saveCursor the live process performed hours ago and will never
 * repeat, so a later `?1049l` restores to OUR save point — just after the replayed pre-alt
 * history, or home when there is none. Both are the sensible answer.
 */
export function composeReplay(ring: string, head: ModeState): string {
  const scan = new TerminalModeTracker()
  scan.reset(head)
  scan.push(ring)
  const tail = scan.snapshot()

  if (!tail.alt) return isGround(head) ? ring : modePrefix(head, true) + ring

  const enter = scan.lastAltEnterPos
  const cut = enter >= 0 ? enter : 0
  const history = cut > 0 ? modePrefix(head, true) + ring.slice(0, cut) : ''
  return `${history}${modePrefix(tail, false)}\x1b[2J\x1b[H`
}
