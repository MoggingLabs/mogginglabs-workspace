import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CostDay, CostModel, CostProject, CostScan } from '@contracts'

// The LOCAL cost scan (Phase-7/07, ADR 0007): parse the JSONL session logs
// Codex and Claude Code ALREADY write, at their KNOWN locations, ON DEMAND,
// read-only. No crawl beyond the CLI's own log tree, no watch. Spend is a
// PRICE-TABLE ESTIMATE (built-in rates dated in the books, optionally
// overridden by the models.dev catalog the CALLER fetched — this module
// itself still performs zero network), never a bill: a record whose model has
// no price row still counts its TOKENS and the scan says so in `reason` —
// under-report honestly, never invent a number. Absent dir / empty window ->
// empty scan + reason, no throw.
//
// Log shapes dev-verified 2026-07-06 on this machine (books), cross-checked
// against CodexBar 2026-07-09:
// - Codex `<home>/sessions/YYYY/MM/**/*.jsonl`: `session_meta` (may carry
//   `payload.model` + `payload.cwd` — the project), `turn_context` lines
//   carry the model on newer CLIs, then `event_msg` lines with
//   `payload.type === 'token_count'` and `payload.info.last_token_usage`.
// - Claude Code `<home>/projects/<project>/<session>.jsonl`: `assistant`
//   lines with `message.usage` + `message.model`; streamed chunks DUPLICATE
//   a message under one (message.id, requestId) — the LAST cumulative
//   snapshot wins. Older CLIs wrote `costUSD` -> trusted verbatim.

/** Where each provider's session logs live under its config home. Only the
 *  two CLIs with dev-verified local logs — a provider absent here scans empty
 *  with a reason, it is never guessed at (ADR 0007 rule 3). */
export const COST_LOG_SUBDIR: Record<string, string> = {
  codex: 'sessions',
  claude: 'projects'
}

/** Resolve the log dir for (provider, home), or null when the provider has
 *  no known local cost source. (The single-root form — `costLogDirs` below is
 *  what the app wires; this stays for callers that carry one dir.) */
export function costLogDir(providerId: string, home: string): string | null {
  const sub = COST_LOG_SUBDIR[providerId]
  return sub ? join(home, sub) : null
}

/** EVERY root a provider's sessions can live in (CodexBar parity): Codex keeps
 *  archived sessions in a sibling dir the old scan never read (a silent
 *  under-count for anyone who archives); Claude installs have been observed
 *  with logs split across `~/.claude` and `~/.config/claude` when the config
 *  home moved between CLI versions. Deduped; absent dirs are skipped at scan. */
export function costLogDirs(providerId: string, home: string): string[] {
  if (providerId === 'codex') return [...new Set([join(home, 'sessions'), join(home, 'archived_sessions')])]
  if (providerId === 'claude') {
    const dirs = [join(home, 'projects')]
    // A comma-separated CLAUDE_CONFIG_DIR names SEVERAL homes (CodexBar-observed).
    for (const d of (process.env.CLAUDE_CONFIG_DIR ?? '').split(',').map((s) => s.trim()).filter(Boolean)) dirs.push(join(d, 'projects'))
    dirs.push(join(homedir(), '.claude', 'projects'), join(homedir(), '.config', 'claude', 'projects'))
    // Claude DESKTOP keeps the same JSONL project logs under its own app-data
    // home — absent on most machines, skipped for free when it is.
    if (process.platform === 'win32' && process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'Claude', 'projects'))
    else if (process.platform === 'darwin') dirs.push(join(homedir(), 'Library', 'Application Support', 'Claude', 'projects'))
    else dirs.push(join(homedir(), '.config', 'Claude', 'projects'))
    return [...new Set(dirs)]
  }
  const one = costLogDir(providerId, home)
  return one ? [one] : []
}

// ── Price table: USD per 1M tokens, PREFIX-matched on the logged model id,
//    first match wins (order specific -> generic). Sources recorded in the
//    books with the date; an unknown model prices at 0 and flags the scan.
export interface ModelPrice {
  inPerMTok: number
  outPerMTok: number
}
/** Cache-token multipliers on the INPUT rate (documented provider pricing). */
export const CACHE_READ_X = 0.1
export const CACHE_WRITE_5M_X = 1.25
export const CACHE_WRITE_1H_X = 2

