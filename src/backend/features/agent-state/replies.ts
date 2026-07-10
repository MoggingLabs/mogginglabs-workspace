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
  // and mouse reports (CSI M / CSI < ... M|m) deliberately do NOT match.
  const REPLIES = [
    /^\x1b\[\??[0-9;]*[Rcn]/, // CPR (CSI r;c R), DA1/DA2 (CSI ? ... c), DSR-ok (CSI 0 n)
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
