import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CostDay, CostScan } from '@contracts'

// The LOCAL cost scan (Phase-7/07, ADR 0007): parse the JSONL session logs
// Codex and Claude Code ALREADY write, at their KNOWN locations, ON DEMAND,
// read-only. Zero network, no crawl beyond the CLI's own log tree, no watch.
// Spend is a PRICE-TABLE ESTIMATE (documented public rates, dated in the
// books), never a bill: a record whose model has no price row still counts
// its TOKENS and the scan says so in `reason` — under-report honestly, never
// invent a number. Absent dir / empty window -> empty scan + reason, no throw.
//
// Log shapes dev-verified 2026-07-06 on this machine (books):
// - Codex `<home>/sessions/YYYY/MM/**/rollout-*.jsonl`: `session_meta` line
//   (cli 0.133 carries NO model id -> unpriced), then `event_msg` lines with
//   `payload.type === 'token_count'` and `payload.info.last_token_usage`
//   `{ input_tokens, cached_input_tokens, output_tokens, total_tokens }` per
//   turn; ISO `timestamp` per line. Summing last_token_usage = session total.
// - Claude Code `<home>/projects/<project>/<session>.jsonl`: `assistant`
//   lines with `message.usage` `{ input_tokens, output_tokens,
//   cache_creation_input_tokens, cache_read_input_tokens, cache_creation:
//   { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } }` and
//   `message.model`; streamed chunks DUPLICATE a message under one
//   `requestId` -> dedupe. Older CLIs wrote `costUSD` -> trusted verbatim.

/** Where each provider's session logs live under its config home. Only the
 *  two CLIs with dev-verified local logs — a provider absent here scans empty
 *  with a reason, it is never guessed at (ADR 0007 rule 3). */
export const COST_LOG_SUBDIR: Record<string, string> = {
  codex: 'sessions',
  claude: 'projects'
}

/** Resolve the log dir for (provider, home), or null when the provider has
 *  no known local cost source. */
export function costLogDir(providerId: string, home: string): string | null {
  const sub = COST_LOG_SUBDIR[providerId]
  return sub ? join(home, sub) : null
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
  ['claude-opus-4-1', { inPerMTok: 15, outPerMTok: 75 }],
  ['claude-opus-4-2025', { inPerMTok: 15, outPerMTok: 75 }], // opus 4.0 dated id
  ['claude-opus-4', { inPerMTok: 5, outPerMTok: 25 }], // 4.5 through 4.8
  ['claude-sonnet', { inPerMTok: 3, outPerMTok: 15 }],
  ['claude-haiku-4', { inPerMTok: 1, outPerMTok: 5 }],
  ['gpt-5', { inPerMTok: 1.25, outPerMTok: 10 }] // future codex logs that name a model
]

export function priceFor(model: unknown): ModelPrice | null {
  if (typeof model !== 'string' || !model) return null
  const m = model.toLowerCase()
  for (const [prefix, price] of MODEL_PRICES) if (m.startsWith(prefix)) return price
  return null
}

export interface CostScanOptions {
  /** Bounded scan window in days (default 30). */
  windowDays?: number
  /** Injected clock (IMPLEMENTATION.md rule — smokes pin time). */
  now?: () => number
}

const DEFAULT_WINDOW_DAYS = 30
const MAX_FILES = 400 // newest-first cap so a huge log tree stays bounded
const MAX_DEPTH = 6

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Local calendar date of an epoch-ms instant — a user's "per day" is theirs. */
function localDate(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The CLI's own log tree, bounded: .jsonl files newer than the cutoff. */
function listJsonl(root: string, cutoffMs: number): { file: string; mtime: number }[] {
  const out: { file: string; mtime: number }[] = []
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
      else if (name.endsWith('.jsonl') && st.mtimeMs >= cutoffMs) out.push({ file: p, mtime: st.mtimeMs })
    }
  }
  walk(root, 0)
  return out
}

interface DayAcc {
  spend: number
  tokens: number
}

/** Scan one provider's local logs into per-day spend/token sums. Pure parse
 *  over a bounded window; every failure path degrades to a labeled result. */
