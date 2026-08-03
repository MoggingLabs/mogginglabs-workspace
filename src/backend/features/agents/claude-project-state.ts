import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

// Project state follows profiles (the ADR-0013 extension, 2026-08-02). Claude keeps a
// per-PROJECT entry in each config home's `.claude.json` state file: the folder-trust
// verdict AND the session's grants — allowedTools, MCP server approvals, context URIs,
// the CLAUDE.md-includes approval. A profile switch that carried only the transcript
// resumed the conversation into a home where none of those decisions existed: the trust
// dialog interposed (seconds of dead time under the switch overlay) and every grant the
// user had accumulated was gone. This module carries the LAUNCH CWD's entry between
// homes, the exact posture of session-pool.ts next door:
//   grants only    the carried key set is closed (CARRIED_KEYS) — never account-level
//                  state (oauthAccount, caches, userID) and never the per-project stats
//                  claude keeps beside the grants (ADR 0002: nothing credential-shaped
//                  lives in a project entry, and we still copy only what continuity
//                  needs).
//   trust is policy  hasTrustDialogAccepted is forced TRUE for the launch cwd whether
//                  or not any source had it: the user opening a workspace at that
//                  folder IS the trust declaration (product decision 2026-08-02 — the
//                  same one the renderer's auto-trust watcher enforces after the fact;
//                  this makes the dialog never paint at all).
//   canonical keys  claude keys entries by the cwd AS ITS PROCESS SAW IT — forward
//                  slashes, and 8.3 short form when launched through one (observed
//                  live: "C:/Users/PVELOS~1/AppData/..."). Entries are matched by
//                  canonical path (realpath + case-fold), never string equality, and a
//                  fresh entry is keyed the way claude itself would write it.
//   best effort    a state-file failure is swallowed per home and the launch proceeds
//                  — a broken carry degrades to the CLI asking its own questions,
//                  never to a refused launch.

/** The grant + trust keys a project entry carries between homes — a CLOSED set. */
const CARRIED_KEYS = [
  'allowedTools',
  'mcpContextUris',
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'hasTrustDialogAccepted',
  'hasClaudeMdExternalIncludesApproved'
] as const

type ProjectEntry = Record<string, unknown>

/** Canonical form for matching entry keys: realpath (resolves 8.3 short names),
 *  forward slashes, case-folded (Windows paths are case-insensitive). `memo` is a
 *  per-CALL cache: a home with dozens of project entries paid one `realpathSync` per
 *  key per state file, and the answers cannot change inside one launch. */
function canonPath(p: string, memo?: Map<string, string>): string {
  const hit = memo?.get(p)
  if (hit !== undefined) return hit
  let resolved = p
  try {
    resolved = fs.realpathSync.native(p)
  } catch {
    /* the path may no longer exist — canonize the string form */
  }
  const out = resolved.replace(/\\/g, '/').toLowerCase()
  memo?.set(p, out)
  return out
}

/** The key claude itself writes for a cwd: the path with forward slashes. */
function claudeKeyFor(cwd: string): string {
  return cwd.replace(/\\/g, '/')
}

