import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { UNFILED_PROJECT_KEY, type BrainRefusal } from '@contracts'
import { readGitLayout } from '../git'
import { foldProjectKey, projectKeyForCwd } from '../workspace/project-identity'

// PROJECT resolution for the brain (ADR 0018.c): a root maps to the board-v2 project
// key — the SAME extracted helper the board runs, so the two surfaces can never give
// one directory two identities — plus every sibling root the one brain answers for.
// Electron-free, read-only: `.git` metadata files, never a subprocess, never a walk
// of the tree itself (the guardrail: no parser, no walker this step).

export interface BrainProject {
  projectKey: string
  /** The project key's own checkout first, then its linked worktrees, deduped. */
  roots: string[]
}

/** Linked-worktree roots straight from `<commonDir>/worktrees/<slug>/gitdir` — each
 *  pointer names `<wtRoot>/.git`, so its dirname is the root. A stale registration
 *  (worktree deleted, `git worktree prune` never run) is skipped, never a throw. */
function worktreeRootsOf(projectKey: string): string[] {
  const layout = readGitLayout(projectKey)
  if (!layout) return []
  const registry = path.join(layout.commonDir, 'worktrees')
  const out: string[] = []
  try {
    for (const slug of readdirSync(registry)) {
      try {
        const pointer = readFileSync(path.join(registry, slug, 'gitdir'), 'utf8').trim()
        if (!pointer) continue
        const root = path.dirname(path.resolve(pointer))
        if (existsSync(root)) out.push(root)
      } catch {
        /* stale or unreadable registration — not a root */
      }
    }
  } catch {
    /* no linked worktrees */
  }
  return out
}

/**
 * Resolve a root directory to its project identity. Total: a refusal is a VALUE
 * (`missing` = no such path; `invalid` = relative path or not a directory), never
 * a throw — the shape half of `invalid` (junk requests) is main's job at the seam.
 */
export function resolveBrainProject(root: string): BrainProject | BrainRefusal {
  if (!root || !path.isAbsolute(root)) return { ok: false, reason: 'invalid' }
  try {
    if (!statSync(root).isDirectory()) return { ok: false, reason: 'invalid', detail: 'not a directory' }
  } catch {
    return { ok: false, reason: 'missing' }
  }
  const projectKey = projectKeyForCwd(root)
  if (projectKey === UNFILED_PROJECT_KEY) return { ok: false, reason: 'invalid' }
  const roots: string[] = []
  const seen = new Set<string>()
  for (const candidate of [projectKey, ...worktreeRootsOf(projectKey)]) {
    const key = foldProjectKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(candidate)
  }
  return { projectKey, roots }
}
