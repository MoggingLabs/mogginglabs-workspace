import { execFile } from 'node:child_process'
import { GIT_FILES_CAP, type GitFileState, type GitFileStatus, type GitStatus } from '@contracts'
import { findRepoRoot, readGitLayout, readGitRefOid, readHeadBranch, readManagedBase } from './repo'

// The read-only git probe resolves branch/worktree identity and working-tree state for a pane's
// enclosing repository. It runs a single `git status --porcelain=v2 --branch` machine-stable
// call that yields branch, upstream, and file counts together. Base divergence runs only when
// HEAD/base changes and is cached between polls. Nothing here writes to a repository.
//
// Electron-free: only node:child_process. `git` is resolved off the process PATH (git-for-windows
// ships git.exe, so execFile finds it without a shell).

/** Read-only args — a fixed allowlist. `-C root` pins the repo; no mutation is possible. */
function statusArgs(root: string): string[] {
  return ['-C', root, '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal']
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

interface BaseDivergence {
  baseBranch: string | null
  baseOid: string | null
  baseAhead: number
  baseBehind: number
}

interface DivergenceCacheEntry extends BaseDivergence {
  head: string
  branch: string
  expiresAt: number
}

interface BaseRefCacheEntry {
  baseBranch: string | null
  baseRef: string | null
  baseOid: string | null
  managedBase: string | null
  expiresAt: number
}

// Commit divergence changes only when HEAD or a base ref moves. Metadata watchers invalidate it
// immediately; stable base-ref discovery has its own TTL so every commit does not rediscover
// `main`. Ordinary dirty polls retain the original one-spawn-per-worktree cost.
const DIVERGENCE_TTL_MS = 60_000
const divergenceCache = new Map<string, DivergenceCacheEntry>()
const baseRefCache = new Map<string, BaseRefCacheEntry>()
const pathKey = (p: string): string => (process.platform === 'win32' ? p.toLocaleLowerCase('en-US') : p)

export function invalidateGitDivergence(root?: string): void {
  if (root) {
    const key = pathKey(root)
    divergenceCache.delete(key)
    baseRefCache.delete(key)
  }
  else {
    divergenceCache.clear()
    baseRefCache.clear()
  }
}

/** Find the conventional local base, with origin/HEAD as the fallback. `symref:short`
 * resolves a remote default without fetching or making another process call. */
interface BaseRef {
  baseBranch: string
  baseRef: string
  baseOid: string
}

async function discoverBaseRef(root: string): Promise<BaseRef | null> {
  try {
    const out = await run([
      '-C',
      root,
      '--no-optional-locks',
      'for-each-ref',
      '--format=%(refname)\t%(refname:short)\t%(symref)\t%(symref:short)\t%(objectname)',
      'refs/heads/main',
      'refs/heads/master',
      'refs/remotes/origin/HEAD'
    ])
    const refs = new Map<string, BaseRef>()
    for (const line of out.split('\n')) {
      const [ref = '', name = '', targetRef = '', target = '', oid = ''] = line
        .replace(/\r$/, '')
        .split('\t')
      if (ref && name && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(oid)) {
        refs.set(name, {
          baseBranch: target || name,
          baseRef: targetRef || ref,
          baseOid: oid.toLowerCase()
        })
      }
    }
    if (refs.has('main')) return refs.get('main') ?? null
    if (refs.has('master')) return refs.get('master') ?? null
    return refs.get('origin/HEAD') ?? null
  } catch {
    return null
  }
}

async function resolveBaseRef(root: string, baseBranch: string): Promise<BaseRef | null> {
  try {
    const oid = (
      await run([
        '-C',
        root,
        '--no-optional-locks',
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${baseBranch}^{commit}`
      ])
    ).trim()
    const baseRef = baseBranch.startsWith('refs/')
      ? baseBranch
      : baseBranch.startsWith('origin/')
        ? `refs/remotes/${baseBranch}`
        : `refs/heads/${baseBranch}`
    return /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(oid)
      ? { baseBranch, baseRef, baseOid: oid.toLowerCase() }
      : null
  } catch {
    return null
  }
}

async function baseRefFor(root: string, allowCache: boolean): Promise<BaseRef | null> {
  const key = pathKey(root)
  const managed = readManagedBase(root)
  const cached = baseRefCache.get(key)
  if (
    allowCache &&
    cached &&
    cached.managedBase === managed &&
    (!managed || cached.baseBranch === managed) &&
    cached.expiresAt > Date.now()
  ) {
    if (cached.baseBranch && cached.baseRef && cached.baseOid) {
      const observedOid = readGitRefOid(root, cached.baseRef)
      if (observedOid === cached.baseOid) {
        return { baseBranch: cached.baseBranch, baseRef: cached.baseRef, baseOid: cached.baseOid }
      }
    } else {
      return null
    }
  }
  const base = managed ? await resolveBaseRef(root, managed) : await discoverBaseRef(root)
  baseRefCache.set(key, {
    baseBranch: base?.baseBranch ?? null,
    baseRef: base?.baseRef ?? null,
    baseOid: base?.baseOid ?? null,
    managedBase: managed,
    expiresAt: Date.now() + DIVERGENCE_TTL_MS
  })
  return base
}

async function compareWithBase(root: string, base: BaseRef, headOid: string): Promise<BaseDivergence | null> {
  try {
    // For `<base>...HEAD`, left is base-only (behind) and right is HEAD-only (ahead).
    const out = await run([
      '-C',
      root,
      '--no-optional-locks',
      'rev-list',
      '--left-right',
      '--count',
      '--end-of-options',
      `${base.baseOid}...${headOid}`
    ])
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(out)
    return match
      ? {
          baseBranch: base.baseBranch,
          baseOid: base.baseOid,
          baseBehind: Number(match[1]),
          baseAhead: Number(match[2])
        }
      : null
  } catch {
    return null
  }
}

/** Compare HEAD with a managed worktree's recorded fork base, then the repository default.
 * Results are cached by worktree + HEAD and invalidated by the monitor's metadata watches. */
async function probeBaseDivergence(
  root: string,
  status: GitStatus,
  allowCache: boolean
): Promise<BaseDivergence> {
  if (!status.head) return { baseBranch: null, baseOid: null, baseAhead: 0, baseBehind: 0 }
  const key = pathKey(root)
  const managedBase = readManagedBase(root)
  const preferredBase = await baseRefFor(root, allowCache)
  const cached = divergenceCache.get(key)
  if (
    allowCache &&
    cached &&
    cached.head === status.head &&
    cached.branch === status.branch &&
    cached.baseBranch === (preferredBase?.baseBranch ?? null) &&
    cached.baseOid === (preferredBase?.baseOid ?? null) &&
    cached.expiresAt > Date.now()
  ) {
    return {
      baseBranch: cached.baseBranch,
      baseOid: cached.baseOid,
      baseAhead: cached.baseAhead,
      baseBehind: cached.baseBehind
    }
  }

  let result = preferredBase ? await compareWithBase(root, preferredBase, status.head) : null
  if (!result && (preferredBase || managedBase)) {
    // A managed worktree can outlive a renamed/deleted fork branch. Keep progress visible by
    // retrying the conventional repository default instead of treating one stale file as final.
    const fallback = await discoverBaseRef(root)
    if (fallback && fallback.baseOid !== preferredBase?.baseOid) {
      result = await compareWithBase(root, fallback, status.head)
      if (result) {
        baseRefCache.set(key, {
          ...fallback,
          managedBase,
          expiresAt: Date.now() + DIVERGENCE_TTL_MS
        })
      }
    }
  }
  result ??= { baseBranch: null, baseOid: null, baseAhead: 0, baseBehind: 0 }

  divergenceCache.set(key, {
    ...result,
    head: status.head,
    branch: status.branch,
    expiresAt: Date.now() + DIVERGENCE_TTL_MS
  })
  return result
}

/** Parse `git status --porcelain=v2 --branch` output into a GitStatus (root supplied separately). */
export function parseStatusV2(root: string, out: string): GitStatus {
  let branch = ''
  let detached = false
  let oid = ''
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let changed = 0
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0

  for (const line of out.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length).trim()
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      if (head === '(detached)') detached = true
      else branch = head
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim() || null
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(-?\d+)\s+-(-?\d+)/.exec(line)
      if (m) {
        ahead = parseInt(m[1], 10) || 0
        behind = parseInt(m[2], 10) || 0
      }
    } else if (line[0] === '1' || line[0] === '2') {
      changed++
      const xy = line.slice(2, 4)
      if (xy[0] && xy[0] !== '.') staged++
      if (xy[1] && xy[1] !== '.') unstaged++
    } else if (line[0] === 'u') {
      changed++
      conflicted++
    } else if (line[0] === '?') {
      changed++
      untracked++
    }
  }

  if (detached || !branch) {
    detached = true
    branch = oid && oid !== '(initial)' ? oid.slice(0, 7) : branch || '(no branch)'
  }
  return {
    root,
    branch,
    detached,
    head: oid && oid !== '(initial)' ? oid : null,
    linkedWorktree: false,
    available: true,
    upstream,
    ahead,
    behind,
    baseBranch: null,
    baseAhead: 0,
    baseBehind: 0,
    dirty: changed > 0,
    changed,
    staged,
    unstaged,
    untracked,
    conflicted
  }
}

// ── File-level status (Phase-11/05): the lines above ALREADY read, then thrown away ──
//
// `parseStatusV2` walks every `1`/`2`/`u`/`?` line for summary counts. The explorer also needs
// WHICH files and HOW, so we parse the same lines a
// second way — from the SAME output of the SAME spawn. No new git process exists to add.

/**
 * git quotes a pathname (core.quotePath, on by default) when it holds a control character,
 * a quote, a backslash, or a non-ASCII byte: `"\303\251clair.txt"`. The octal escapes are
 * BYTES, so they must be reassembled and decoded as UTF-8 — decoding them as code points
 * would mangle every accented filename an agent ever writes.
 */
function unquotePath(p: string): string {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return p
  const body = p.slice(1, -1)
  const bytes: number[] = []
  const ESC: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      for (const b of Buffer.from(body[i], 'utf8')) bytes.push(b)
      continue
    }
    const n = body[++i]
    if (n === undefined) break
    if (n >= '0' && n <= '7') {
      bytes.push(parseInt(body.slice(i, i + 3), 8) & 0xff)
      i += 2
    } else {
      bytes.push(ESC[n] ?? n.charCodeAt(0))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** The XY field of a porcelain-v2 ordinary entry: X = index, Y = worktree. Severity order —
 *  a file both added and deleted reads as deleted, which is what the user must act on. */
function stateForXY(xy: string): GitFileStatus {
  const x = xy[0] ?? '.'
  const y = xy[1] ?? '.'
  if (x === 'U' || y === 'U') return 'conflicted'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A') return 'added'
  if (x === 'R' || x === 'C') return 'renamed'
  return 'modified'
}

/**
 * The per-file records, from the branch probe's own output. Sorted, THEN capped, so
 * `truncated` always means the same thing.
 *
 * Porcelain v2 field layout (space-separated; the path is LAST and may contain spaces):
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<origPath>
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 *   ? <path>
 */
export function parseStatusFiles(out: string): { files: GitFileState[]; truncated: boolean } {
  const files: GitFileState[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const kind = line[0]
    let raw = ''
    let state: GitFileStatus
    if (kind === '1') {
      const f = line.split(' ')
      raw = f.slice(8).join(' ')
      state = stateForXY(f[1] ?? '')
    } else if (kind === '2') {
      const f = line.split(' ')
      raw = f.slice(9).join(' ').split('\t')[0] // the NEW path; the original follows a TAB
      state = 'renamed'
    } else if (kind === 'u') {
      const f = line.split(' ')
      raw = f.slice(10).join(' ')
      state = 'conflicted'
    } else if (kind === '?') {
      raw = line.slice(2)
      state = 'untracked'
    } else {
      continue // `#` header lines, `!` ignored (never requested), anything new: not ours
    }
    // Preserve legal leading/trailing pathname spaces. Only a CR belonging to a CRLF record
    // delimiter may be removed; Git C-quotes a pathname that itself contains a carriage return.
    const path = unquotePath(raw.replace(/\r$/, ''))
    if (path) files.push({ path, state })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const truncated = files.length > GIT_FILES_CAP
  return { files: truncated ? files.slice(0, GIT_FILES_CAP) : files, truncated }
}

/** One probe's whole yield. `files` is null unless the caller ASKED for it — a pane's chip
 *  never pays to parse them, and the status it emits is byte-identical either way. */
export interface GitProbeResult {
  status: GitStatus | null
  files: GitFileState[] | null
  truncated: boolean
}

/**
 * Probe the repo enclosing `cwd`, optionally retaining the per-file records. ONE
 * `git status --porcelain=v2 --branch` — the same command, the same args, the same output;
 * `wantFiles` only decides whether we read the lines twice or once.
 *
 * A non-repo returns immediately WITHOUT spawning git (findRepoRoot is pure filesystem) —
 * which is what makes a non-repo workspace cost literally nothing (11/05 dormancy).
 */
export async function probeGitFull(
  cwd: string,
  wantFiles = false,
  allowDivergenceCache = false
): Promise<GitProbeResult> {
  const root = findRepoRoot(cwd)
  if (!root) return { status: null, files: null, truncated: false }
  try {
    const out = await run(statusArgs(root))
    const status = parseStatusV2(root, out)
    status.linkedWorktree = readGitLayout(root)?.linkedWorktree ?? false
    const divergence = await probeBaseDivergence(root, status, allowDivergenceCache)
    status.baseBranch = divergence.baseBranch
    status.baseAhead = divergence.baseAhead
    status.baseBehind = divergence.baseBehind
    if (!wantFiles) return { status, files: null, truncated: false }
    const { files, truncated } = parseStatusFiles(out)
    return { status, files, truncated }
  } catch {
    // git missing / errored — degrade gracefully to a branch-only view from .git/HEAD.
    const branch = readHeadBranch(root)
    const linkedWorktree = readGitLayout(root)?.linkedWorktree ?? false
    return {
      status: {
        root,
        branch: branch ?? '(git unavailable)',
        detached: branch == null,
        head: null,
        linkedWorktree,
        available: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        baseBranch: null,
        baseAhead: 0,
        baseBehind: 0,
        dirty: false,
        changed: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0
      },
      files: wantFiles ? [] : null,
      truncated: false
    }
  }
}

/**
 * Probe the repo enclosing `cwd`. Returns null when `cwd` is empty or not inside a repo (the pane
 * simply shows no chip). If `git` can't be run but a `.git` exists, falls back to the branch from
 * HEAD so a repo still shows its branch with `available:false`, never a false clean state.
 */
export async function probeGit(cwd: string): Promise<GitStatus | null> {
  return (await probeGitFull(cwd, false)).status
}
