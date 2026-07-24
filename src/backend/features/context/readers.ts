import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { channelFromEnv, runtimeSegment } from '@contracts'

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

/** Finite number or 0 — the one coercion every parser in this file needs (it was
 *  re-declared inline four times). Exported for the sibling providers module. */
export const asNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

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

/** One main-chain assistant LINE parsed into a reading, or null when the line is a
 *  sidechain, cut at a read-window edge, or a foreign shape. The parsing is identical
 *  whichever end of the log the caller scans from — it was duplicated per direction
 *  once, and the two copies were one drifted field away from disagreeing. */
function parseClaudeLine(line: string): TailReading | null {
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return null // cheap prefilter
  try {
    const o = JSON.parse(line) as {
      type?: string
      isSidechain?: boolean
      message?: { model?: unknown; usage?: Record<string, unknown> }
    }
    if (o?.type !== 'assistant' || o.isSidechain) return null
    const u = o.message?.usage
    if (!u || typeof u.input_tokens !== 'number') return null
    // The CLI's own h1n sum — output_tokens deliberately absent (see the header note).
    const usedTokens = asNum(u.input_tokens) + asNum(u.cache_read_input_tokens) + asNum(u.cache_creation_input_tokens)
    const model = typeof o.message?.model === 'string' ? o.message.model : undefined
    return { usedTokens, model }
  } catch {
    return null
  }
}

/** Last main-chain assistant reading in a Claude session-log tail. Scanned from the END
 *  (the newest turn wins); unparseable/foreign lines are skipped, never thrown on. */
export function parseClaudeTail(tail: string): TailReading | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const reading = parseClaudeLine(lines[i])
    if (reading) return reading
  }
  return null
}

/** FIRST main-chain assistant reading in a Claude session-log HEAD — a session's
 *  opening turn, whose input is dominated by the fixed baseline every session in
 *  this project starts from (system prompt + tools + CLAUDE.md). The baseline-seed
 *  path reads this off a PREVIOUS session to show a fresh pane the same number
 *  `/context` shows before any chat (see monitor.ts). Scanned FORWARD. */
export function parseClaudeHead(head: string): TailReading | null {
  for (const line of head.split('\n')) {
    const reading = parseClaudeLine(line)
    if (reading) return reading
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
// tmpdir + username + runtime segment + pane id. Counts and a model id only — never content.
//
// The segment is runtimeSegment(channelFromEnv()) — the SAME channel/version namespace the
// socket, lock and endpoint use (src/pty-daemon/lifecycle.ts). Pane ids are per-app, so a dev
// build and an installed release both have a pane 1: keyed by username alone, their two relays
// overwrote each other's sink file, each app's bar then showed the OTHER instance's numbers
// (the sink outranks the transcript), and remove() unlinked the other's live sink. relay.ts
// derives this same dir inside the pane from the MOGGING_CHANNEL the daemon injected — the two
// derivations must stay identical.

export function contextSinkPath(paneId: number | string): string {
  const dir = `mogging-ctx-${os.userInfo().username}-${runtimeSegment(channelFromEnv())}`
  return join(os.tmpdir(), dir, `${paneId}.json`)
}

export interface SinkReading {
  mtimeMs: number
  /** Claude's own used percentage — null before the session's first response. */
  usedPct: number | null
  windowTokens?: number
  usedTokens?: number
  model?: string
  /** The exact session log Claude says this pane is in (statusline `transcript_path`) —
   *  lets the monitor lock identity instead of guessing it from mtimes. */
  transcriptPath?: string
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
      model: typeof o.model === 'string' && o.model ? o.model : undefined,
      transcriptPath: typeof o.transcriptPath === 'string' && o.transcriptPath ? o.transcriptPath : undefined
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

/** How many day dirs the codex scan reaches back over. A rollout lives in the dir of its
 *  START date and is appended to for as long as the session lives — a codex agent the
 *  detached daemon kept alive since Friday is still writing into FRIDAY's dir on Monday.
 *  Generating today+yesterday (what this used to do) could never see that file, so an
 *  adopted pane could never lock its session and showed no bar for the rest of its life.
 *  Ten days covers a long weekend or a holiday; the mtime freshness gates in monitor.ts
 *  still decide which of these rollouts are actually live. */
const MAX_DAY_DIRS = 10
/** Walk cap: a `sessions` tree with years of history must not turn one poll tick into a
 *  full-tree crawl. The newest month dirs hold the newest days, so the walk stops early. */
const MAX_MONTH_DIRS = 24

/** Numeric-named child dirs of `dir`, NEWEST first (names are zero-padded, so lexicographic
 *  descending IS newest-first). Empty when the dir is absent/unreadable. */
function dayTreeChildren(dir: string, width: number): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.length === width && /^\d+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => b.localeCompare(a))
  } catch {
    return [] // no sessions tree under this home
  }
}

