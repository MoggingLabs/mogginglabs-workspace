import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { asNum, pathKey, readTail, type TailReading } from './readers'

// The two providers that keep their usage somewhere other than a session-log tail.

// ── Aider ──────────────────────────────────────────────────────────────────────
// Aider is the one CLI here that displays NO context percentage at all. It prints
// "Tokens: 23k sent" after each call — rounded to the nearest 1k above 10k, so useless for an
// exact gauge — and computes a real figure only inside `/tokens`. So we take the source
// `/tokens` itself takes: the EXACT prompt token count, over litellm's max_input_tokens.
//
// Getting that count needs no cooperation from the user and no patching of aider. Every aider
// flag has an env twin (configargparse `auto_env_var_prefix="AIDER_"`), so AIDER_ANALYTICS_LOG
// names a JSONL file aider appends an exact `message_send` event to after every LLM call —
// flushed per event, and written even when analytics are DISABLED (the log file is assigned
// before any opt-in gating, and disable() never clears it). The daemon injects that var into
// every pane, so a HAND-TYPED aider reports exactly like a launched one — the thing claude's
// `--settings` relay cannot do.

/** The per-pane analytics log aider is pointed at. Same rendezvous as the claude sink: a path
 *  both sides DERIVE rather than exchange (tmpdir + username + pane id). */
export function aiderLogPath(paneId: number | string): string {
  return join(os.tmpdir(), `mogging-aider-${os.userInfo().username}`, `${paneId}.jsonl`)
}

/** The last exact prompt size aider reported for this pane, with the model it used (so the
 *  window is resolved from what actually ran, never from a guess). */
export function readAiderUsage(paneId: number | string): (TailReading & { mtimeMs: number }) | null {
  const file = aiderLogPath(paneId)
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    return null
  }
  const tail = readTail(file)
  if (tail === null) return null
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('message_send')) continue
    try {
      const o = JSON.parse(lines[i]) as { event?: string; properties?: Record<string, unknown> }
      if (o?.event !== 'message_send') continue
      const p = o.properties ?? {}
      const used = p.prompt_tokens
      if (typeof used !== 'number' || !Number.isFinite(used)) continue
      return { usedTokens: used, model: typeof p.main_model === 'string' ? p.main_model : undefined, mtimeMs }
    } catch {
      continue // a line cut at the tail window's edge, or a foreign shape
    }
  }
  return null
}

/** Aider's own denominator: litellm's `max_input_tokens`, which aider caches verbatim as plain
 *  JSON (24h TTL) — the very file `/tokens` divides by. Parsed once and re-read only when the
 *  cache is rewritten: it is a multi-MB catalogue and this runs on a 2.5s poll. */
