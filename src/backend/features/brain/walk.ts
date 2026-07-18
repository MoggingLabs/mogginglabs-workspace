import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { readGitLayout } from '../git'

// The walk (ADR 0018, step 03): enumerate ONE root's candidate files, worker-side,
// deterministically. A repo enumerates through git itself — `git ls-files -z
// --cached --others --exclude-standard` — so .gitignore is respected for free and
// the answer is the same one every git tool gives. A plain folder walks with the
// dot-rule (no dot entries) plus the default ignores. No watcher, no incremental
// path — this is the FULL enumeration 04 will diff against.
//
// `.mogging/` and `.memory/` are ignored in BOTH modes: worktree plumbing and the
// memory graph are not source (09 carves `.memory/` back in for itself).

/** Folder-mode ignores; git mode gets these from .gitignore or the deny list below. */
const FOLDER_IGNORES = new Set(['node_modules', 'dist', 'out', 'build'])
/** Path prefixes refused in BOTH modes, gitignored or not. */
const ALWAYS_IGNORED = ['.mogging/', '.memory/']

export type WalkResult =
  | { ok: true; files: string[] }
  | { ok: false; reason: 'too-large'; fileCount: number; cap: number }

const ignored = (rel: string): boolean => ALWAYS_IGNORED.some((p) => rel.startsWith(p))

function gitFiles(root: string): string[] | null {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
    )
    return out
      .split('\0')
      .filter((rel) => rel && !ignored(rel))
      .filter((rel) => existsSync(path.join(root, rel))) // --cached lists deleted-but-tracked too
  } catch {
    return null // git missing or refused — fall back to the folder walk
  }
}

function folderFiles(root: string): string[] {
  const out: string[] = []
  const visit = (rel: string): void => {
    const abs = rel ? path.join(root, rel) : root
    let entries: string[]
    try {
      entries = readdirSync(abs)
    } catch {
      return // unreadable dir: skipped, like every listing in this app
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith('.')) continue // the dot-rule
      if (FOLDER_IGNORES.has(entry)) continue
      const childRel = rel ? `${rel}/${entry}` : entry
      if (ignored(childRel + '/')) continue
      let stat
      try {
        stat = statSync(path.join(root, childRel))
      } catch {
        continue
      }
      if (stat.isDirectory()) visit(childRel)
      else if (stat.isFile()) out.push(childRel)
    }
  }
  visit('')
  return out
}

/**
 * Enumerate `root`, sorted, '/'-separated, relative. Over the cap is a typed
 * refusal CARRYING the counts — the caller never learns "too big" without "how big".
 */
export function walkRoot(root: string, maxFiles: number): WalkResult {
  const files = (readGitLayout(root) ? (gitFiles(root) ?? folderFiles(root)) : folderFiles(root))
    .map((rel) => rel.replace(/\\/g, '/'))
    .sort()
  if (files.length > maxFiles) {
    return { ok: false, reason: 'too-large', fileCount: files.length, cap: maxFiles }
  }
  return { ok: true, files }
}
