import { execFile } from 'node:child_process'
import { GIT_FILES_CAP, type GitFileState, type GitFileStatus, type GitStatus } from '@contracts'
import { findRepoRoot, readHeadBranch } from './repo'

// The read-only git probe. Given a pane's cwd it resolves { branch, ahead, behind, dirty } for
// the enclosing repo. It runs a SINGLE `git status --porcelain=v2 --branch` — one machine-stable
// call that yields the branch, upstream ahead/behind, AND the dirty flag together. Every argument
// is strictly read-only; nothing here ever writes to a repo (ADR: per-pane git is observe-only).
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

/** Parse `git status --porcelain=v2 --branch` output into a GitStatus (root supplied separately). */
export function parseStatusV2(root: string, out: string): GitStatus {
  let branch = ''
  let detached = false
  let oid = ''
  let ahead = 0
  let behind = 0
  let dirty = false

  for (const line of out.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length).trim()
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      if (head === '(detached)') detached = true
      else branch = head
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(-?\d+)\s+-(-?\d+)/.exec(line)
      if (m) {
        ahead = parseInt(m[1], 10) || 0
        behind = parseInt(m[2], 10) || 0
      }
    } else if (line[0] === '1' || line[0] === '2' || line[0] === 'u' || line[0] === '?') {
      // Changed (1/2), unmerged (u), or untracked (?) entry -> the working tree is dirty.
      dirty = true
    }
  }

  if (detached || !branch) {
    detached = true
    branch = oid && oid !== '(initial)' ? oid.slice(0, 7) : branch || '(no branch)'
  }
  return { root, branch, detached, ahead, behind, dirty }
}

// ── File-level status (Phase-11/05): the lines above ALREADY read, then thrown away ──
//
// `parseStatusV2` walks every `1`/`2`/`u`/`?` line and keeps exactly one bit from them:
// `dirty = true`. The explorer needs WHICH files and HOW, so we parse the same lines a
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
    const path = unquotePath(raw.trim())
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
export async function probeGitFull(cwd: string, wantFiles = false): Promise<GitProbeResult> {
  const root = findRepoRoot(cwd)
  if (!root) return { status: null, files: null, truncated: false }
  try {
    const out = await run(statusArgs(root))
    const status = parseStatusV2(root, out)
    if (!wantFiles) return { status, files: null, truncated: false }
    const { files, truncated } = parseStatusFiles(out)
    return { status, files, truncated }
  } catch {
    // git missing / errored — degrade gracefully to a branch-only view from .git/HEAD.
    const branch = readHeadBranch(root)
    return {
      status: { root, branch: branch ?? '(git unavailable)', detached: branch == null, ahead: 0, behind: 0, dirty: false },
      files: wantFiles ? [] : null,
      truncated: false
    }
  }
}

/**
 * Probe the repo enclosing `cwd`. Returns null when `cwd` is empty or not inside a repo (the pane
 * simply shows no chip). If `git` can't be run but a `.git` exists, falls back to the branch from
 * HEAD (dirty unknown -> false) so a repo still shows its branch. Never throws.
 */
export async function probeGit(cwd: string): Promise<GitStatus | null> {
  return (await probeGitFull(cwd, false)).status
}