let aiderModels: { mtimeMs: number; models: Record<string, { max_input_tokens?: number }> } | null = null
export function aiderWindowForModel(home: string, modelId: string | undefined): number | null {
  if (!modelId) return null
  const file = join(home, 'caches', 'model_prices_and_context_window.json')
  try {
    const mtimeMs = fs.statSync(file).mtimeMs
    if (!aiderModels || aiderModels.mtimeMs !== mtimeMs) {
      aiderModels = { mtimeMs, models: JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { max_input_tokens?: number }> }
    }
  } catch {
    return null // no cache, no denominator — and therefore no number (never a guessed one)
  }
  const entry = aiderModels.models[modelId] ?? aiderModels.models[modelId.replace(/^.*?\//, '')]
  const win = entry?.max_input_tokens
  return typeof win === 'number' && win > 0 ? win : null
}

// ── OpenCode ───────────────────────────────────────────────────────────────────
// OpenCode keeps everything in ONE SQLite database rather than per-session files. Its sidebar
// shows `N tokens / P% used`, where P is the LAST assistant message's five token fields summed,
// over the model's raw `limit.context`. It reserves nothing. (Its auto-compaction trigger uses
// a DIFFERENT, reserved formula — that one is not what the user is shown, so it is not ours.)
//
// Two traps, both checked against the real database on this machine:
//   - `session.tokens_*` are a LIFETIME accumulator (the projector adds to them on every
//     event). They grow past the context limit; a gauge built on them would read nonsense.
//   - the file is WAL. A reader that ignores the -wal sees stale or zero rows. Opened READ-ONLY
//     against the live file, SQLite reads the writer's WAL — which is precisely the case that
//     matters, since a gauge is only interesting while opencode is running.

interface Stmt {
  get(...args: unknown[]): unknown
  all(...args: unknown[]): unknown[]
}
interface Db {
  prepare(sql: string): Stmt
  close(): void
}

const SESSIONS_SQL = 'SELECT id, directory FROM session ORDER BY time_created DESC LIMIT 200'

/** The token columns, however this opencode names its message store. LIVE-VERIFIED against a
 *  real run: the shipped CLI writes to `message` (role + tokens inside a JSON `data` blob), NOT
 *  to `session_message` — which a fixture built on the documented schema could never have
 *  caught, because the fixture and the reader shared the same wrong assumption. Both shapes are
 *  accepted so a version change in either direction cannot blank the gauge. */
const TOKENS_COLS =
  "SELECT json_extract(data,'$.tokens.input') i," +
  " json_extract(data,'$.tokens.output') o," +
  " json_extract(data,'$.tokens.reasoning') r," +
  " json_extract(data,'$.tokens.cache.read') cr," +
  " json_extract(data,'$.tokens.cache.write') cw," +
  " COALESCE(json_extract(data,'$.providerID'), json_extract(data,'$.model.providerID')) p," +
  " COALESCE(json_extract(data,'$.modelID'), json_extract(data,'$.model.modelID')) m"

/** The shipped shape: one `message` row per turn, role inside the JSON. */
const MESSAGE_SQL =
  TOKENS_COLS +
  ' FROM message WHERE session_id = ?' +
  "   AND json_extract(data,'$.role') = 'assistant'" +
  "   AND json_extract(data,'$.tokens.output') > 0" +
  ' ORDER BY time_created DESC LIMIT 1'

/** The projected shape (role in a `type` column, ordered by `seq`). */
const SESSION_MESSAGE_SQL =
  TOKENS_COLS +
  " FROM session_message WHERE session_id = ? AND type = 'assistant'" +
  "   AND json_extract(data,'$.tokens.output') > 0" +
  ' ORDER BY seq DESC LIMIT 1'

/** The five fields opencode's own sidebar sums, from the newest answered assistant message of
 *  the session rooted at `cwd`. Null when opencode has never run there, or has yet to answer. */
export function readOpencodeUsage(home: string, cwd: string): (TailReading & { provider?: string }) | null {
  let db: Db
  try {
    // Required lazily: a native module, and a pane that never runs opencode must not load it.
    const Database = require('better-sqlite3') as new (p: string, o: object) => Db
    db = new Database(join(home, 'opencode.db'), { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
  try {
    const want = pathKey(cwd)
    // Matched in JS, not in SQL: the stored path's separators and case need not equal ours, and
    // pathKey is the equality rule the rest of this feature already uses.
    const sessions = db.prepare(SESSIONS_SQL).all() as Array<{ id: string; directory: string | null }>
    const session = sessions.find((s) => s.directory && pathKey(s.directory) === want)
    if (!session) return null
    type Row = { i?: number; o?: number; r?: number; cr?: number; cw?: number; p?: string; m?: string }
    let row: Row | undefined
    for (const sql of [MESSAGE_SQL, SESSION_MESSAGE_SQL]) {
      try {
        row = db.prepare(sql).get(session.id) as Row | undefined
      } catch {
        continue // that table does not exist in this version — try the other
      }
      if (row && typeof row.i === 'number') break
      row = undefined
    }
    if (!row || typeof row.i !== 'number') return null
    return {
      usedTokens: asNum(row.i) + asNum(row.o) + asNum(row.r) + asNum(row.cr) + asNum(row.cw),
      model: typeof row.m === 'string' ? row.m : undefined,
      provider: typeof row.p === 'string' ? row.p : undefined
    }
  } catch {
    return null
  } finally {
    try {
      db.close()
    } catch {
      /* already gone */
    }
  }
}

/** OpenCode's denominator: the models.dev catalogue it caches offline, indexed exactly as its
 *  sidebar indexes it — `models[providerID].models[modelID].limit.context`. */
let opencodeModels: { mtimeMs: number; catalog: Record<string, { models?: Record<string, { limit?: { context?: number } }> }> } | null = null
export function opencodeWindowFor(providerId: string | undefined, modelId: string | undefined, cacheFile?: string): number | null {
  if (!providerId || !modelId) return null
  const file = cacheFile ?? join(os.homedir(), '.cache', 'opencode', 'models.json')
  try {
    const mtimeMs = fs.statSync(file).mtimeMs
    if (!opencodeModels || opencodeModels.mtimeMs !== mtimeMs) {
      opencodeModels = { mtimeMs, catalog: JSON.parse(fs.readFileSync(file, 'utf8')) }
    }
  } catch {
    return null
  }
  const win = opencodeModels.catalog[providerId]?.models?.[modelId]?.limit?.context
  return typeof win === 'number' && win > 0 ? win : null
}