function readStateFile(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function projectsOf(state: Record<string, unknown>): Record<string, ProjectEntry> {
  const projects = state.projects
  return projects && typeof projects === 'object' && !Array.isArray(projects)
    ? (projects as Record<string, ProjectEntry>)
    : {}
}

function entryFor(
  state: Record<string, unknown>,
  cwd: string,
  memo?: Map<string, string>
): { key: string; entry: ProjectEntry } | null {
  const want = canonPath(cwd, memo)
  for (const [key, entry] of Object.entries(projectsOf(state))) {
    if (canonPath(key, memo) === want && entry && typeof entry === 'object') return { key, entry }
  }
  return null
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Merge one carried key: arrays UNION (a grant made anywhere holds), objects fill
 *  target-absent keys (the target home's own approvals outrank a sibling's), scalars
 *  keep the target's value when it has one. */
function mergeKey(target: ProjectEntry, source: ProjectEntry, key: string): void {
  const from = source[key]
  if (from === undefined) return
  const existing = target[key]
  if (Array.isArray(from)) {
    const seen = new Set(asArray(existing).map((v) => JSON.stringify(v)))
    target[key] = [...asArray(existing), ...from.filter((v) => !seen.has(JSON.stringify(v)))]
    return
  }
  if (isRecord(from)) {
    target[key] = { ...from, ...(isRecord(existing) ? existing : {}) }
    return
  }
  if (existing === undefined) target[key] = from
}

/** The state file a resolved claude config home reads: the DEFAULT home (`~/.claude`)
 *  keeps its state at `~/.claude.json` (a HOME-level sibling, claude's own layout);
 *  a relocated home (CLAUDE_CONFIG_DIR) keeps it INSIDE the pointed directory
 *  (verified live against both shapes on 2026-08-02). */
export function claudeStateFileFor(home: string): string {
  const defaultHome = join(homedir(), '.claude')
  return canonPath(home) === canonPath(defaultHome) ? join(homedir(), '.claude.json') : join(home, '.claude.json')
}

export interface ProjectStateCarryResult {
  /** The launch home's entry now declares the cwd trusted. */
  trusted: boolean
  /** A source home contributed grants (false = trust-only entry was written). */
  carried: boolean
}

/**
 * Ensure `targetStateFile`'s project entry for `cwd` is trusted and carries the grants
 * the other homes accumulated for that cwd. Pure file surgery, never throws; the
 * boolean result feeds the launch reply's `trustPrepared` so the renderer can skip its
 * trust-settle wait.
 *
 * WRITES ONLY ON A REAL CHANGE. The steady state — same workspace, same grants, trust
 * already declared — is every launch after the first, and rewriting the file there
 * restated bytes that were already correct. The write, when it happens, is ATOMIC:
 * this is the user's own `~/.claude.json`, holding their whole CLI state, and a crash
 * (or a low-disk moment) partway through a plain rewrite would truncate it.
 */
export function carryClaudeProjectState(
  cwd: string,
  targetStateFile: string,
  sourceStateFiles: string[]
): ProjectStateCarryResult {
  const out: ProjectStateCarryResult = { trusted: false, carried: false }
  if (!cwd || !targetStateFile) return out
  try {
    const canonMemo = new Map<string, string>()
    const state = readStateFile(targetStateFile) ?? {}
    const projects = projectsOf(state)
    state.projects = projects
    const existing = entryFor(state, cwd, canonMemo)
    const key = existing?.key ?? claudeKeyFor(cwd)
    const entry: ProjectEntry = existing?.entry ?? {}
    // The before-image of the entry we are about to mutate in place. An absent entry
    // has no before-image and is always a write.
    const before = existing ? JSON.stringify(entry) : null
    projects[key] = entry
    const targetCanon = canonPath(targetStateFile, canonMemo)
    for (const sourceFile of sourceStateFiles) {
      if (!sourceFile || canonPath(sourceFile, canonMemo) === targetCanon) continue
      const source = readStateFile(sourceFile)
      if (!source) continue
      const found = entryFor(source, cwd, canonMemo)
      if (!found) continue
      for (const carriedKey of CARRIED_KEYS) mergeKey(entry, found.entry, carriedKey)
      out.carried = true
    }
    entry.hasTrustDialogAccepted = true // policy: the open workspace IS the declaration
    // Unchanged entry ⇒ trust was already true and no source added anything ⇒ the file
    // on disk already says exactly what this call would write. Same answer, no write.
    // (Key order cannot drift here: both images are the same object, so a difference
    // means a merge really added or changed something.)
    if (before !== null && before === JSON.stringify(entry)) {
      out.trusted = true
      return out
    }
    writeFileAtomic.sync(targetStateFile, JSON.stringify(state, null, 2))
    out.trusted = true
  } catch {
    /* best effort — the launch proceeds and the CLI asks its own questions */
  }
  return out
}
