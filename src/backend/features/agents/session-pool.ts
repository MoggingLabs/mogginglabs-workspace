import * as fs from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  claudeProjectDirName,
  codexDayDirs,
  findClaudeProjectDir,
  findGeminiProjectDir,
  pathKey,
  readCodexSessionCwd
} from '../context'

// Sessions follow profiles (ADR 0013). A Phase-4 profile is a separate CLI config home
// (CLAUDE_CONFIG_DIR et al.) — the provider's SANCTIONED multi-account mechanism — but the
// CLIs keep their session transcripts INSIDE that home, so every profile is a private
// session silo: fail over to the next subscription and `--resume` finds nothing. This
// module is the bridge: before a launch, it unions the LAUNCH CWD's sessions from the
// provider's other known homes into the launch home, at each CLI's own documented
// location, so the CLI's own resume machinery simply sees them.
//
// The rules that keep this honest:
//   whole files   transcripts are copied byte-for-byte, never parsed or rewritten — the
//                 docs call the LINE format internal; the PATHS are the documented API.
//   newer wins    a target file at least as new as the source is never touched; copies
//                 preserve the source mtime so the comparison stays meaningful next time.
//   known homes   sources are the provider's default home + saved profile homes (ADR 0007
//                 rule 3 — never a crawl), and only the launch cwd's sessions move.
//   no secrets    session logs are conversation data. Credentials (.credentials.json,
//                 auth.json, oauth_creds.json) live in the same homes and are never
//                 candidates — the copy set is enumerated per provider below (ADR 0002).
//   best effort   pooling is a courtesy before a launch, never a gate: any single file's
//                 failure is counted and skipped, and the caller launches regardless.

/** Only sessions this fresh ride along. Matches the CLI's own default transcript
 *  retention (cleanupPeriodDays = 30) — older files are what the CLI itself is about
 *  to groom away, and unbounded pooling would copy a workspace's whole history on the
 *  first failover. */
const MAX_AGE_DAYS = 30

export interface SessionPoolResult {
  copied: number
  skipped: number
  errors: number
}

const winish = process.platform === 'win32'
const normPath = (p: string): string => (winish ? resolve(p).toLowerCase() : resolve(p))

/** UUID-shaped resume ids only — anything else never enters a typed command line. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The session id a resume-by-id launch should name, derived from the session log the
 *  context monitor locked for the pane. Null when the file isn't provider-shaped —
 *  callers then fall back to the bare resume flag (the CLI's own picker). */
export function resumeSessionIdFromFile(provider: string, file: string): string | null {
  const name = basename(file)
  if (provider === 'claude') {
    const id = name.replace(/\.jsonl$/i, '')
    return SESSION_ID.test(id) ? id : null
  }
  if (provider === 'codex') {
    const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)
    return m ? m[1] : null
  }
  return null // gemini's --resume takes no id the app can trust — the flag rides bare
}

function freshEnough(mtimeMs: number, now: number): boolean {
  return now - mtimeMs <= MAX_AGE_DAYS * 24 * 60 * 60_000
}

/** Copy src over dst unless dst is at least as new. Preserves the source mtime so the
 *  newer-wins comparison survives repeated pools (a copy stamped "now" would shadow a
 *  genuinely newer source forever). A source mid-write copies with a possibly cut last
 *  line — the CLIs already tolerate that in their own crash paths, and the next pool
 *  heals it (the source's mtime moved). */
function copyIfNewer(src: string, dst: string, out: SessionPoolResult, now: number): void {
  try {
    const s = fs.statSync(src)
    if (!s.isFile() || !freshEnough(s.mtimeMs, now)) return
    try {
      if (fs.statSync(dst).mtimeMs >= s.mtimeMs) {
        out.skipped++
        return
      }
    } catch {
      /* absent — copy */
    }
    fs.mkdirSync(dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    fs.utimesSync(dst, s.atime, s.mtime)
    out.copied++
  } catch {
    out.errors++
  }
}

/** Merge-copy a sidecar directory (claude's `<session-id>/` subagents + tool-results).
 *  Existing target files are kept — sidecars are write-once artifacts, so absent-only
 *  is the safe merge. Not counted as a copy: `copied` means transcripts. */
function mergeDir(src: string, dst: string, out: SessionPoolResult): void {
  try {
    fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true })
  } catch {
    out.errors++
  }
}

// ── Claude Code: <home>/projects/<munged-cwd>/<session-id>.jsonl (+ sidecar dir) ──

function poolClaude(cwd: string, targetHome: string, sourceHomes: string[], out: SessionPoolResult, now: number): void {
  // The target project dir may already exist under a case-variant name — reuse it;
  // otherwise the exact munge is created on the first copy (the CLI accepts either).
  const targetDir = findClaudeProjectDir(targetHome, cwd) ?? join(targetHome, 'projects', claudeProjectDirName(cwd))
  for (const home of sourceHomes) {
    const srcDir = findClaudeProjectDir(home, cwd)
    if (!srcDir) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true })
    } catch {
      out.errors++
      continue
    }
    for (const e of entries) {
      if (e.isFile() && /\.jsonl$/i.test(e.name)) {
        copyIfNewer(join(srcDir, e.name), join(targetDir, e.name), out, now)
      } else if (e.isDirectory() && e.name !== 'memory') {
        // Session sidecars (subagent transcripts, spilled tool results) ride along with
        // their transcript; `memory/` is the PROJECT's auto-memory and stays the target
        // account's own — clobbering it would splice one account's notes into another's.
        try {
          if (!freshEnough(fs.statSync(join(srcDir, e.name)).mtimeMs, now)) continue
        } catch {
          continue
        }
        mergeDir(join(srcDir, e.name), join(targetDir, e.name), out)
      }
    }
  }
}

