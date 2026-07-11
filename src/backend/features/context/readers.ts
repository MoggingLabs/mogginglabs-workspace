import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

// Session-log readers for the per-pane context bar (see contracts/ipc/context.ipc.ts).
// ADR 0007 rule 3 applies verbatim: read the JSONL logs the CLIs ALREADY write, at their
// KNOWN locations, on demand, read-only — no network, no crawl, no watch. Log shapes
// dev-verified 2026-07-09 on this machine against live sessions:
//
// - Claude Code `<home>/projects/<munged-cwd>/<session>.jsonl`: `assistant` lines carry
//   `message.usage` `{ input_tokens, cache_read_input_tokens, cache_creation_input_tokens }`
//   + `message.model`. Used context = input + cache_read + cache_creation, output_tokens
//   EXCLUDED — that is the CLI's OWN display formula (dev-verified in the 2.1.205 bundle:
//   `h1n(usage, window)` sums exactly those three, rounds, clamps — and both the statusline
//   payload and the "% context used" footer ride it), so the bar's number always agrees
//   with what `/context` reports. Sidechain lines (`isSidechain: true`, Task subagents)
//   are skipped — they meter a DIFFERENT window. No line records the model's context
//   window; window.ts infers it (see there).
// - Codex `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`: line 1 is `session_meta` with
//   `payload.cwd` (how a rollout is matched to a pane); `event_msg` lines with
//   `payload.type === 'token_count'` carry `payload.info.last_token_usage.total_tokens`
//   (the last request's full prompt + response = current context) AND
//   `payload.info.model_context_window` — the window straight from the horse's mouth.
//
// Only COUNTS leave this module: token integers + a model id. Prompt text, tool output,
// and credentials never do (ADR 0002/0005).

/** Bytes read from the END of a session log per poll. The last assistant/token_count
 *  line lives in the final few KB; 256 KB survives even a pathological giant line
 *  between us and it. A line cut at the window's edge fails JSON.parse and is skipped. */
export const TAIL_BYTES = 256 * 1024