export const MODEL_PRICES: readonly (readonly [string, ModelPrice])[] = [
  ['claude-fable-5', { inPerMTok: 10, outPerMTok: 50 }],
  ['claude-mythos-5', { inPerMTok: 10, outPerMTok: 50 }],
  ['claude-mythos-preview', { inPerMTok: 10, outPerMTok: 50 }],
  ['claude-opus-4-1', { inPerMTok: 15, outPerMTok: 75 }],
  ['claude-opus-4-2025', { inPerMTok: 15, outPerMTok: 75 }], // opus 4.0 dated id
  ['claude-opus-4', { inPerMTok: 5, outPerMTok: 25 }], // 4.5 through 4.8
  ['claude-sonnet', { inPerMTok: 3, outPerMTok: 15 }],
  ['claude-haiku-4', { inPerMTok: 1, outPerMTok: 5 }],
  // The claude-3 family ids start "claude-3-…", which NONE of the prefixes
  // above match — every 3.x record silently landed in the unpriced bucket
  // (the flagged under-report). Public rates, dated with the rest (books).
  ['claude-3-7-sonnet', { inPerMTok: 3, outPerMTok: 15 }],
  ['claude-3-5-sonnet', { inPerMTok: 3, outPerMTok: 15 }],
  ['claude-3-5-haiku', { inPerMTok: 0.8, outPerMTok: 4 }],
  ['claude-3-opus', { inPerMTok: 15, outPerMTok: 75 }],
  ['claude-3-haiku', { inPerMTok: 0.25, outPerMTok: 1.25 }],
  // gpt-5 family (CodexBar-verified table, 2026-07-09) — order matters:
  // specific "gpt-5.N" rows must precede the generic "gpt-5" catch-all.
  ['gpt-5.4-mini', { inPerMTok: 0.75, outPerMTok: 4.5 }],
  ['gpt-5.4-nano', { inPerMTok: 0.2, outPerMTok: 1.25 }],
  ['gpt-5.4', { inPerMTok: 2.5, outPerMTok: 15 }],
  ['gpt-5.5', { inPerMTok: 5, outPerMTok: 30 }],
  ['gpt-5.2', { inPerMTok: 1.75, outPerMTok: 14 }],
  ['gpt-5.3', { inPerMTok: 1.75, outPerMTok: 14 }],
  ['gpt-5-mini', { inPerMTok: 0.25, outPerMTok: 2 }],
  ['gpt-5-nano', { inPerMTok: 0.05, outPerMTok: 0.4 }],
  ['gpt-5', { inPerMTok: 1.25, outPerMTok: 10 }] // gpt-5 / gpt-5.1 / *-codex variants + the unlabeled-session default
]

/** Prefix-match a model id against the live rows (models.dev, when the caller
 *  fetched them) FIRST, then the built-ins — live rates win, built-ins are the
 *  offline floor. */
export function priceFor(model: unknown, extra?: readonly (readonly [string, ModelPrice])[]): ModelPrice | null {
  if (typeof model !== 'string' || !model) return null
  const m = model.toLowerCase()
  if (extra) for (const [prefix, price] of extra) if (m.startsWith(prefix)) return price
  for (const [prefix, price] of MODEL_PRICES) if (m.startsWith(prefix)) return price
  return null
}

export interface CostScanOptions {
  /** Bounded scan window in days (default 30). */
  windowDays?: number
  /** Injected clock (IMPLEMENTATION.md rule — smokes pin time). */
  now?: () => number
  /** Live price rows (models.dev), consulted before the built-ins. */
  prices?: readonly (readonly [string, ModelPrice])[]
  /** Version tag for `prices` — a change invalidates the per-file cache
   *  (cached spend was computed at the old rates). */
  pricesRev?: string
}

