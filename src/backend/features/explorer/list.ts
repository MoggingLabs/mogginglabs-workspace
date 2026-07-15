import { isAbsolute, join } from 'node:path'
import {
  EXPLORER_LIST_CAP,
  FS_DRIVE_ROOT,
  type ExplorerEntry,
  type ExplorerListRequest,
  type ExplorerResult
} from '@contracts'
import { canonical, driveRoots, parentOf } from '../../platform/fs-paths'
import { classifyDirent, compareNames, probeIsRepo, readDirents } from '../../platform/fs-listing'

/**
 * The explorer's read service (Phase-11/01, ADR 0010): files AND dirs, one
 * level, on demand, typed refusals. No recursive walk, no watcher, no index,
 * no file contents — and nothing here is logged (ADR 0005: a path is never
 * telemetry).
 *
 * `fs-browse` is the sibling, not the parent: `fs:listDir` stays dirs-only BY
 * CONTRACT (it picks a working folder), while this listing feeds a tree that
 * shows the files too. Path meaning (canonical form, parents, drive roots) is
 * SHARED via `platform/fs-paths`, so the two listings can never disagree about
 * where a path leads.
 *
 * Electron-free on purpose, so it is testable without booting an app.
 */

/** Async ONLY for the drive-root listing: a mapped-but-disconnected network drive blocks its
 *  stat for the SMB timeout, and probing 26 letters synchronously inside an IPC handler froze
 *  the main process (see driveRoots). Everything below is local-disk and stays synchronous. */
export async function listExplorer(req: ExplorerListRequest): Promise<ExplorerResult> {
  if (req?.path === FS_DRIVE_ROOT) {
    const path = FS_DRIVE_ROOT
    if (process.platform !== 'win32') return { ok: false, reason: 'invalid', path }
    // Drives are expandable and never repos (nobody roots a workspace at `C:\`) —
    // the fs-browse stance, kept in lockstep.
    const entries: ExplorerEntry[] = (await driveRoots()).map(({ name, path: p }) => ({ name, path: p, kind: 'dir', isRepo: false }))
    return { ok: true, path, parent: null, entries, truncated: false }
  }
  if (typeof req?.path !== 'string') return { ok: false, reason: 'invalid', path: '' }

  // `normalize('C:')` is `C:.`, which is relative — canonicalize, THEN demand absolute.
  const path = canonical(req.path)
  if (!isAbsolute(path)) return { ok: false, reason: 'invalid', path }

  // Never throws (fs-listing.ts): an unreadable folder is an ordinary thing to expand,
  // so it is a state the tree renders — not a crash and not an empty-listing lie.
  const read = readDirents(path)
  if (!read.ok) return { ok: false, reason: read.reason, path }
  const dirents = read.dirents

  // Hidden filter FIRST (dot rule, files and dirs alike — the fs-browse rationale:
  // Windows' HIDDEN attribute is not readable from `fs.Dirent`), so a hidden
  // symlink never even costs its classification stat.
  const visible = dirents
    .filter((d) => (req.showHidden ? true : !d.name.startsWith('.')))
    // A broken link is a LEAF the tree still shows (unlike fs-browse, which offers only
    // enterable folders) — an agent that wrote a dead link produced a fact worth seeing.
    .map((d) => {
      const kind = classifyDirent(path, d)
      return { name: d.name, kind: kind === 'dir' ? ('dir' as const) : ('file' as const) }
    })

  // Dirs first, then files; case-insensitive within each group. Sort, then cap,
  // THEN probe — so `truncated` is deterministic and a 10k-entry folder costs at
  // most EXPLORER_LIST_CAP repo probes, not 10k.
  const byName = (a: { name: string }, b: { name: string }): number => compareNames(a.name, b.name)
  const dirs = visible.filter((v) => v.kind === 'dir').sort(byName)
  const files = visible.filter((v) => v.kind === 'file').sort(byName)
  const ordered = [...dirs, ...files]

  const truncated = ordered.length > EXPLORER_LIST_CAP
  const entries: ExplorerEntry[] = ordered.slice(0, EXPLORER_LIST_CAP).map(({ name, kind }) => {
    const child = join(path, name)
    if (kind === 'file') return { name, path: child, kind }
    return { name, path: child, kind, isRepo: probeIsRepo(child) }
  })

  return { ok: true, path, parent: parentOf(path), entries, truncated }
}
