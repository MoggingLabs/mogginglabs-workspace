/**
 * The wizard's `cd` line: shell-muscle-memory folder navigation. The user types
 * `cd ../other-project` under the folder bar and lands there — the reference
 * design's terminal-flavored picker. The line accepts ONLY `cd` (and `chdir`) —
 * a bare path or any other command is refused with a hint, never guessed at:
 * the path BAR above is where raw paths go, and a line that "helpfully" ran
 * whatever it was handed taught people it was a terminal, which it is not.
 *
 * Pure string math (the renderer has no node:path): resolves against the
 * CURRENT folder, falling back to the user's home when nothing is chosen yet,
 * and normalizes `.`/`..` segments. The result still goes through the selection
 * controller's real filesystem probe — this only computes WHERE to look, never
 * whether it exists.
 */

const WINDOWS_ABS = /^[A-Za-z]:[\\/]/
const DRIVE_ONLY = /^[A-Za-z]:$/
const UNC = /^\\\\/

/** Strip one layer of quoting — `cd "C:\My Repos"` is muscle memory too. A quote
 *  still being typed (`cd "My Re`) loses only its opening mark. */
export const unquote = (value: string): string => {
  const trimmed = value.trim()
  const first = trimmed[0]
  if (first !== '"' && first !== "'") return trimmed
  return trimmed.length > 1 && trimmed.endsWith(first) ? trimmed.slice(1, -1) : trimmed.slice(1)
}

/** Join + normalize `.`/`..` against a base, keeping the base's separator dialect.
 *  The base's own segments run through the same `.`/`..` folding — a typed absolute
 *  like `C:\a\..\b` arrives here as a base with an empty relative, and must leave
 *  normalized. */
function normalizeAgainst(base: string, relative: string): string {
  const windows = WINDOWS_ABS.test(base) || UNC.test(base)
  const sep = windows ? '\\' : '/'
  const stack: string[] = []
  for (const segment of [...base.replace(WINDOWS_ABS, '').split(/[\\/]+/), ...relative.split(/[\\/]+/)]) {
    if (!segment || segment === '.') continue
    if (segment === '..') stack.pop()
    else stack.push(segment)
  }
  // Three roots, three spellings: a drive keeps its letter, a UNC path keeps its
  // double slash (slicing `\\server` like a drive minted `\\\server`), and POSIX
  // is just `/`.
  const root = UNC.test(base)
    ? '\\\\'
    : windows
      ? (base.match(WINDOWS_ABS)?.[0] ?? base.slice(0, 3)).slice(0, 2) + sep
      : '/'
  return root + stack.join(sep)
}

export type CdParse =
  | { kind: 'empty' }
  /** Not a cd command. `word` is what they typed instead — for the refusal hint. */
  | { kind: 'not-cd'; word: string }
  /** A cd command. `arg` is everything after the verb (may be ''); `argStart` is
   *  the index in the ORIGINAL input where that arg begins — completion rewrites
   *  the input from there. */
  | { kind: 'cd'; arg: string; argStart: number }

/**
 * Recognize the command, not just the letters: `cd`, `chdir`, case-insensitive,
 * followed by whitespace or end — plus the cmd.exe no-space spellings burned
 * into hands (`cd..`, `cd.`, `cd\`, `cd/`, `cd~`).
 */
export function parseCdLine(input: string): CdParse {
  if (!input.trim()) return { kind: 'empty' }
  const lead = input.length - input.trimStart().length
  const verb = /^(cd|chdir)(?=$|[\s.\\/~])/i.exec(input.slice(lead))
  if (!verb) {
    const word = input.trim().split(/\s+/)[0] ?? ''
    return { kind: 'not-cd', word }
  }
  const afterVerb = lead + verb[0].length
  const rest = input.slice(afterVerb)
  const pad = rest.length - rest.trimStart().length
  return { kind: 'cd', arg: rest.trim(), argStart: afterVerb + pad }
}

/**
 * The path math alone: what `value` means against `base` (falling back to `home`).
 * Shared by the resolver below and by completion (which resolves the DIRECTORY
 * part of a half-typed argument). Null when there is nothing to resolve against.
 */
export function resolvePathAgainst(value: string, base: string, home: string): string | null {
  if (!value || value === '~') return home || null
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return home ? normalizeAgainst(home, value.slice(2)) : null
  }
  // `cd C:` means the drive itself here (cmd's per-drive cwd has no twin in a picker).
  if (DRIVE_ONLY.test(value)) return value + '\\'
  if (WINDOWS_ABS.test(value) || UNC.test(value)) return normalizeAgainst(value, '')
  if (value.startsWith('/') || value.startsWith('\\')) {
    // A POSIX-absolute path only means something against a POSIX base (remote cwd,
    // mac/linux). Against a Windows base it is almost always a slip — resolve it
    // against the base's DRIVE so `cd /repos` lands on C:\repos, the cmd meaning.
    const windowsBase = WINDOWS_ABS.test(base) || UNC.test(base)
    return windowsBase ? normalizeAgainst(base.slice(0, 3), value) : normalizeAgainst('/', value)
  }
  const effectiveBase = base.trim() || home
  if (!effectiveBase) return null
  return normalizeAgainst(effectiveBase, value)
}

/** cmd's `cd /d D:\repos` — the drive-switch flag is muscle memory, not a path.
 *  Only the with-argument form is stripped, so `cd /dev` stays a real path. */
export const stripCdFlags = (arg: string): string => arg.replace(/^\/d\s+/i, '')

export type CdResolution =
  | { ok: true; target: string }
  | { ok: false; reason: 'empty' | 'not-cd' | 'no-home' | 'no-previous' }

/**
 * Resolve a cd line to the folder it means. Only `cd`/`chdir` resolve — anything
 * else comes back `not-cd` so the caller can say so instead of navigating.
 * Accepts `cd <path>`, quotes, `~`, `-` (the folder the last cd left), absolute
 * and relative forms, and a bare `cd` (home, as a shell would).
 */
export function resolveCdTarget(input: string, base: string, home: string, previous = ''): CdResolution {
  const parsed = parseCdLine(input)
  if (parsed.kind === 'empty') return { ok: false, reason: 'empty' }
  if (parsed.kind === 'not-cd') return { ok: false, reason: 'not-cd' }
  const value = unquote(stripCdFlags(parsed.arg))
  if (value === '-') {
    return previous ? { ok: true, target: previous } : { ok: false, reason: 'no-previous' }
  }
  const target = resolvePathAgainst(value, base, home)
  return target ? { ok: true, target } : { ok: false, reason: 'no-home' }
}