const DEFAULT_WINDOW_DAYS = 30
const MAX_FILES = 400 // newest-first cap so a huge log tree stays bounded
const MAX_DEPTH = 6
const MAX_CACHED_FILES = 2000 // insertion-order eviction — a bound, not an LRU

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Local calendar date of an epoch-ms instant — a user's "per day" is theirs. */
function localDate(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The CLI's own log tree, bounded: .jsonl files newer than the cutoff. */
function listJsonl(root: string, cutoffMs: number): { file: string; mtime: number; size: number }[] {
  const out: { file: string; mtime: number; size: number }[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p, depth + 1)
      else if (name.endsWith('.jsonl') && st.mtimeMs >= cutoffMs) out.push({ file: p, mtime: st.mtimeMs, size: st.size })
    }
  }
  walk(root, 0)
  return out
}

// ── The per-file incremental cache (CodexBar's fast-rescan idea, file-grain):
//    a file whose (mtime, size) is unchanged re-uses its parsed contribution
//    instead of re-reading megabytes of JSONL. Contributions are keyed to the
//    price revision AND the cutoff DATE — new rates or a rolled-over window
//    re-parse honestly. Session logs append (mtime+size move), so a live file
//    self-invalidates; the bound keeps a huge tree from pinning memory.
interface CodexTotals {
  in: number
  cached: number
  out: number
  total: number
}

/** The codex parser's carry-over between a file's parsed head and its appended
 *  tail — what byte-offset resume must remember to keep delta accounting honest. */
interface CodexParseState {
  model: string
  project?: string
  prevTotals: CodexTotals | null
}

interface FileContrib {
  mtime: number
  size: number
  pricesRev: string
  cutoffDate: string
  days: [string, number, number][] // date, spend, tokens
  models: [string, number, number, boolean][] // model, spend, tokens, unpriced
  projects: [string, number, number][] // project, spend, tokens
  unpriced: boolean
  assumed: boolean
  /** Byte offset the parse reached (codex, newline-terminated files only) —
   *  an appended tail resumes HERE instead of re-reading megabytes. Absent =
   *  no resume for this file (claude, or an unterminated trailing line). */
  bytes?: number
  /** The parser carry-over at `bytes` (codex resume only). */
  codexState?: CodexParseState
}
const fileCache = new Map<string, FileContrib>()

interface ClaudeRec {
  t: number
  model: string
  inTok: number
  outTok: number
  cacheW: number
  cacheR: number
  w5m: number
  w1h: number
  costUSD?: number
}

/** The project a cwd belongs to, either separator. EPHEMERAL WORKTREES FOLD
 *  INTO THEIR PARENT: this app runs agents in `<repo>/.mogging/worktrees/<slug>`,
 *  and attributing spend to the slug would fragment one project across every
 *  run (the CodexBar `git worktree list` canonicalization, done structurally —
 *  a pure scanner spawns no git). External worktrees stay as their own name. */
const projectOf = (cwd: string): string => {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  const mog = parts.indexOf('.mogging')
  if (mog > 0 && parts[mog + 1] === 'worktrees') return parts[mog - 1]
  return parts[parts.length - 1] ?? cwd
}

interface ParseAcc {
  days: Map<string, { spend: number; tokens: number }>
  models: Map<string, { spend: number; tokens: number; unpriced: boolean }>
  projects: Map<string, { spend: number; tokens: number }>
  unpriced: boolean
  assumed: boolean
}

const newAcc = (): ParseAcc => ({ days: new Map(), models: new Map(), projects: new Map(), unpriced: false, assumed: false })

function accAdd(acc: ParseAcc, t: number, cutoffMs: number, spend: number, tokens: number, model: string, modelUnpriced: boolean, project?: string): void {
  if (t < cutoffMs) return // record older than the window even in a fresh file
  const date = localDate(t)
  const d = acc.days.get(date) ?? { spend: 0, tokens: 0 }
  d.spend += spend
  d.tokens += tokens
  acc.days.set(date, d)
  const m = acc.models.get(model) ?? { spend: 0, tokens: 0, unpriced: false }
  m.spend += spend
  m.tokens += tokens
  if (modelUnpriced) m.unpriced = true
  acc.models.set(model, m)
  if (project) {
    const p = acc.projects.get(project) ?? { spend: 0, tokens: 0 }
    p.spend += spend
    p.tokens += tokens
    acc.projects.set(project, p)
  }
}

