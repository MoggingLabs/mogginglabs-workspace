import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, normalize, parse, sep } from 'node:path'
import { FS_DRIVE_ROOT } from '@contracts'

// ONE meaning per path, shared by every read-only listing (fs-browse's wizard
// browser, the explorer's tree — Phase-11/01 extracted these from fs-browse
// verbatim rather than fork them, so the two listings can never drift apart on
// what a path means). Pure path semantics only: no feature shapes, no Electron.

/**
 * One spelling per directory. `C:/Users/` and `C:\Users` are the same folder, and if
 * a listing echoed back whichever the user typed, the path bar and the browser would
 * disagree about where they are. Normalize separators; drop a trailing one (never
 * from a root). Deliberately NOT `realpath`: a symlinked project folder is the path
 * the user meant, and resolving it would teleport them to the link target.
 */
export function canonical(input: string): string {
  const n = normalize(input)
  const { root } = parse(n)
  return n === root ? n : n.replace(/[\\/]+$/, '')
}

/**
 * Is `child` the directory `dir` itself, or strictly beneath it? SEPARATOR-BOUNDARY safe,
 * so `/a/bc` is NOT under `/a/b` — the prefix test every naive containment guard gets
 * wrong. Case-insensitive on win32, where `C:\Users` and `c:\users` are one directory and
 * a guard that disagreed could be walked straight past.
 *
 * This is the boundary the explorer's delegation verbs (11/06) lean on: a path outside the
 * folder on screen cannot be opened by asking us nicely.
 */
export function isUnder(child: string, dir: string): boolean {
  if (!child || !dir) return false
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  const c = fold(child)
  const d = fold(dir)
  if (c === d) return true
  if (!c.startsWith(d)) return false
  if (d.endsWith('\\') || d.endsWith('/')) return true // a root like `C:\` already ends at a boundary
  const next = c[d.length]
  return next === '\\' || next === '/'
}

/**
 * Report a PHYSICALLY discovered directory (git root, traced worktree, watcher event) in the
 * namespace the caller is standing in. `anchor` is a caller-namespace path; walk its lexical
 * ancestors for one whose realpath IS `physical` — that ancestor names the same directory in
 * the caller's spelling. Falls back to `physical` when the caller's chain never crosses it.
 *
 * This is the counterpart to `canonical()`'s "the path the user typed is the path they meant"
 * rule: a repo under an aliased prefix (8.3 short path or junction on Windows, the
 * `/var -> /private/var` symlink macOS puts under every temp dir) has two spellings, and a
 * physically discovered root that keeps the OTHER spelling makes every caller-namespace
 * comparison against it false — containment guards refuse paths that are visibly inside the
 * tree, and the pane's cwd teleports to a spelling the user never typed.
 */
export function toCallerNamespace(physical: string, anchor: string): string {
  if (!physical || !anchor) return physical
  let candidate = canonical(anchor)
  for (let i = 0; i < 256; i++) {
    try {
      if (realpathSync.native(candidate) === physical) return candidate
    } catch {
      break // an unreadable ancestor cannot be verified; the physical spelling is the answer
    }
    const parent = dirname(candidate)
    if (parent === candidate) break // filesystem root
    candidate = parent
  }
  return physical
}

/** The parent of `dir`, or null when there is nowhere further up. */
export function parentOf(dir: string): string | null {
  if (dir === FS_DRIVE_ROOT) return null // the drive list IS the top
  const { root } = parse(dir)
  if (dir === root) return process.platform === 'win32' ? FS_DRIVE_ROOT : null
  const up = join(dir, '..')
  return up === dir ? null : up
}

/** How long one drive letter gets to answer. A mapped-but-DISCONNECTED network drive does not
 *  fail fast: its stat blocks for the SMB timeout — SECONDS, per dead mapping. This ran
 *  synchronously inside an IPC handler, so the main process froze: no drive list, and every
 *  IPC queued behind it stalled with it. A live drive answers in microseconds, so nothing real
 *  is lost to the cap. */
const DRIVE_PROBE_MS = 300

/** Windows drive letters that currently exist (name `C:`, path `C:\`). All 26 probed in
 *  PARALLEL, each abandoned after DRIVE_PROBE_MS: a dead mapping is left out of the list
 *  rather than allowed to hang the caller. Async for that reason alone — both listings that
 *  use it (the wizard's folder browser and the explorer's tree) already await their work. */
export async function driveRoots(): Promise<{ name: string; path: string }[]> {
  const probe = async (root: string): Promise<{ name: string; path: string } | null> => {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        stat(root),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('probe timeout')), DRIVE_PROBE_MS)
        })
      ])
      return { name: root.slice(0, 2), path: root }
    } catch {
      return null // no such drive (the overwhelmingly common case), or a mapping that never answered
    } finally {
      clearTimeout(timer)
    }
  }
  const roots: string[] = []
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) roots.push(`${String.fromCharCode(c)}:${sep}`)
  const found = await Promise.all(roots.map(probe))
  return found.filter((d): d is { name: string; path: string } => d !== null)
}
