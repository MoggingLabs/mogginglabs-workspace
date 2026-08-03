import * as fs from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { toCallerNamespace } from '../../platform/fs-paths'

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
//                  canonical path (realpath + case-fold), never string equality.
//   every spelling  but claude READS by exact string, so matching canonically is only
//                  half the job: a fresh entry keyed the way WE saw the cwd is invisible
//                  to a claude that saw the other spelling, and it mints its own entry
//                  and paints the dialog anyway — the carry silently did nothing. So a
//                  fresh entry is written under EVERY spelling claude might report
//                  (claudeKeysFor), sharing one object, and trust is forced on every
//                  spelling already on file: two keys for one folder can never disagree
//                  about whether it is trusted.
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

/**
 * EVERY spelling claude might key this cwd under, most-likely first.
 *
 * Claude reads its entry with an EXACT string lookup on the cwd its own process reports,
 * and node hands a child the cwd VERBATIM — a child spawned at
 * `C:\Users\PVELOS~1\AppData\Local\Temp\x` reports exactly that; spawned at the long
 * spelling of the same directory it reports the long one. Node never canonicalizes, so
 * the spelling is decided by whoever computed the cwd — and this app has both kinds of
 * caller: paths that went through `realpathSync.native` (long) and paths taken straight
 * off `%TEMP%`, which on Windows is routinely the 8.3 short form. That is not theory:
 * of the 53 project entries in the real config on this machine, 42 are keyed
 * `C:/Users/PVELOS~1/AppData/Local/Temp/...` and 11 under the long `pveloso01` spelling,
 * for directories sharing the same parent.
 *
 * Writing ONE spelling meant guessing which side of that split claude would land on, and
 * a wrong guess made the whole carry a silent no-op: claude found no entry, minted its
 * own, and painted the trust dialog — the exact case the buffer-scraping fallback exists
 * to catch. Seeding every spelling costs one extra key and removes the guess.
 *
 * `tmp` is injectable so this stays testable on a machine whose TEMP is not aliased.
 * Exported for that reason only — the carry is its one caller.
 */
export function claudeKeysFor(cwd: string, tmp: string = tmpdir()): string[] {
  const forms = [cwd]
  let physical = cwd
  try {
    physical = fs.realpathSync.native(cwd) // 8.3 short / junction / symlink -> the long, physical spelling
    forms.push(physical)
  } catch {
    /* the cwd may not resolve — the spelling we were handed is all there is */
  }
  // ...and back the other way. `toCallerNamespace` walks TEMP's own lexical ancestors for
  // one whose realpath prefixes the physical path, then splices the physical suffix onto
  // that ancestor's spelling — which turns a long path under TEMP into the 8.3 spelling
  // `%TEMP%` itself is written in. TEMP is the aliased root that actually occurs here;
  // for a cwd outside it the call returns `physical` unchanged and adds nothing.
  try {
    forms.push(toCallerNamespace(physical, tmp))
  } catch {
    /* an unreadable ancestor just means no alias spelling to seed */
  }
  const keys: string[] = []
  for (const form of forms) {
    const key = claudeKeyFor(form)
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
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

/** EVERY entry naming this cwd, in file order. More than one is normal once a folder has
 *  been launched under two spellings (8.3 and long), and they are one folder: the carry
 *  forces trust on all of them so two keys can never disagree about it. */
function entriesFor(
  state: Record<string, unknown>,
  cwd: string,
  memo?: Map<string, string>
): { key: string; entry: ProjectEntry }[] {
  const want = canonPath(cwd, memo)
  const found: { key: string; entry: ProjectEntry }[] = []
  for (const [key, entry] of Object.entries(projectsOf(state))) {
    if (canonPath(key, memo) === want && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      found.push({ key, entry })
    }
  }
  return found
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
    const matches = entriesFor(state, cwd, canonMemo)
    // The entry the grants merge INTO: the one already on file, else a fresh one. Every
    // spelling we seed below shares this same object, so they cannot be born disagreeing.
    const entry: ProjectEntry = matches[0]?.entry ?? {}
    // Which of claude's possible spellings are not present AS KEYS. Claude looks its entry
    // up by exact string, so a spelling it might report needs a key of its own — a
    // canonical match under a DIFFERENT spelling is invisible to it. Computed before any
    // mutation, and it also reclaims a key holding a non-object (a null left by a
    // truncated write is not an entry).
    // The one exception is a cwd with a single spelling: there is no alias to defend
    // against, so an existing canonical match already IS the entry claude reads, and
    // minting a near-duplicate beside it would only split the folder's grants.
    const forms = claudeKeysFor(cwd)
    const seed = matches.length > 0 && forms.length === 1 ? [] : forms.filter((f) => !isRecord(projects[f]))
    // The before-images of the entries we are about to mutate in place. A seeded key is a
    // new key and is always a write.
    const before = matches.map((m) => JSON.stringify(m.entry))
    const targetCanon = canonPath(targetStateFile, canonMemo)
    for (const sourceFile of sourceStateFiles) {
      if (!sourceFile || canonPath(sourceFile, canonMemo) === targetCanon) continue
      const source = readStateFile(sourceFile)
      if (!source) continue
      // Every spelling in the source, not just the first: a grant the user made under the
      // 8.3 launch of a folder still belongs to that folder under its long spelling.
      const found = entriesFor(source, cwd, canonMemo)
      if (!found.length) continue
      for (const one of found) for (const carriedKey of CARRIED_KEYS) mergeKey(entry, one.entry, carriedKey)
      out.carried = true
    }
    // Policy: the open workspace IS the declaration. Forced on the merge target AND on
    // every other spelling already on file, so no two keys for one folder can disagree
    // about trust — a stale alias saying `false` is a dialog waiting to happen.
    entry.hasTrustDialogAccepted = true
    for (const one of matches) one.entry.hasTrustDialogAccepted = true
    // Seed the spellings claude might report and that no key covers yet. They share
    // `entry`, so the grants and the trust verdict are one object under several names.
    for (const key of seed) projects[key] = entry
    // Nothing seeded and no entry changed ⇒ trust was already true, no source added
    // anything, and every spelling already had a key ⇒ the file on disk already says
    // exactly what this call would write. Same answer, no write.
    // (Key order cannot drift here: each pair of images is the same object, so a
    // difference means a merge really added or changed something.)
    if (!seed.length && matches.every((m, i) => before[i] === JSON.stringify(m.entry))) {
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