function parseClaudeLines(lines: string[], cutoffMs: number, prices?: CostScanOptions['prices']): ParseAcc {
  const acc = newAcc()
  // Streamed chunks and retries DUPLICATE an assistant message — each
  // snapshot carries the usage SO FAR, and only the LAST one is complete.
  // Keeping the FIRST (the old rule) silently under-counted every streamed
  // response's output tokens. The CodexBar-verified key is message.id +
  // requestId; a log carrying only ONE of them keys on the one it has —
  // EITHER identifies the message across its chunks, while uuid is per LINE,
  // so reaching past a present message.id for it made every chunk its own
  // record and MULTIPLIED that message's spend by the chunk count. uuid is the
  // last resort; a row with no id at all is distinct — folding those would
  // drop real usage. Largest-output snapshot wins.
  const byKey = new Map<string, ClaudeRec>()
  let anon = 0
  for (const line of lines) {
    if (!line) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const msg = o?.message as Record<string, unknown> | undefined
    const usage = msg?.usage as Record<string, unknown> | undefined
    if (o?.type !== 'assistant' || !usage || typeof o.timestamp !== 'string') continue
    const t = Date.parse(o.timestamp)
    if (Number.isNaN(t)) continue
    const breakdown = usage.cache_creation as Record<string, unknown> | undefined
    const rec: ClaudeRec = {
      t,
      model: typeof msg?.model === 'string' && msg.model ? msg.model : 'unknown',
      inTok: num(usage.input_tokens),
      outTok: num(usage.output_tokens),
      cacheW: num(usage.cache_creation_input_tokens),
      cacheR: num(usage.cache_read_input_tokens),
      w5m: num(breakdown?.ephemeral_5m_input_tokens),
      w1h: num(breakdown?.ephemeral_1h_input_tokens),
      ...(typeof o.costUSD === 'number' && Number.isFinite(o.costUSD) ? { costUSD: o.costUSD } : {})
    }
    const msgId = typeof msg?.id === 'string' ? msg.id : null
    const reqId = typeof o.requestId === 'string' ? o.requestId : null
    const uuid = typeof o.uuid === 'string' ? o.uuid : null
    const key = msgId && reqId ? `${msgId}:${reqId}` : (msgId ?? reqId ?? uuid ?? `anon-${anon++}`)
    const prev = byKey.get(key)
    if (!prev || rec.outTok >= prev.outTok) byKey.set(key, rec)
  }
  for (const rec of byKey.values()) {
    let spend = 0
    let recUnpriced = false
    if (rec.costUSD !== undefined) {
      spend = rec.costUSD // older CLIs recorded it — the log's own number wins
    } else {
      const p = priceFor(rec.model, prices)
      if (p) {
        const write5 = rec.w5m + rec.w1h > 0 ? rec.w5m : rec.cacheW // no breakdown -> all at the 5m rate
        const write1h = rec.w5m + rec.w1h > 0 ? rec.w1h : 0
        spend =
          (rec.inTok * p.inPerMTok +
            rec.outTok * p.outPerMTok +
            rec.cacheR * p.inPerMTok * CACHE_READ_X +
            write5 * p.inPerMTok * CACHE_WRITE_5M_X +
            write1h * p.inPerMTok * CACHE_WRITE_1H_X) /
          1e6
      } else {
        // '<synthetic>' rows (system-injected, zero-ish usage) are not a
        // pricing gap — only flag models whose tokens actually went unpriced.
        const tokens = rec.inTok + rec.outTok + rec.cacheW + rec.cacheR
        if (tokens > 0 && rec.model !== '<synthetic>') {
          acc.unpriced = true
          recUnpriced = true
        }
      }
    }
    accAdd(acc, rec.t, cutoffMs, spend, rec.inTok + rec.outTok + rec.cacheW + rec.cacheR, rec.model, recUnpriced)
  }
  return acc
}

