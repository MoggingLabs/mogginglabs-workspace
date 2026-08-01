/** Where a pane's effective working directory came from. The distinction is behavioral:
 * an explicit agent declaration outranks passive shell/process observations until that agent
 * exits, while a shell prompt releases the declaration back to the shell. */
export type PaneCwdSource = 'spawn' | 'shell' | 'process' | 'agent'

/** Remote cwd values are display/session metadata only. They must never be probed by local Git. */
export type PaneCwdLocality = 'local' | 'remote'

/** Long-path aware, but still bounded before a path can cross IPC or an OSC fallback. */
export const PANE_CWD_MAX = 32_768

/** One comparable spelling per path, without host path APIs (renderer-safe): forward
 *  slashes, no trailing separator, case-folded ONLY for drive-lettered (Windows) paths —
 *  the explorer dock's containment rule (11/03), shared so every "is this under that"
 *  answer agrees. */
const pathKeyOf = (value: string): string => {
  const slash = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(slash) ? slash.toLowerCase() : slash
}

/**
 * `path` relative to `dir`, when it sits STRICTLY under it — what a person types into a
 * shell whose cwd is `dir` — or null when it does not (equal paths included: inserting ''
 * for "the cwd itself" would be a lie). Separator-boundary safe (`/a/bc` is not under
 * `/a/b`), case-insensitive for drive-lettered paths, and the returned slice keeps the
 * CALLER's own separators — no host path arithmetic in the renderer (ADR 0004).
 */
export function relativeToDir(path: string, dir: string): string | null {
  const d = pathKeyOf(dir)
  const p = pathKeyOf(path)
  if (!d || !p.startsWith(`${d}/`)) return null
  return path.slice(dir.length).replace(/^[\\/]+/, '')
}
