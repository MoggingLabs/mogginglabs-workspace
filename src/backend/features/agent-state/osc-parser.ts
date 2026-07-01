import type { AgentState } from '@contracts'

// Incremental scanner for OSC (Operating System Command) sequences on a raw PTY
// stream. An OSC starts with ESC ] and ends with BEL (0x07) or ST (ESC \).
//
//   OSC 9 / 99 / 777          notifications              -> "attention"
//   OSC 133 ; C               command start              -> "busy"
//   OSC 133 ; D[;exit]        command end (+ exit code)  -> "idle"
//   OSC 7  ; file://host/path current working directory
//
// Phase-0 scope: detects sequences fully contained in a chunk. Sequences split
// exactly on a chunk boundary are dropped (rare; hardened in Phase 2 with a carry
// buffer). Not every CLI emits OSC, so pair with an output-quiescence heuristic.

/** A decoded OSC event of interest (backend-internal detail, not on the wire). */
export interface OscEvent {
  kind: 'notify' | 'cmd-start' | 'cmd-end' | 'cwd'
  code: number
  payload?: string
  exitCode?: number
}

const ESC = 0x1b
const BEL = 0x07
const ST_TAIL = 0x5c // '\', the second byte of ST (ESC \)
const OSC_INTRO = 0x5d // ']'
const MAX_OSC = 4096

export class OscParser {
  private buf = ''
  private inOsc = false

  constructor(
    private readonly onState: (state: AgentState) => void,
    private readonly onEvent?: (event: OscEvent) => void
  ) {}

  push(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i)

      if (!this.inOsc) {
        if (code === ESC && data.charCodeAt(i + 1) === OSC_INTRO) {
          this.inOsc = true
          this.buf = ''
          i++ // consume ']'
        }
        continue
      }

      if (code === BEL) {
        this.flush()
        this.inOsc = false
        continue
      }
      if (code === ESC && data.charCodeAt(i + 1) === ST_TAIL) {
        this.flush()
        this.inOsc = false
        i++ // consume '\'
        continue
      }

      this.buf += data[i]
      if (this.buf.length > MAX_OSC) {
        this.inOsc = false
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
      case 99:
      case 777:
        this.onState('attention')
        this.onEvent?.({ kind: 'notify', code, payload: rest })
        break
      case 133: {
        const mark = rest[0]
        if (mark === 'C') {
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