// ── Codex: <home>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, cwd in session_meta ──

function poolCodex(cwd: string, targetHome: string, sourceHomes: string[], out: SessionPoolResult, now: number): void {
  const want = pathKey(cwd)
  for (const home of sourceHomes) {
    for (const dayDir of codexDayDirs(home)) {
      let names: string[]
      try {
        names = fs.readdirSync(dayDir).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
      } catch {
        out.errors++
        continue
      }
      for (const name of names) {
        const src = join(dayDir, name)
        try {
          if (!freshEnough(fs.statSync(src).mtimeMs, now)) continue
        } catch {
          continue
        }
        const sessionCwd = readCodexSessionCwd(src)
        if (!sessionCwd || pathKey(sessionCwd) !== want) continue
        // Preserve the dated path — a rollout lives in the dir of its START date and
        // `codex resume` walks the same tree on the other side.
        copyIfNewer(src, join(targetHome, relative(home, src)), out, now)
      }
    }
  }
}

// ── Gemini: <home>/tmp/<slug>/chats/session-*.jsonl (+ /chat checkpoints) ──────────

function poolGemini(cwd: string, targetHome: string, sourceHomes: string[], out: SessionPoolResult, now: number): void {
  for (const home of sourceHomes) {
    const srcDir = findGeminiProjectDir(home, cwd)
    if (!srcDir) continue
    let dstDir = findGeminiProjectDir(targetHome, cwd)
    if (!dstDir) {
      // The target home has never seen this cwd. Replicate the SOURCE's slug (the
      // slug↔path map is persisted, not derivable) with the CLI's own breadcrumbs:
      // tmp/<slug>/.project_root plus the projects.json map entry, copied verbatim.
      const slug = basename(srcDir)
      dstDir = join(targetHome, 'tmp', slug)
      try {
        fs.mkdirSync(dstDir, { recursive: true })
        let root = cwd
        try {
          root = fs.readFileSync(join(srcDir, '.project_root'), 'utf8').trim() || cwd
        } catch {
          /* source breadcrumb absent — the launch cwd is the same truth */
        }
        fs.writeFileSync(join(dstDir, '.project_root'), root)
        const mapFile = join(targetHome, 'projects.json')
        let map: Record<string, unknown> = {}
        try {
          map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) as Record<string, unknown>
        } catch {
          /* absent or unreadable — start a fresh map */
        }
        if (!Object.entries(map).some(([abs, s]) => typeof s === 'string' && pathKey(abs) === pathKey(cwd))) {
          map[root] = slug
          fs.writeFileSync(mapFile, JSON.stringify(map, null, 2))
        }
      } catch {
        out.errors++
        continue
      }
    }
    try {
      for (const name of fs.readdirSync(join(srcDir, 'chats'))) {
        if (name.endsWith('.jsonl')) copyIfNewer(join(srcDir, 'chats', name), join(dstDir, 'chats', name), out, now)
      }
    } catch {
      /* no chats under this source — checkpoints may still exist */
    }
    try {
      for (const name of fs.readdirSync(srcDir)) {
        if (/^checkpoint.*\.json$/.test(name)) copyIfNewer(join(srcDir, name), join(dstDir, name), out, now)
      }
    } catch {
      out.errors++
    }
  }
}

const POOLERS: Record<
  string,
  (cwd: string, targetHome: string, sourceHomes: string[], out: SessionPoolResult, now: number) => void
> = {
  claude: poolClaude,
  codex: poolCodex,
  gemini: poolGemini
}

/**
 * Union `cwd`'s sessions from `sourceHomes` into `targetHome` for one provider, so the
 * launch the caller is about to build resumes/lists them as if they were born there.
 * Unknown providers and the target home itself are no-ops. Never throws.
 */
export function poolProviderSessions(
  provider: string,
  cwd: string,
  targetHome: string,
  sourceHomes: string[],
  now: number = Date.now()
): SessionPoolResult {
  const out: SessionPoolResult = { copied: 0, skipped: 0, errors: 0 }
  const pooler = POOLERS[provider]
  if (!pooler || !cwd || !targetHome) return out
  const target = normPath(targetHome)
  const seen = new Set<string>([target])
  const sources: string[] = []
  for (const home of sourceHomes) {
    if (!home) continue
    const key = normPath(home)
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(home.endsWith(sep) ? home.slice(0, -1) : home)
  }
  if (!sources.length) return out
  try {
    pooler(cwd, targetHome, sources, out, now)
  } catch {
    out.errors++
  }
  return out
}