function parseCodexLines(
  lines: string[],
  cutoffMs: number,
  prices?: CostScanOptions['prices'],
  seed?: CodexParseState
): { acc: ParseAcc; state: CodexParseState } {
  const acc = newAcc()
  // codex rollout, DELTA-accounted (CodexBar parity): each token_count carries
  // both the turn's own `last_token_usage` and a cumulative
  // `total_token_usage`. Prefer TOTAL DIFFERENCES when they're consistent
  // (moved forward by at most this turn) — totals self-correct drift the
  // per-turn sums accumulate. Two guarded exceptions fall back to `last`:
  //   · the FIRST totals in a file — a forked/resumed session's counters
  //     CONTINUE the parent's, so counting the first total from zero would
  //     re-bill the whole parent conversation (the fork double-count);
  //   · divergent totals (backwards, or a jump bigger than the turn) — a
  //     replay/context injection, not new spend.
  // The model comes from session_meta OR turn_context (newer CLIs), latest
  // wins; a session that never names one prices at gpt-5 (the Codex default,
  // same fallback CodexBar ships) and says so in the label. `session_meta.cwd`
  // names the PROJECT (per-project cut).
  let model = seed?.model ?? ''
  let price: ModelPrice | null = model ? priceFor(model, prices) : null
  let project: string | undefined = seed?.project
  let prevTotals: CodexTotals | null = seed?.prevTotals ?? null
  for (const line of lines) {
    if (!line) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const payload = o?.payload as Record<string, unknown> | undefined
    if (o?.type === 'session_meta' || o?.type === 'turn_context') {
      const named =
        typeof payload?.model === 'string' && payload.model ? payload.model : typeof payload?.model_name === 'string' && payload.model_name ? payload.model_name : ''
      if (named) {
        model = named
        price = priceFor(named, prices)
      }
      if (typeof payload?.cwd === 'string' && payload.cwd) project = projectOf(payload.cwd)
      continue
    }
    if (o?.type !== 'event_msg' || payload?.type !== 'token_count' || typeof o.timestamp !== 'string') continue
    const t = Date.parse(o.timestamp)
    if (Number.isNaN(t)) continue
    const info = payload.info as Record<string, unknown> | undefined
    const last = info?.last_token_usage as Record<string, unknown> | undefined
    if (!last) continue
    // The turn's own usage — the fallback delta, and the consistency yardstick.
    let dIn = num(last.input_tokens)
    let dCached = num(last.cached_input_tokens)
    let dOut = num(last.output_tokens)
    let dTokens = num(last.total_tokens) || dIn + dOut
    const rawTotals = info?.total_token_usage as Record<string, unknown> | undefined
    if (rawTotals) {
      const T: CodexTotals = {
        in: num(rawTotals.input_tokens),
        cached: num(rawTotals.cached_input_tokens),
        out: num(rawTotals.output_tokens),
        total: num(rawTotals.total_tokens) || num(rawTotals.input_tokens) + num(rawTotals.output_tokens)
      }
      if (prevTotals) {
        const totalDelta = T.total - prevTotals.total
        if (totalDelta >= 0 && totalDelta <= dTokens) {
          dIn = Math.max(0, T.in - prevTotals.in)
          dCached = Math.max(0, T.cached - prevTotals.cached)
          dOut = Math.max(0, T.out - prevTotals.out)
          dTokens = totalDelta
        }
      }
      prevTotals = T
    } else if (prevTotals) {
      // A totals-less event between totals-carrying ones: advance the
      // watermark by what we just counted, or the next total-diff re-bills it.
      prevTotals = { in: prevTotals.in + dIn, cached: prevTotals.cached + dCached, out: prevTotals.out + dOut, total: prevTotals.total + dTokens }
    }
    const effPrice = price ?? priceFor('gpt-5', prices)
    const effModel = model || 'gpt-5 (assumed)'
    let spend = 0
    if (effPrice) {
      spend =
        (Math.max(0, dIn - dCached) * effPrice.inPerMTok + dCached * effPrice.inPerMTok * CACHE_READ_X + dOut * effPrice.outPerMTok) / 1e6
    }
    if (!model && dTokens > 0) acc.assumed = true
    accAdd(acc, t, cutoffMs, spend, dTokens, effModel, false, project)
  }
  return { acc, state: { model, ...(project !== undefined ? { project } : {}), prevTotals } }
}