/** Read the last `bytes` of a file as utf8, or null when unreadable (gone, locked). */
export function readTail(file: string, bytes = TAIL_BYTES): string | null {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const len = Math.min(bytes, size)
      if (len === 0) return ''
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Read the first `bytes` of a file as utf8 (the baseline-seed scan reads session
 *  HEADS: the meta/user lines before the first assistant line can be sizable —
 *  file-history snapshots, pasted prompts — hence the generous default). */
export function readHead(file: string, bytes = 512 * 1024): string | null {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const len = Math.min(bytes, size)
      if (len === 0) return ''
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, 0)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/** One parsed context reading from a log tail. `windowTokens` only when the log states
 *  it (codex does; claude never does — its window is inferred in window.ts). */
export interface TailReading {
  usedTokens: number
  windowTokens?: number
  model?: string
}

// ── Claude Code ────────────────────────────────────────────────────────────────

/** Claude Code names each project dir by munging the session's launch cwd: every
 *  non-alphanumeric byte becomes '-'. Verified against real dirs on this machine:
 *  `C:\Users\pedro\...\Workspace` -> `C--Users-pedro-...-Workspace` and the worktree
 *  `...\Workspace\.mogging\worktrees\7466ee88` -> `...-Workspace--mogging-worktrees-7466ee88`. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Resolve the project dir for (home, cwd): exact munge first, then a case-insensitive
 *  scan — on Windows the drive letter's case can differ between what launched the CLI
 *  and what the CLI recorded. Null when the CLI has never run in this cwd. */
export function findClaudeProjectDir(home: string, cwd: string): string | null {
  const projects = join(home, 'projects')
  const wanted = claudeProjectDirName(cwd)
  const exact = join(projects, wanted)
  try {
    if (fs.statSync(exact).isDirectory()) return exact
  } catch {
    /* fall through to the scan */
  }
  try {
    const lower = wanted.toLowerCase()
    for (const name of fs.readdirSync(projects)) {
      if (name.toLowerCase() === lower) return join(projects, name)
    }
  } catch {
    /* no projects dir at all — the CLI has never run under this home */
  }
  return null
}

/** The project dirs a session launched AT `cwd` — or anywhere BELOW it — can live in.
 *
 *  For a DETECTED (hand-typed) session the pane's cwd is a hint, not a certainty: `cd sub &&
 *  claude` starts the CLI one directory deeper than the shell last reported, and its log then
 *  sits under the SUB-directory's project dir. The munge is a per-character map (readers'
 *  claudeProjectDirName), so a path prefix is a NAME prefix — a descendant's dir name is
 *  exactly `<parent's name>-<something>`. That makes "at or below this cwd" a precise string
 *  test, not a guess: an unrelated project can never match, and a parent never does either.
 *  Newest-modified first, so the caller's newest-wins lock reads naturally. */
export function claudeProjectDirs(home: string, cwd: string): string[] {
  const projects = join(home, 'projects')
  const wanted = claudeProjectDirName(cwd).toLowerCase() // Windows drive-letter case drifts
  const out: Array<{ dir: string; mtimeMs: number }> = []
  let names: string[]
  try {
    names = fs.readdirSync(projects)
  } catch {
    return [] // the CLI has never run under this home
  }
  for (const name of names) {
    const lower = name.toLowerCase()
    if (lower !== wanted && !lower.startsWith(wanted + '-')) continue
    const dir = join(projects, name)
    try {
      const st = fs.statSync(dir)
      if (st.isDirectory()) out.push({ dir, mtimeMs: st.mtimeMs })
    } catch {
      /* raced away */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).map((d) => d.dir)
}

/** Last main-chain assistant reading in a Claude session-log tail. Scanned from the END
 *  (the newest turn wins); unparseable/foreign lines are skipped, never thrown on. */
export function parseClaudeTail(tail: string): TailReading | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue // cheap prefilter
    try {
      const o = JSON.parse(line) as {
        type?: string
        isSidechain?: boolean
        message?: { model?: unknown; usage?: Record<string, unknown> }
      }
      if (o?.type !== 'assistant' || o.isSidechain) continue
      const u = o.message?.usage
      if (!u || typeof u.input_tokens !== 'number') continue
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      // The CLI's own h1n sum — output_tokens deliberately absent (see the header note).
      const usedTokens = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
      const model = typeof o.message?.model === 'string' ? o.message.model : undefined
      return { usedTokens, model }
    } catch {
      continue // partial first line of the tail window, or a foreign shape
    }
  }
  return null
}

/** FIRST main-chain assistant reading in a Claude session-log HEAD — a session's
 *  opening turn, whose input is dominated by the fixed baseline every session in
 *  this project starts from (system prompt + tools + CLAUDE.md). The baseline-seed
 *  path reads this off a PREVIOUS session to show a fresh pane the same number
 *  `/context` shows before any chat (see monitor.ts). Scanned FORWARD. */
export function parseClaudeHead(head: string): TailReading | null {
  const lines = head.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
    try {
      const o = JSON.parse(line) as {
        type?: string
        isSidechain?: boolean
        message?: { model?: unknown; usage?: Record<string, unknown> }
      }
      if (o?.type !== 'assistant' || o.isSidechain) continue
      const u = o.message?.usage
      if (!u || typeof u.input_tokens !== 'number') continue
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      const usedTokens = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
      const model = typeof o.message?.model === 'string' ? o.message.model : undefined
      return { usedTokens, model }
    } catch {
      continue // a line cut at the window's edge, or a foreign shape
    }
  }
  return null
}

// ── Statusline sink (claude) ───────────────────────────────────────────────────
// The app injects a statusline relay into claude launches (`--settings`, see
// src/main/context.ts): Claude Code then PUSHES its own context numbers — the
// pre-calculated `used_percentage` /context shows, and `context_window_size`, the
// TRUE window — into a per-pane file on every update. The relay runs inside the
// pane (it knows MOGGING_PANE_ID from the daemon's env injection) and this monitor
// runs in main, so the rendezvous is a WELL-KNOWN path neither has to be told:
// tmpdir + username + pane id. Counts and a model id only — never content.

