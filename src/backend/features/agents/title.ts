// The pane-title layer: make every launched agent CLI SAY WHAT IT IS DOING through the
// one channel the pane header already reads — the OSC 0/2 window title (terminal-pane.ts
// renders `oscTitle || label || "Terminal N"`). The rule is ADR-0002-shaped: the app never
// invents a title; it only turns on each CLI's OWN self-description, so the words in the
// header are always the agent's own knowledge of its work. Dev-verified against the
// installed CLIs on this machine, 2026-07-16:
//
//   - Claude Code 2.1.211  titles itself by DEFAULT: auto-generated topic titles
//                          ("✳/✶/✻ <task>") via OSC, refreshed as the conversation moves.
//                          Opt-outs stay the user's (CLAUDE_CODE_DISABLE_TERMINAL_TITLE,
//                          `terminalTitleFromRename`). Nothing to inject.
//   - Codex 0.144.1        renders `[tui].terminal_title` items into the window title;
//                          UNSET it defaults to `activity` + `project` — status + folder,
//                          never the goal. `thread-title` is Codex's own auto-generated
//                          session title, so codexTitleArgs below pins exactly that.
//   - Gemini CLI 0.50.0    `ui.dynamicWindowTitle` (default ON) writes status icons; the
//                          goal words need `ui.showStatusInTitle` (default OFF), which
//                          puts the model's live thought subject in the title while it
//                          works. Both ride the generated system-settings file — see
//                          geminiSystemSettings (notify-hook.ts), the one builder of that
//                          file.
//   - OpenCode 1.17.18     titles `OC | <session title>` by DEFAULT (its own generated
//                          session title, 40-char cap; OPENCODE_DISABLE_TERMINAL_TITLE is
//                          the user's opt-out). Nothing to inject; the pane strips the
//                          brand prefix (the provider chip already says WHO).
//   - Aider 0.86.2         emits NO title anywhere in its source (verified: zero OSC 0/2
//                          write sites). There is nothing of its own to build on, so an
//                          aider pane honestly keeps its identity label instead of a
//                          made-up goal.
//
// Launch-scoped like the bell layer next door: injected per launch, never written into
// the user's own config files. A hand-typed CLI keeps its provider defaults (claude and
// opencode still title themselves; codex/gemini fall back to their stock status titles).

/** Codex: the most goal-shaped title its items can render — LIVE-TESTED 2026-07-16
 *  against 0.144.1 with real turns, because the item names promise more than they do:
 *
 *    - `thread-title`  renders the thread's raw UUID until the thread is NAMED, and
 *                      0.144.1 never auto-names locally (a completed turn still showed
 *                      the UUID 150s later; rollouts carry no title field). Kept for
 *                      the day codex ships auto-titling — the pane's normalizer excises
 *                      UUID tokens so a header never wears one.
 *    - `last-message`  is a status_line item only — `codex doctor` rejects it for
 *                      terminal_title (and codex then writes NO title at all).
 *    - `task-progress` renders "Tasks N/M" while a plan runs — live progress, no words.
 *    - `activity`      spins while working and says so in words when blocked on the user.
 *
 *  So: activity + thread-title + task-progress. Working reads as progress, blocked reads
 *  as the action-required words, and empty renders fall back to the provider label —
 *  never a blank header. The default (`activity` + `project`) is deliberately replaced:
 *  `project` repeats the cwd/branch chips as plain text the suffix-strip cannot see.
 *
 *  Quoting: same TOML-literal trick as codexBellArgs (notify-hook.ts) — single quotes
 *  need no escaping through cmd.exe/sh/PowerShell, and the spaces inside the array make
 *  buildLaunchCommand double-quote the whole arg. Ordered BEFORE the provider-settings
 *  overlay args in main/agents.ts, so a user who pins their own terminal_title through
 *  the app's provider settings still wins (codex takes the LAST -c for a repeated key —
 *  live-verified via `codex doctor`). */
export function codexTitleArgs(): string[] {
  return ['-c', "tui.terminal_title=[ 'activity', 'thread-title', 'task-progress' ]"]
}
