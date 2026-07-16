/**
 * The wizard's `cd` line: shell-muscle-memory folder navigation. The user types
 * `cd ../other-project` (or just a path) under the folder bar and lands there —
 * the reference design's terminal-flavored picker. Pure string math (the renderer
 * has no node:path): resolves against the CURRENT folder, falling back to the
 * user's home when nothing is chosen yet, and normalizes `.`/`..` segments. The
 * result still goes through the selection controller's real filesystem probe —
 * this only computes WHERE to look, never whether it exists.
 */

const WINDOWS_ABS = /^[A-Za-z]:[\\/]/
const UNC = /^\\\\/

/** Strip one layer of quoting — `cd "C:\My Repos"` is muscle memory too. */
const unquote = (value: string): string => {
  const trimmed = value.trim()
  const first = trimmed[0]
  return (first === '"' || first === "'") && trimmed.endsWith(first) ? trimmed.slice(1, -1) : trimmed
}

/** Join + normalize `.`/`..` against a base, keeping the base's separator dialect. */
function normalizeAgainst(base: string, relative: string): string {
  const windows = WINDOWS_ABS.test(base) || UNC.test(base)
  const sep = windows ? '\\' : '/'
  const rootMatch = windows ? (base.match(WINDOWS_ABS)?.[0] ?? base.slice(0, 3)) : '/'
  const stack = base
    .replace(WINDOWS_ABS, '')
    .split(/[\\/]+/)
    .filter(Boolean)
  for (const segment of relative.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') stack.pop()
    else stack.push(segment)
  }
  const root = windows ? rootMatch.slice(0, 2) + sep : '/'
  return root + stack.join(sep)
}

/**
 * Resolve a `cd` line to the folder it means. `null` when there is nothing to do
 * (empty input, or a bare `cd` — a shell would go home, so we do too via `home`).
 * Accepts `cd <path>`, a bare path, quotes, `~`, absolute and relative forms.
 */
export function resolveCdTarget(input: string, base: string, home: string): string | null {
  let value = input.trim()
  if (!value) return null
  if (/^cd(\s|$)/i.test(value)) value = value.slice(2).trim()
  value = unquote(value)
  if (!value || value === '~') return home || null
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return home ? normalizeAgainst(home, value.slice(2)) : null
  }
  if (WINDOWS_ABS.test(value) || UNC.test(value)) return value
  if (value.startsWith('/')) {
    // A POSIX-absolute path only means something against a POSIX base (remote cwd,
    // mac/linux). Against a Windows base it is almost always a slip — resolve it
    // against the base's DRIVE so `cd /repos` lands on C:\repos, the cmd meaning.
    const windowsBase = WINDOWS_ABS.test(base) || UNC.test(base)
    return windowsBase ? normalizeAgainst(base.slice(0, 3), value) : value
  }
  const effectiveBase = base.trim() || home
  if (!effectiveBase) return null
  return normalizeAgainst(effectiveBase, value)
}