const toContrib = (acc: ParseAcc, f: { mtime: number; size: number }, pricesRev: string, cutoffDate: string, bytes?: number, codexState?: CodexParseState): FileContrib => ({
  mtime: f.mtime,
  size: f.size,
  pricesRev,
  cutoffDate,
  days: [...acc.days.entries()].map(([d, v]) => [d, v.spend, v.tokens]),
  models: [...acc.models.entries()].map(([m, v]) => [m, v.spend, v.tokens, v.unpriced]),
  projects: [...acc.projects.entries()].map(([p, v]) => [p, v.spend, v.tokens]),
  unpriced: acc.unpriced,
  assumed: acc.assumed,
  ...(bytes !== undefined ? { bytes } : {}),
  ...(codexState !== undefined ? { codexState } : {})
})

/** Fold a prior contribution into a freshly-parsed tail's accumulators (the
 *  resume path: head numbers came from the cache, tail from the new bytes). */
function foldPrior(prior: FileContrib, acc: ParseAcc): ParseAcc {
  for (const [d, spend, tokens] of prior.days) {
    const v = acc.days.get(d) ?? { spend: 0, tokens: 0 }
    v.spend += spend
    v.tokens += tokens
    acc.days.set(d, v)
  }
  for (const [m, spend, tokens, unpriced] of prior.models) {
    const v = acc.models.get(m) ?? { spend: 0, tokens: 0, unpriced: false }
    v.spend += spend
    v.tokens += tokens
    if (unpriced) v.unpriced = true
    acc.models.set(m, v)
  }
  for (const [p, spend, tokens] of prior.projects) {
    const v = acc.projects.get(p) ?? { spend: 0, tokens: 0 }
    v.spend += spend
    v.tokens += tokens
    acc.projects.set(p, v)
  }
  if (prior.unpriced) acc.unpriced = true
  if (prior.assumed) acc.assumed = true
  return acc
}

/** Read [from, size) of a file — the appended tail, never the whole log. */
function readTail(file: string, from: number, size: number): { text: string; endsAtNewline: boolean; read: number } {
  const buf = Buffer.alloc(Math.max(0, size - from))
  const fd = openSync(file, 'r')
  let read = 0
  try {
    read = readSync(fd, buf, 0, buf.length, from)
  } finally {
    closeSync(fd)
  }
  const slice = buf.subarray(0, read)
  return { text: slice.toString('utf8'), endsAtNewline: read > 0 && slice[read - 1] === 0x0a, read }
}

/** Scan one provider's local logs into per-day / per-model / per-project
 *  sums, across EVERY root the provider writes (live + archived sessions,
 *  moved config homes). Pure parse over a bounded window (network-free —
 *  live prices arrive as DATA); every failure path degrades to a labeled
 *  result. Accepts one dir or a candidate list; absent dirs are skipped. */