export function scanCost(providerId: string, logDir: string | null, opts: CostScanOptions = {}): CostScan {
  const currency = 'USD'
  if (!logDir) return { providerId, days: [], currency, reason: 'no local cost source for this provider' }
  if (!existsSync(logDir)) return { providerId, days: [], currency, reason: 'no local session logs at the known location' }

  const now = opts.now ?? Date.now
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS
  const cutoff = now() - windowDays * 86_400_000

  const found = listJsonl(logDir, cutoff)
  const capped = found.length > MAX_FILES
  const files = found.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES)

  const byDay = new Map<string, DayAcc>()
  let unpriced = false
  const add = (t: number, spend: number, tokens: number): void => {
    if (t < cutoff) return // record older than the window even in a fresh file
    const date = localDate(t)
    const acc = byDay.get(date) ?? { spend: 0, tokens: 0 }
    acc.spend += spend
    acc.tokens += tokens
    byDay.set(date, acc)
  }

  for (const f of files) {
    let lines: string[]
    try {
      lines = readFileSync(f.file, 'utf8').split('\n')
    } catch {
      continue // unreadable file: skip, never throw
    }
    if (providerId === 'claude') {
      // Streamed chunks duplicate an assistant message under one requestId.
      const seen = new Set<string>()
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
        const key = typeof o.requestId === 'string' ? o.requestId : typeof o.uuid === 'string' ? o.uuid : null
        if (key) {
          if (seen.has(key)) continue
          seen.add(key)
        }
        const inTok = num(usage.input_tokens)
        const outTok = num(usage.output_tokens)
        const cacheW = num(usage.cache_creation_input_tokens)
        const cacheR = num(usage.cache_read_input_tokens)
        const breakdown = usage.cache_creation as Record<string, unknown> | undefined
        const w5m = num(breakdown?.ephemeral_5m_input_tokens)
        const w1h = num(breakdown?.ephemeral_1h_input_tokens)
        let spend = 0
        if (typeof o.costUSD === 'number' && Number.isFinite(o.costUSD)) {
          spend = o.costUSD // older CLIs recorded it — the log's own number wins
        } else {
          const p = priceFor(msg?.model)
          if (p) {
            const write5 = w5m + w1h > 0 ? w5m : cacheW // no breakdown -> all at the 5m rate
            const write1h = w5m + w1h > 0 ? w1h : 0
            spend =
              (inTok * p.inPerMTok +
                outTok * p.outPerMTok +
                cacheR * p.inPerMTok * CACHE_READ_X +
                write5 * p.inPerMTok * CACHE_WRITE_5M_X +
                write1h * p.inPerMTok * CACHE_WRITE_1H_X) /
              1e6
          } else unpriced = true
        }
        add(t, spend, inTok + outTok + cacheW + cacheR)
      }
    } else {
      // codex rollout: sum each turn's last_token_usage.
      let price: ModelPrice | null = null
      for (const line of lines) {
        if (!line) continue
        let o: Record<string, unknown>
        try {
          o = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const payload = o?.payload as Record<string, unknown> | undefined
        if (o?.type === 'session_meta') {
          price = priceFor(payload?.model) // absent on cli 0.133 -> stays null
          continue
        }
        if (o?.type !== 'event_msg' || payload?.type !== 'token_count' || typeof o.timestamp !== 'string') continue
        const t = Date.parse(o.timestamp)
        if (Number.isNaN(t)) continue
        const info = payload.info as Record<string, unknown> | undefined
        const last = info?.last_token_usage as Record<string, unknown> | undefined
        if (!last) continue
        const inTok = num(last.input_tokens)
        const cached = num(last.cached_input_tokens)
        const outTok = num(last.output_tokens)
        const tokens = num(last.total_tokens) || inTok + outTok
        let spend = 0
        if (price) {
          spend =
            (Math.max(0, inTok - cached) * price.inPerMTok +
              cached * price.inPerMTok * CACHE_READ_X +
              outTok * price.outPerMTok) /
            1e6
        } else unpriced = true
        add(t, spend, tokens)
      }
    }
  }

  const days: CostDay[] = [...byDay.entries()]
    .map(([date, acc]) => ({ date, spend: Math.round(acc.spend * 1e6) / 1e6, tokens: acc.tokens }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  const notes: string[] = []
  if (!days.length) notes.push('no usage records in the scan window')
  if (unpriced) notes.push('some tokens had no price row — spend under-counts')
  if (capped) notes.push(`scan capped at the ${MAX_FILES} newest log files`)
  return notes.length ? { providerId, days, currency, reason: notes.join('; ') } : { providerId, days, currency }
}
