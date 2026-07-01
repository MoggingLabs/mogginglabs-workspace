import { execFile } from 'node:child_process'
import type { GitStatus } from '@contracts'
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

/**
 * Probe the repo enclosing `cwd`. Returns null when `cwd` is empty or not inside a repo (the pane
 * simply shows no chip). If `git` can't be run but a `.git` exists, falls back to the branch from
 * HEAD (dirty unknown -> false) so a repo still shows its branch. Never throws.
 */
export async function probeGit(cwd: string): Promise<GitStatus | null> {
  const root = findRepoRoot(cwd)
  if (!root) return null
  try {
    const out = await run(statusArgs(root))
    return parseStatusV2(root, out)
  } catch {
    // git missing / errored — degrade gracefully to a branch-only view from .git/HEAD.
    const branch = readHeadBranch(root)
    return { root, branch: branch ?? '(git unavailable)', detached: branch == null, ahead: 0, behind: 0, dirty: false }
  }
}