export function scanCost(providerId: string, logDirs: string | string[] | null, opts: CostScanOptions = {}): CostScan {
  const currency = 'USD'
  const candidates = Array.isArray(logDirs) ? logDirs : logDirs ? [logDirs] : []
  if (!candidates.length) return { providerId, days: [], currency, reason: 'no local cost source for this provider' }
  const roots = [...new Set(candidates)].filter((d) => existsSync(d))
  if (!roots.length) return { providerId, days: [], currency, reason: 'no local session logs at the known location' }

  const now = opts.now ?? Date.now
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS
  const cutoff = now() - windowDays * 86_400_000
  const cutoffDate = localDate(cutoff)
  const pricesRev = opts.pricesRev ?? ''

  const found = roots.flatMap((root) => listJsonl(root, cutoff))
  const capped = found.length > MAX_FILES
  const files = found.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES)

  const byDay = new Map<string, { spend: number; tokens: number }>()
  const byModel = new Map<string, { spend: number; tokens: number; unpriced: boolean }>()
  const byProject = new Map<string, { spend: number; tokens: number }>()
  let unpriced = false
  let assumedPricing = false

  for (const f of files) {
    let contrib = fileCache.get(f.file)
    const envSame = !!contrib && contrib.pricesRev === pricesRev && contrib.cutoffDate === cutoffDate
    const unchanged = envSame && contrib?.mtime === f.mtime && contrib?.size === f.size
    if (!unchanged) {
      // Byte-offset resume (codex, CodexBar's fast-rescan): a GROWN file whose
      // parsed head ended exactly at a newline re-reads only the appended tail,
      // seeding the parser with the head's carry-over (model/project/totals).
      // Anything else — claude files, shrunk/rewritten files, an unterminated
      // trailing line last time — re-parses whole, which is always correct.
      const prior = envSame ? contrib : undefined
      const resumable =
        providerId !== 'claude' && !!prior && prior.bytes !== undefined && prior.codexState !== undefined && prior.bytes === prior.size && f.size > prior.size
      try {
        if (resumable && prior) {
          const tail = readTail(f.file, prior.bytes as number, f.size)
          const { acc, state } = parseCodexLines(tail.text.split('\n'), cutoff, opts.prices, prior.codexState)
          const merged = foldPrior(prior, acc)
          contrib = tail.endsAtNewline
            ? toContrib(merged, f, pricesRev, cutoffDate, (prior.bytes as number) + tail.read, state)
            : toContrib(merged, f, pricesRev, cutoffDate) // mid-write tail: full re-parse next time
        } else {
          const buf = readFileSync(f.file)
          const endsAtNewline = buf.length > 0 && buf[buf.length - 1] === 0x0a
          const lines = buf.toString('utf8').split('\n')
          if (providerId === 'claude') {
            contrib = toContrib(parseClaudeLines(lines, cutoff, opts.prices), f, pricesRev, cutoffDate)
          } else {
            const { acc, state } = parseCodexLines(lines, cutoff, opts.prices)
            contrib = endsAtNewline ? toContrib(acc, f, pricesRev, cutoffDate, buf.length, state) : toContrib(acc, f, pricesRev, cutoffDate)
          }
        }
      } catch {
        continue // unreadable file: skip, never throw
      }
      fileCache.set(f.file, contrib)
      if (fileCache.size > MAX_CACHED_FILES) {
        const oldest = fileCache.keys().next().value
        if (oldest) fileCache.delete(oldest)
      }
    }
    if (!contrib) continue
    for (const [date, spend, tokens] of contrib.days) {
      const d = byDay.get(date) ?? { spend: 0, tokens: 0 }
      d.spend += spend
      d.tokens += tokens
      byDay.set(date, d)
    }
    for (const [model, spend, tokens, mu] of contrib.models) {
      const m = byModel.get(model) ?? { spend: 0, tokens: 0, unpriced: false }
      m.spend += spend
      m.tokens += tokens
      if (mu) m.unpriced = true
      byModel.set(model, m)
    }
    for (const [project, spend, tokens] of contrib.projects) {
      const p = byProject.get(project) ?? { spend: 0, tokens: 0 }
      p.spend += spend
      p.tokens += tokens
      byProject.set(project, p)
    }
    if (contrib.unpriced) unpriced = true
    if (contrib.assumed) assumedPricing = true
  }

  const days: CostDay[] = [...byDay.entries()]
    .map(([date, acc]) => ({ date, spend: Math.round(acc.spend * 1e6) / 1e6, tokens: acc.tokens }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  const models: CostModel[] = [...byModel.entries()]
    .map(([model, m]) => ({ model, spend: Math.round(m.spend * 1e6) / 1e6, tokens: m.tokens, ...(m.unpriced ? { unpriced: true } : {}) }))
    .sort((a, b) => b.spend - a.spend || b.tokens - a.tokens)
  const projects: CostProject[] = [...byProject.entries()]
    .map(([project, p]) => ({ project, spend: Math.round(p.spend * 1e6) / 1e6, tokens: p.tokens }))
    .sort((a, b) => b.spend - a.spend || b.tokens - a.tokens)

  const notes: string[] = []
  if (!days.length) notes.push('no usage records in the scan window')
  if (unpriced) notes.push('some tokens had no price row — spend under-counts')
  if (assumedPricing) notes.push('unlabeled sessions priced at gpt-5 rates')
  if (capped) notes.push(`scan capped at the ${MAX_FILES} newest log files`)
  const base: CostScan = {
    providerId,
    days,
    ...(models.length ? { models } : {}),
    ...(projects.length ? { projects } : {}),
    currency
  }
  return notes.length ? { ...base, reason: notes.join('; ') } : base
}
