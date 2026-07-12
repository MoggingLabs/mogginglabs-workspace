// Minimal agent "resume" mapping (Phase-1/03, step 4): on restore we relaunch an agent via its
// own resume flow rather than trying to freeze/thaw a live process. Full per-CLI adapters land
// in step 06 (the agent launcher); this covers the CLIs that have a real resume today. A pane
// with no known-resumable agent simply restores as a fresh shell at its cwd.
const RESUME: Record<string, string> = {
  claude: 'claude --resume',
  codex: 'codex resume'
}

/** The resume command for a persisted launch command, or null if the pane should restore as a
 *  fresh shell (no safe resume). Matches on the first token of the command. */
export function resumeCommandFor(command?: string): string | null {
  if (!command) return null
  const first = command.trim().split(/\s+/)[0]?.toLowerCase()
  // hasOwn guard: a plain-object lookup with a hostile first token ('constructor',
  // 'toString', …) hits Object.prototype and returns a FUNCTION where a string is
  // expected — which the restore path would happily type into the shell.
  return (first && Object.hasOwn(RESUME, first) && RESUME[first]) || null
}
