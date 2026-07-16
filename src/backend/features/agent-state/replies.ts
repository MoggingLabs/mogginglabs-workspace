// Terminal AUTO-REPLIES vs human input. xterm answers queries embedded in the output
// stream by itself — cursor-position reports (CPR), device attributes (DA), status
// reports, focus in/out, color-query and DCS replies — and those answers ride the SAME
// renderer->pty write channel as keystrokes. A reattach replays scrollback, xterm
// re-answers every query in it, and an unfiltered input path then treats that as "the
// user typed": the attention latch clears (a red pane silently goes yellow across a
// renderer reload) and a pristine restore reads as touched. Found live 2026-07-10 by
// the reload-sync probe.

/** True when a renderer->pty chunk consists ONLY of terminal auto-replies — nothing a
 *  human can type. Such a chunk must clear neither the attention latch nor a restore's
 *  pristine flag. Anything with a single unrecognized byte (typing, paste, arrow keys,
 *  ^C, mouse reports — user actions all) counts as real input. */
export function isTerminalReply(data: string): boolean {
  if (!data) return false
  // Each pattern strips one leading reply; bail the moment something else leads.
  // Finals are RESPONSE finals only — cursor keys (CSI A-D), F-keys (CSI ~ / SS3)
  // and mouse reports (CSI M / CSI < ... M|m) deliberately do NOT match. The set is
  // xterm.js's EXACT emission repertoire (InputHandler triggerDataEvent sites) — a
  // reply it can send that isn't matched here reads as typing and falsely clears the
  // attention latch (found live 2026-07-10: DA2 + DECRPM turned a permission-blocked
  // pane's red dot green).
  const REPLIES = [
    // Known collision, accepted: a MODIFIED F3 (xterm keeps VT100's PF3 legacy, so
    // Shift/Ctrl/Alt+F3 is CSI 1;<mod> R — plain F3 is SS3 R and doesn't match) is
    // byte-identical to a CPR with the cursor on row 1. There is no stateless rule
    // that splits them — a real CPR can be `1;2R` too — so modified-F3 fails to clear
    // the latch. Any other key (or plain F3) still clears it; disambiguating for real
    // would mean tracking outstanding DSR queries in the output stream.
    /^\x1b\[[?>]?[0-9;]*[Rcn]/, // CPR (CSI r;c R), DA1 (CSI ? ... c), DA2 (CSI > ... c), DSR-ok (CSI 0 n)
    /^\x1b\[\??[0-9;]*\$y/, // DECRPM — DECRQM mode report (CSI ? Ps ; Pm $ y, ANSI form without ?)
    /^\x1b\[[0-9;]*t/, // window-ops report (CSI 8 ; rows ; cols t ...)
    /^\x1b\[[IO]/, // focus in / focus out (mode 1004)
    /^\x1b\][0-9]+;[^\x07\x1b]*(\x07|\x1b\\)/, // OSC query reply (10/11 color, ...)
    /^\x1bP[^\x1b]*\x1b\\/ // DCS reply (DECRQSS / XTGETTCAP)
  ]
  let rest = data
  outer: while (rest) {
    for (const re of REPLIES) {
      const m = re.exec(rest)
      if (m) {
        rest = rest.slice(m[0].length)
        continue outer
      }
    }
    return false
  }
  return true
}

/**
 * True when a renderer->pty chunk carries a SUBMITTED line — the user pressed Enter.
 *
 * One of the two things that may clear an attention latch (the other is isEngagedInput below —
 * a printable key fed to the blocked program). `input()` used to clear it on any keystroke at
 * all, which claimed "working" about a pane whose agent was still blocked: an arrow key, a ^C,
 * a stray navigation byte each turned the red dot green while nothing had been answered — and
 * nothing ever corrected it, because a CLI does not re-raise a needs-input it has already
 * raised. A red that lingers one beat too long SELF-HEALS on the agent's next verdict; a false
 * "working" does not heal at all. So the latch ignores navigation and signals, and believes
 * content.
 *
 * SHIFT+ENTER is deliberately not a submit — it opens a new line inside a prompt the user is
 * still composing (explicit direction). Requiring a BARE CR/LF excludes it for free, and the
 * rule is right in BOTH worlds: where a terminal can encode Shift+Enter at all it arrives
 * ESC-prefixed (ESC-CR, or a CSI-u sequence under the kitty / modifyOtherKeys protocols), so it
 * fails this test; and where the terminal CANNOT encode it, neither can the agent — the
 * keystroke really does submit, and counting it is then exactly correct.
 *
 * Bracketed paste (ESC [ 200 ~ ...) fails the test for the same reason, and should: pasting
 * text into a prompt is composing, not answering. An UNbracketed paste carrying a newline does
 * count — without bracketing, that newline genuinely submits.
 *
 * Distinct from `countSubmittedLines` (agent-proc), which counts ANY CR/LF including the one
 * inside an ESC-CR. That is right for the cwd detector — a pasted script really does start
 * commands — and wrong here, where the question is whether a human answered a blocked agent.
 */
export function isSubmittedInput(data: string): boolean {
  if (!data) return false
  // An ESC-introduced chunk is a SEQUENCE, never a bare Enter: Shift+Enter, arrows, function
  // keys, bracketed paste. Enter alone is a bare CR.
  if (data.startsWith('\x1b')) return false
  return data.includes('\r') || data.includes('\n')
}

/**
 * True when a renderer->pty chunk carries at least one PRINTABLE key — a byte the pane's
 * foreground program consumes as CONTENT, as opposed to navigation or a signal.
 *
 * This is the other half of what may clear an attention latch (activity.ts input()). Submit-only
 * left the most common answer in the product stuck red: every CLI's permission dialog takes
 * single-key answers — Claude Code's digit menu applies `1`/`2`/`3` instantly, Codex and Gemini
 * take `y`/`n` — which submit no line, fire no hook (nothing runs at approval time), and are
 * never followed by a re-raise. The human answered, the agent went back to work, and the pane
 * wore "blocked on you" for the rest of the turn. A digit IS the whole answer; refusing to
 * believe anything but Enter was the lie.
 *
 * What still never counts: an ESC-introduced chunk (arrows, F-keys, mouse reports, focus
 * events, bracketed paste, kitty/CSI-u encodings — sequences all) and bare control bytes (^C,
 * Tab, Backspace, and Enter itself, which isSubmittedInput owns). Those are the exact bytes
 * that made any-keystroke clearing a lie factory, and they stay excluded.
 *
 * Terminal auto-replies never reach this test — both PTY backends filter isTerminalReply first.
 */
export function isEngagedInput(data: string): boolean {
  if (!data || data.charCodeAt(0) === 0x1b) return false
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i)
    if (c >= 0x20 && c !== 0x7f) return true
  }
  return false
}