export function contextSinkPath(paneId: number | string): string {
  return join(os.tmpdir(), `mogging-ctx-${os.userInfo().username}`, `${paneId}.json`)
}

export interface SinkReading {
  mtimeMs: number
  /** Claude's own used percentage — null before the session's first response. */
  usedPct: number | null
  windowTokens?: number
  usedTokens?: number
  model?: string
}

/** The pane's relay file, parsed. Null when absent/unreadable/foreign-shaped. */
export function readContextSink(paneId: number | string): SinkReading | null {
  const file = contextSinkPath(paneId)
  try {
    const st = fs.statSync(file)
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    return {
      mtimeMs: st.mtimeMs,
      usedPct: num(o.usedPct) ?? null,
      windowTokens: num(o.windowTokens),
      usedTokens: num(o.usedTokens),
      model: typeof o.model === 'string' && o.model ? o.model : undefined
    }
  } catch {
    return null
  }
}

// ── Codex ──────────────────────────────────────────────────────────────────────

/** Normalize a path for cwd EQUALITY only: one slash style, no trailing sep, lowercase.
 *  Lowercasing is for Windows (`c:\` vs `C:\` observed in real session_meta lines); the
 *  false-positive it admits elsewhere — two case-distinct dirs both running codex — is
 *  accepted. Never used to touch the filesystem. */
export function pathKey(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** First 256 KB is plenty for line 1: session_meta embeds the full base_instructions
 *  text (~10–20 KB observed). */
const META_BYTES = 256 * 1024

/** The cwd a Codex rollout was started in (its session_meta line). Falls back to a
 *  targeted regex when line 1 outgrows the read window. Null = unreadable/foreign. */
export function readCodexSessionCwd(file: string): string | null {
  let head: string
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const len = Math.min(META_BYTES, size)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, 0)
      head = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  const nl = head.indexOf('\n')
  const first = nl === -1 ? head : head.slice(0, nl)
  try {
    const o = JSON.parse(first) as { type?: string; payload?: { cwd?: unknown } }
    if (o?.type === 'session_meta' && typeof o.payload?.cwd === 'string') return o.payload.cwd
  } catch {
    /* line 1 longer than the window — regex the chunk instead */
  }
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(first)
  if (!m) return null
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return null
  }
}

/** The Codex day dirs (`<home>/sessions/YYYY/MM/DD`) that can hold a session started
 *  today or yesterday, LOCAL time (dir dates follow the local clock — verified: a
 *  16:14Z session sits in the 17:14 local date's dir). Existing dirs only. */
export function codexDayDirs(home: string, now: number): string[] {
  const dirs: string[] = []
  for (const backDays of [0, 1]) {
    const d = new Date(now - backDays * 86_400_000)
    const dir = join(
      home,
      'sessions',
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    )
    try {
      if (fs.statSync(dir).isDirectory()) dirs.push(dir)
    } catch {
      /* that day has no sessions */
    }
  }
  return dirs
}

/** Last token_count reading in a Codex rollout tail: the last request's total IS the
 *  current context, and the window rides the same line. */
export function parseCodexTail(tail: string): TailReading | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"token_count"')) continue
    try {
      const o = JSON.parse(line) as {
        type?: string
        payload?: {
          type?: string
          info?: {
            last_token_usage?: Record<string, unknown>
            model_context_window?: unknown
          } | null
        }
      }
      if (o?.type !== 'event_msg' || o.payload?.type !== 'token_count') continue
      const last = o.payload.info?.last_token_usage
      if (!last) continue // token_count lines with a null info block exist — skip, keep scanning
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      const usedTokens = typeof last.total_tokens === 'number' ? last.total_tokens : n(last.input_tokens) + n(last.output_tokens)
      const w = o.payload.info?.model_context_window
      const windowTokens = typeof w === 'number' && w > 0 ? w : undefined
      return { usedTokens, windowTokens }
    } catch {
      continue
    }
  }
  return null
}
