import * as fs from 'node:fs'
import * as path from 'node:path'
import { toCallerNamespace } from '../../platform/fs-paths'

// Pure filesystem helpers for the read-only git probe. No subprocess here — walking up for a
// `.git` entry is cheaper than spawning `git`, gives us the repo root for dedup/caching, and is
// the fast "not a repo -> show nothing" path. Electron-free (@backend stays Node-only).

/**
 * Walk up from `cwd` to the nearest directory that contains a `.git` entry (a dir for a normal
 * repo, or a FILE for a worktree/submodule gitdir pointer). Returns the repo root, or null when
 * `cwd` is empty/unreadable or not inside a repo. Bounded by the filesystem root.
 */
export function findRepoRoot(cwd: string): string | null {
  if (!cwd) return null
  const logical = path.resolve(cwd)
  let dir: string
  try {
    // Git discovers repositories from the physical directory. Resolve the starting path before
    // walking parents so `link/child` (where `link` targets a directory inside a checkout) does
    // not escape to the link's lexical parent before reaching the target checkout's `.git`.
    // This helper returns probe identity only; pane/user-facing cwd state remains unchanged.
    dir = fs.realpathSync.native(logical)
    if (!fs.statSync(dir).isDirectory()) return null
  } catch {
    return null
  }
  // Already canonical -> every lexical ancestor is too; the walk's answer needs no translation.
  const aliased = dir !== logical
  // Guard against symlink loops / pathological depth.
  for (let i = 0; i < 256; i++) {
    try {
      // Existence alone is not repository identity: source trees and fixtures commonly contain
      // stale/dummy `.git` entries. Require a resolvable administrative directory with HEAD so
      // an invalid pointer cannot turn into a misleading "git unavailable" chip.
      fs.lstatSync(path.join(dir, '.git'))
      const layout = readGitLayout(dir)
      if (layout) return aliased ? toCallerNamespace(dir, logical) : dir
    } catch {
      /* no usable entry at this level; Git discovery continues toward the parent */
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null // filesystem root
    dir = parent
  }
  return null
}

/**
 * Best-effort branch name straight from `<root>/.git/HEAD`, used only as a fallback when the
 * `git` binary can't be spawned. `ref: refs/heads/<branch>` -> `<branch>`; a raw SHA -> null
 * (detached). Resolves linked-worktree gitdir pointers as well as regular `.git` directories.
 */
export function readHeadBranch(root: string): string | null {
  try {
    const gitDir = readGitLayout(root)?.gitDir ?? path.join(root, '.git')
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return m ? m[1] : null
  } catch {
    return null
  }
}

export interface GitLayout {
  /** Per-worktree git directory. A linked worktree keeps HEAD/index here. */
  gitDir: string
  /** Shared repository metadata directory. Refs for every linked worktree live here. */
  commonDir: string
  linkedWorktree: boolean
}

interface PackedRefsCache {
  mtimeMs: number
  ctimeMs: number
  size: number
  refs: Map<string, string>
}

const packedRefsCache = new Map<string, PackedRefsCache>()
const oidPattern = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/

/** Resolve both forms of `.git`: a directory in a regular checkout or a gitdir pointer file
 * in a linked worktree/submodule. `commondir` is the authoritative linked-worktree marker. */
export function readGitLayout(root: string): GitLayout | null {
  const dotGit = path.join(root, '.git')
  try {
    const stat = fs.statSync(dotGit)
    let gitDir = dotGit
    if (stat.isFile()) {
      const pointer = fs.readFileSync(dotGit, 'utf8').trim()
      const match = /^gitdir:\s*(.+)$/i.exec(pointer)
      if (!match) return null
      gitDir = path.resolve(root, match[1])
    } else if (!stat.isDirectory()) {
      return null
    }

    if (!fs.statSync(gitDir).isDirectory() || !fs.statSync(path.join(gitDir, 'HEAD')).isFile()) {
      return null
    }

    let commonDir = gitDir
    const commonPath = path.join(gitDir, 'commondir')
    if (fs.existsSync(commonPath)) {
      const configured = fs.readFileSync(commonPath, 'utf8').trim()
      if (configured) commonDir = path.resolve(gitDir, configured)
    }
    if (!fs.statSync(commonDir).isDirectory()) return null
    return { gitDir, commonDir, linkedWorktree: path.resolve(commonDir) !== path.resolve(gitDir) }
  } catch {
    return null
  }
}

/** Resolve a loose or packed branch/remote ref without spawning Git. Active refs are normally
 * loose; packed refs are parsed once per file version. `null` also covers reftable/unknown storage,
 * which tells the caller to fall back to authoritative Git resolution rather than trust a cache. */
export function readGitRefOid(root: string, refName: string): string | null {
  const layout = readGitLayout(root)
  if (!layout || (!refName.startsWith('refs/heads/') && !refName.startsWith('refs/remotes/'))) {
    return null
  }

  const packedOid = (name: string): string | null => {
    const packedPath = path.join(layout.commonDir, 'packed-refs')
    try {
      const stat = fs.statSync(packedPath)
      const key = process.platform === 'win32'
        ? packedPath.toLocaleLowerCase('en-US')
        : packedPath
      let cached = packedRefsCache.get(key)
      if (
        !cached ||
        cached.mtimeMs !== stat.mtimeMs ||
        cached.ctimeMs !== stat.ctimeMs ||
        cached.size !== stat.size
      ) {
        const refs = new Map<string, string>()
        for (const line of fs.readFileSync(packedPath, 'utf8').split('\n')) {
          if (!line || line[0] === '#' || line[0] === '^') continue
          const separator = line.indexOf(' ')
          if (separator <= 0) continue
          const oid = line.slice(0, separator)
          const ref = line.slice(separator + 1).replace(/\r$/, '')
          if (oidPattern.test(oid) && ref) refs.set(ref, oid.toLowerCase())
        }
        cached = { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, refs }
        packedRefsCache.set(key, cached)
      }
      return cached.refs.get(name) ?? null
    } catch {
      return null
    }
  }

  let current = refName
  for (let depth = 0; depth < 8; depth++) {
    const target = path.resolve(layout.commonDir, ...current.split('/'))
    const relative = path.relative(layout.commonDir, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
    try {
      const value = fs.readFileSync(target, 'utf8').trim()
      const symbolic = /^ref:\s*(\S+)\s*$/.exec(value)
      if (symbolic) {
        current = symbolic[1]
        continue
      }
      return oidPattern.test(value) ? value.toLowerCase() : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      return packedOid(current)
    }
  }
  return null
}

/** Directories whose administrative-file changes can alter branch, index, upstream, or base
 * divergence. These are deliberately tiny metadata watches, never recursive worktree watches. */
export function gitMetadataWatchDirs(root: string): string[] {
  const layout = readGitLayout(root)
  if (!layout) return []
  const refParent = (ref: string | null): string | null => {
    if (!ref) return null
    const normalized = ref.replace(/\\/g, '/')
    if (!normalized.startsWith('refs/heads/') && !normalized.startsWith('refs/remotes/')) return null
    const target = path.resolve(layout.commonDir, ...normalized.split('/'))
    const relative = path.relative(layout.commonDir, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
    return path.dirname(target)
  }
  const readSymbolicRef = (file: string): string | null => {
    try {
      const match = /^ref:\s*(\S+)\s*$/.exec(fs.readFileSync(file, 'utf8'))
      return match?.[1] ?? null
    } catch {
      return null
    }
  }
  const managed = readManagedBase(root)
  const managedRef = managed
    ? managed.startsWith('refs/')
      ? managed
      : managed.startsWith('origin/')
        ? `refs/remotes/${managed}`
        : `refs/heads/${managed}`
    : null
  const candidates = [
    layout.gitDir,
    layout.commonDir,
    path.join(layout.commonDir, 'refs', 'heads'),
    path.join(layout.commonDir, 'refs', 'remotes'),
    path.join(layout.commonDir, 'refs', 'remotes', 'origin'),
    refParent(readSymbolicRef(path.join(layout.gitDir, 'HEAD'))),
    refParent(managedRef),
    refParent(readSymbolicRef(path.join(layout.commonDir, 'refs', 'remotes', 'origin', 'HEAD')))
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of candidates) {
    if (!candidate) continue
    const resolved = path.resolve(candidate)
    const key = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
    if (seen.has(key)) continue
    try {
      if (!fs.statSync(resolved).isDirectory()) continue
    } catch {
      continue
    }
    seen.add(key)
    out.push(resolved)
  }
  return out
}

/** Managed worktrees record the ref they forked from inside their private git dir. The value is
 * local metadata, so validate it before it can become a revision argument. */
export function readManagedBase(root: string): string | null {
  const layout = readGitLayout(root)
  if (!layout?.linkedWorktree) return null
  try {
    const value = fs.readFileSync(path.join(layout.gitDir, 'mogging-base'), 'utf8').trim()
    const forbidden = [...value].some((char) => {
      const code = char.charCodeAt(0)
      return code <= 32 || code === 127 || '~^:?*[\\'.includes(char)
    })
    if (
      value.length > 0 &&
      value.length <= 256 &&
      !value.startsWith('-') &&
      !forbidden &&
      !value.includes('..') &&
      !value.includes('@{') &&
      !value.includes('//') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value.toLowerCase().endsWith('.lock')
    ) {
      return value
    }
  } catch {
    /* not a managed worktree */
  }
  return null
}
