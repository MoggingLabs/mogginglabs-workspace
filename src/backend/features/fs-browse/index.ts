import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { isAbsolute, join, parse, sep } from 'node:path'
import { FS_DRIVE_ROOT, FS_LIST_CAP, type DirCrumb, type DirEntry, type DirResult, type ListDirRequest } from '@contracts'
import { canonical, driveRoots, parentOf } from '../../platform/fs-paths'

/**
 * Read-only one-level directory listing for the wizard's folder browser (8.5/03).
 *
 * SCOPE, and it is the whole thing: directory NAMES, one level, on demand. No
 * recursive walk, no watcher, no index, no file contents. Nothing here is logged
 * (ADR 0005 — a path is never telemetry).
 *
 * ALL per-OS path semantics live here, not in `@ui`: the renderer is handed the
 * absolute `path` of every child and a ready-made breadcrumb trail, so it joins
 * nothing and splits nothing (ADR 0004). That is also the only way Windows drive
 * roots are representable — the virtual parent of `C:\` is `FS_DRIVE_ROOT`, whose
 * listing is the drive letters.
 *
 * Path meaning (canonical form, parents, drive roots) is shared with the explorer
 * via `platform/fs-paths` (Phase-11/01 extracted it from here, verbatim).
 *
 * Electron-free on purpose, so it is testable without booting an app.
 */

/** Windows drives as pickable entries. Never repos: nobody roots a workspace at `C:\`. */
function listDrives(): DirEntry[] {
  return driveRoots().map(({ name, path }) => ({ name, path, isRepo: false }))
}

/**
 * Breadcrumbs for an absolute path, each segment carrying the path that reaches it.
 *   `C:\Projects\api` -> This PC · C: · Projects · api
 *   `/srv/api`       -> / · srv · api
 */
function crumbsFor(dir: string): DirCrumb[] {
  if (dir === FS_DRIVE_ROOT) return [{ label: 'This PC', path: FS_DRIVE_ROOT }]
  const { root } = parse(dir)
  const crumbs: DirCrumb[] = []
  if (process.platform === 'win32') crumbs.push({ label: 'This PC', path: FS_DRIVE_ROOT })
  crumbs.push({ label: root === sep ? sep : root.replace(/[\\/]+$/, ''), path: root })

  let acc = root
  for (const seg of dir.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    acc = join(acc, seg)
    crumbs.push({ label: seg, path: acc })
  }
  return crumbs
}

/**
 * A directory we should offer? `Dirent.isDirectory()` is FALSE for a junction or
 * symlink that points at one — and developers symlink project folders — so follow
 * links with a guarded stat. A dead link throws; we skip it rather than listing a
 * folder that cannot be entered.
 */
function isDir(dir: string, d: Dirent): boolean {
  if (d.isDirectory()) return true
  if (!d.isSymbolicLink()) return false
  try {
    return statSync(join(dir, d.name)).isDirectory()
  } catch {
    return false
  }
}

export function listDir(req: ListDirRequest): DirResult {
  if (req?.path === FS_DRIVE_ROOT) {
    const path = FS_DRIVE_ROOT
    if (process.platform !== 'win32') return { ok: false, reason: 'invalid', path }
    return { ok: true, path, parent: null, crumbs: crumbsFor(path), entries: listDrives(), truncated: false }
  }
  if (typeof req?.path !== 'string') return { ok: false, reason: 'invalid', path: '' }

  // `normalize('C:')` is `C:.`, which is relative — canonicalize, THEN demand absolute.
  const path = canonical(req.path)
  if (!isAbsolute(path)) return { ok: false, reason: 'invalid', path }

  let dirents: Dirent[]
  try {
    dirents = readdirSync(path, { withFileTypes: true })
  } catch (e) {
    // Never throws. An unreadable folder is an ordinary thing to click on, so it is
    // a state the browser renders — not a crash and not an empty listing (which
    // would be a lie: "this folder has nothing in it").
    const code = (e as NodeJS.ErrnoException).code
    const reason = code === 'EACCES' || code === 'EPERM' ? 'denied' : code === 'ENOTDIR' ? 'not-a-directory' : 'missing'
    return { ok: false, reason, path }
  }

  const names = dirents
    .filter((d) => isDir(path, d))
    .map((d) => d.name)
    .filter((n) => (req.showHidden ? true : !n.startsWith('.')))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }))

  // Sort, then cap, THEN probe: a 10k-entry folder costs 500 stats, not 10k. (Capping
  // before sorting would make `truncated` return an arbitrary slice.)
  const truncated = names.length > FS_LIST_CAP
  const entries: DirEntry[] = names.slice(0, FS_LIST_CAP).map((name) => {
    const child = join(path, name)
    let isRepo = false
    try {
      isRepo = existsSync(join(child, '.git')) // dir OR file — a worktree's .git is a file
    } catch {
      /* raced away between readdir and stat; not a repo as far as we can tell */
    }
    return { name, path: child, isRepo }
  })

  return { ok: true, path, parent: parentOf(path), crumbs: crumbsFor(path), entries, truncated }
}