/** The Codex day dirs (`<home>/sessions/YYYY/MM/DD`) worth scanning, newest first. The dirs
 *  that EXIST are enumerated rather than dates generated — see MAX_DAY_DIRS for why a
 *  today/yesterday window was a bug and not a saving. */
export function codexDayDirs(home: string): string[] {
  const root = join(home, 'sessions')
  const dirs: string[] = []
  let months = 0
  for (const year of dayTreeChildren(root, 4)) {
    for (const month of dayTreeChildren(join(root, year), 2)) {
      if (++months > MAX_MONTH_DIRS) return dirs
      for (const day of dayTreeChildren(join(root, year, month), 2)) {
        dirs.push(join(root, year, month, day))
        if (dirs.length >= MAX_DAY_DIRS) return dirs
      }
    }
  }
  return dirs
}

/** Last token_count reading in a Codex rollout tail: the last request's total IS the
 *  current context, and the window rides the same line.
 *
 *  Both numbers are the RAW ones codex logged — the percentage is NOT `used / window`. Codex
 *  reserves a fixed baseline before it divides (window.ts, codexPercentUsed), and its footer
 *  is that reserved figure. Anything else disagrees with what the pane is showing. */
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
      const usedTokens = typeof last.total_tokens === 'number' ? last.total_tokens : asNum(last.input_tokens) + asNum(last.output_tokens)
      const w = o.payload.info?.model_context_window
      const windowTokens = typeof w === 'number' && w > 0 ? w : undefined
      return { usedTokens, windowTokens }
    } catch {
      continue
    }
  }
  return null
}

// ── Gemini ─────────────────────────────────────────────────────────────────────
// Gemini CLI's ChatRecordingService writes one JSONL per session — unconditionally (no setting
// gates it) and with appendFileSync, so it lands the instant the data does:
//
//   <home>/tmp/<project-slug>/chats/session-<YYYY-MM-DDTHH-MM>-<sessionId8>.jsonl
//
// The number its footer shows is `usageMetadata.promptTokenCount`, recorded as `tokens.input`
// on `type: "gemini"` records. THE PARSING RULE THAT MATTERS: the same message id is appended
// TWICE — first with `"tokens": null` while the text streams, then again with the counts once
// the final chunk carries usageMetadata. So the reading is the last record with a NON-NULL
// `tokens.input`; a naive "last gemini record" reads the null and reports nothing, forever.
// (Verified against @google/gemini-cli 0.50.0 — packages/core/src/services/
// chatRecordingService.ts:674 — and against bytes produced by the published service itself.)

/** The project dir gemini keeps a cwd's sessions under. It is a SLUG, not a hash: the CLI maps
 *  lowercased-abs-path -> slug in `<home>/projects.json`, and drops the abs path into
 *  `<home>/tmp/<slug>/.project_root`. The map is read first (exact, one file); the reverse
 *  lookup covers a map that has not been written yet. Null = gemini has never run in this cwd. */
export function findGeminiProjectDir(home: string, cwd: string): string | null {
  const want = pathKey(cwd)
  try {
    const map = JSON.parse(fs.readFileSync(join(home, 'projects.json'), 'utf8')) as Record<string, unknown>
    for (const [abs, slug] of Object.entries(map)) {
      if (typeof slug !== 'string' || pathKey(abs) !== want) continue
      const dir = join(home, 'tmp', slug)
      try {
        if (fs.statSync(dir).isDirectory()) return dir
      } catch {
        break // the map named a dir that is gone — fall through to the scan
      }
    }
  } catch {
    /* no map, or unreadable */
  }
  try {
    for (const name of fs.readdirSync(join(home, 'tmp'))) {
      const dir = join(home, 'tmp', name)
      try {
        if (pathKey(fs.readFileSync(join(dir, '.project_root'), 'utf8').trim()) === want) return dir
      } catch {
        /* not a project dir */
      }
    }
  } catch {
    /* the CLI has never run under this home */
  }
  return null
}

/** The newest usage reading in a gemini session-log tail: the LAST record that actually carries
 *  counts (see the append-and-supersede note above). `usedTokens` is promptTokenCount — exactly
 *  what the CLI's own footer divides. */
export function parseGeminiTail(tail: string): TailReading | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"tokens"') || !line.includes('"gemini"')) continue // cheap prefilter
    try {
      const o = JSON.parse(line) as { type?: string; model?: unknown; tokens?: { input?: unknown } | null }
      if (o?.type !== 'gemini' || !o.tokens) continue
      const input = o.tokens.input
      if (typeof input !== 'number' || !Number.isFinite(input)) continue
      return { usedTokens: input, model: typeof o.model === 'string' ? o.model : undefined }
    } catch {
      continue // a line cut at the tail window's edge, or a foreign shape
    }
  }
  return null
}
