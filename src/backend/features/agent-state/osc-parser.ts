import type { AgentState } from '@contracts'

// Incremental scanner for OSC (Operating System Command) sequences on a raw PTY stream. An OSC
// starts with ESC ] and ends with BEL (0x07) or ST (ESC \).
//
//   OSC 9 ; <text>            notification               -> "attention"  (see `case 9` — 9;9
//                             and 9;4 wear the same code and are NOT notifications)
//   OSC 9 ; 9 ; path          current working directory  (ConEmu/Windows-Terminal form: how
//                             cmd.exe reports its cwd through ConPTY)
//   OSC 9 ; 4 ; state ; pct   taskbar progress           (the pane is WORKING, not blocked)
//   OSC 99 / 777;notify       notifications              -> "attention"
//   OSC 133 ; A               prompt start                            (mark, for command blocks)
//   OSC 133 ; B               command line start                      (mark, for command blocks)
//   OSC 133 ; C               command execution start    -> "busy"    (mark)
//   OSC 133 ; D[;exit]        command end (+ exit code)  -> "idle"    (mark)
//   OSC 7  ; file://host/path current working directory
//
// Phase-2 hardening: a proper byte state machine that carries `inOsc`, the body `buf`, AND a
// `pendingEsc` flag across chunk boundaries — so a sequence split anywhere (including exactly on
// the ESC of `ESC ]` or the ESC of the `ESC \` terminator) is parsed correctly, not dropped. Not
// every CLI emits OSC, so state is paired with an output-quiescence heuristic elsewhere.

/** A decoded OSC event of interest (backend-internal detail, not on the wire). */
export interface OscEvent {
  kind: 'notify' | 'prompt' | 'cmd-line' | 'cmd-start' | 'cmd-end' | 'cwd' | 'bell'
  code: number
  payload?: string
  exitCode?: number
}

/**
 * Convert an OSC cwd payload to a local filesystem path (used for per-pane cwd tracking).
 * Accepts BOTH forms a shell can report: the OSC 7 `file://host/path` URI (bash/zsh, and the
 * cmd.exe prompt we inject), and the bare absolute path OSC 9;9 carries (the ConEmu/Windows-
 * Terminal form). Returns null when it is neither. Handles Windows drive paths
 * (`file://host/C:/x` -> `C:/x`) and percent-encoding. Pure — no Node/Electron deps, so both
 * the in-proc PtyService and the daemon can share it.
 */
export function fileUriToPath(uri: string): string | null {
  const raw = uri.trim()
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(raw)
  if (!m) {
    // OSC 9;9 reports the path itself, not a URI. Absolute paths only — a relative one
    // names nothing we can resolve, and a shell never reports one.
    return /^([a-zA-Z]:[\\/]|[\\/])/.test(raw) ? raw : null
  }
  let p: string
  try {
    p = decodeURIComponent(m[1])
  } catch {
    p = m[1]
  }
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1) // "/C:/Users/x" -> "C:/Users/x"
  return p || null
}

const ESC = 0x1b
const BEL = 0x07
const ST_TAIL = 0x5c // '\', the second byte of ST (ESC \)
const OSC_INTRO = 0x5d // ']'
const MAX_OSC = 4096

export class OscParser {
  private buf = ''
  private inOsc = false
  private discarding = false // an OSC body blew past MAX_OSC; swallow until its real terminator
  private pendingEsc = false // saw an ESC as the last byte; its meaning depends on the NEXT byte

  constructor(
    private readonly onState: (state: AgentState) => void,
    private readonly onEvent?: (event: OscEvent) => void
  ) {}

  push(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i)

      if (this.pendingEsc) {
        this.pendingEsc = false
        if (this.inOsc || this.discarding) {
          if (code === ST_TAIL) {
            if (this.inOsc) this.flush() // ESC \ = ST terminator (an overflowed body just ends)
            this.inOsc = false
            this.discarding = false
            continue
          }
          // ESC not followed by '\' inside an OSC terminates it (discard); re-arm on ESC.
          this.inOsc = false
          this.discarding = false
          this.buf = ''
          if (code === ESC) this.pendingEsc = true
          continue
        }
        if (code === OSC_INTRO) {
          this.inOsc = true // ESC ] = OSC start
          this.buf = ''
        } else if (code === ESC) {
          this.pendingEsc = true
        }
        continue
      }

