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