      if (code === ESC) {
        this.pendingEsc = true
        continue
      }
      if (this.discarding) {
        // Oversized OSC (vim/tmux OSC 52 clipboard >4KB): the body is dropped, but its
        // BEL terminator is still THIS sequence's, not the terminal bell — swallowing
        // it here is what keeps a big clipboard write from ringing a false attention.
        if (code === BEL) this.discarding = false
        continue
      }
      if (!this.inOsc) {
        // A BEL OUTSIDE any OSC is the terminal bell — the pane ringing for a human
        // (Claude Code's terminal_bell notify, a TUI's alert). An OSC-terminating
        // BEL lands in the branch below instead and never reports as a bell.
        if (code === BEL) this.onEvent?.({ kind: 'bell', code: BEL })
        continue
      }
      if (code === BEL) {
        this.flush()
        this.inOsc = false
        continue
      }

      this.buf += data[i]
      if (this.buf.length > MAX_OSC) {
        // Too big to be one of ours — but dropping to ground here would let the
        // sequence's real terminator scan as output. Discard until it arrives.
        this.inOsc = false
        this.discarding = true
        this.buf = ''
      }
    }
  }

  private flush(): void {
    const s = this.buf
    const sep = s.indexOf(';')
    const code = parseInt(sep === -1 ? s : s.slice(0, sep), 10)
    const rest = sep === -1 ? '' : s.slice(sep + 1)
    if (Number.isNaN(code)) return

    switch (code) {
      case 9:
        // OSC 9 is OVERLOADED on Windows: three different things wear the same code, and only
        // ONE of them means a human is needed. Both of the others reached this branch once and
        // both lit the dot for nothing — so both are checked BEFORE we ring anything.
        //
        //   9 ; 9 ; <path>           a CWD report (ConEmu/Windows Terminal). It is how cmd.exe
        //                            tells us where it is through ConPTY (shellIntegrationEnv).
        //                            Ringing on it lit the attention dot at every prompt.
        //   9 ; 4 ; <state> ; <pct>  the taskbar PROGRESS report (Windows Terminal, ConPTY, and
        //                            half the build tools — cargo, npm, pip, winget). Reading a
        //                            progress tick as "this pane needs a human" turned a pane RED
        //                            for the crime of running a build with a progress bar, and
        //                            latched it there. Progress means the pane is WORKING, which
        //                            output activity already says.
        //   9 ; <text>               the actual ConEmu/iTerm2 desktop notification.
        if (rest.startsWith('9;')) {
          this.onEvent?.({ kind: 'cwd', code, payload: rest.slice(2) })
          break
        }
        if (/^4(;|$)/.test(rest)) break
        this.onState('attention')
        this.onEvent?.({ kind: 'notify', code, payload: rest })
        break
      case 777:
        // `OSC 777 ; notify ; <title> ; <body>` (rxvt/urxvt). 777 carries OTHER
        // subcommands too (precmd, preexec, …) which say nothing about needing a human.
        // Only the notify subcommand is a notification.
        if (!/^notify(;|$)/.test(rest)) break
        this.onState('attention')
        this.onEvent?.({ kind: 'notify', code, payload: rest })
        break
      case 99:
        this.onState('attention')
        this.onEvent?.({ kind: 'notify', code, payload: rest })
        break
      case 133: {
        const mark = rest[0]
        if (mark === 'A') {
          this.onEvent?.({ kind: 'prompt', code })
        } else if (mark === 'B') {
          this.onEvent?.({ kind: 'cmd-line', code })
        } else if (mark === 'C') {
          this.onState('busy')
          this.onEvent?.({ kind: 'cmd-start', code })
        } else if (mark === 'D') {
          const ex = parseInt(rest.split(';')[1] ?? '', 10)
          this.onState('idle')
          this.onEvent?.({ kind: 'cmd-end', code, exitCode: Number.isNaN(ex) ? undefined : ex })
        }
        break
      }
      case 7:
        this.onEvent?.({ kind: 'cwd', code, payload: rest })
        break
      default:
        break
    }
  }
}
