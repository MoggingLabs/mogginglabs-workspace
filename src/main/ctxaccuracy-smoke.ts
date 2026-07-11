import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { ContextMonitor, aiderLogPath, claudeWindowForModel, learnClaudeWindow } from '@backend/features/context'
import type { ContextUsage } from '@contracts'

// Env-gated CONTEXT-ACCURACY gate (MOGGING_CTXACCURACY). Windowless: no daemon, no pane. It
// runs the REAL ContextMonitor over session logs written in each CLI's REAL on-disk format, and
// asserts the one thing the gauge promises — THE NUMBER BESIDE THE PANE IS THE NUMBER INSIDE IT.
//
// Every percentage here is the CLI's own, reproduced from its own source:
//
//   claude  used / window, where used is the h1n sum (input + cache_read + cache_creation) and
//           window is what its statusline reports. Ground truth from this machine's live sink:
//           {"usedPct":31,"windowTokens":1000000,"usedTokens":305774,"model":"claude-opus-4-8[1m]"}
//           — and 305774/1000000 rounds to exactly 31.
//
//   codex   NOT used/window. Codex reserves BASELINE_TOKENS = 12000 and subtracts it from both
//           sides of the ratio (codex-rs/protocol/src/protocol.rs), and the window it logs is
//           already scaled to 95%. The fixture below is a REAL line from this machine's rollout
//           (14,922 tokens of a 258,400 window): codex's footer says "99% context left", so the
//           gauge must say 1% used. A naive used/window says 6% — the bug this gate exists for.
//
//   gemini  promptTokenCount / tokenLimit(model), the ratio its "N% used" footer prints. Its
//           recorder appends the SAME message twice — first with "tokens": null while the text
//           streams, then again with the counts — so the reading is the last record that
//           actually carries them. Reading the null instead blanks the gauge mid-answer; the
//           fixture ends on a null-token record precisely to prove we don't.
//
// Writes out/ctxaccuracy-result.json, then exits (0=pass, 1=fail).

interface Case {
  name: string
  provider: 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider'
  /** opencode reads its denominator from a models.dev cache; the gate points it at a fixture. */
  opencodeModels?: string
  /** The percentage that CLI would print for this exact log. */
  expectPct: number
  expectUsedTokens: number
  expectWindow: number
  /** What a naive `used/window` would have shown — recorded so a regression is legible. */
  naivePct?: number
  build: (home: string, cwd: string, paneId: number) => void
}

/** `C:\x\y` -> `C--x-y` (claude's project-dir munge). */
const claudeDirName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

const CASES: Case[] = [
  {
    name: 'claude: h1n sum over the statusline window',
    provider: 'claude',
    expectUsedTokens: 305_774, // 300000 + 5000 + 774
    expectWindow: 1_000_000,
    expectPct: 31, // 30.5774% -> 31, exactly what this machine's live statusline reported
    build: (home, cwd) => {
      const dir = join(home, 'projects', claudeDirName(cwd))
      mkdirSync(dir, { recursive: true })
      const line = {
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 300_000,
            cache_read_input_tokens: 5_000,
            cache_creation_input_tokens: 774,
            output_tokens: 999 // EXCLUDED from the sum — the CLI excludes it too
          }
        }
      }
      writeFileSync(join(dir, 'a1b2c3.jsonl'), JSON.stringify(line) + '\n')
    }
  },
  {
    name: 'codex: reserved-baseline formula (its footer says 99% left)',
    provider: 'codex',
    expectUsedTokens: 14_922,
    expectWindow: 258_400,
    expectPct: 1,
    naivePct: 6, // round(14922 / 258400 * 100) — what we used to show
    build: (home, cwd) => {
      const now = new Date(Date.now())
      const dir = join(
        home,
        'sessions',
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0')
      )
      mkdirSync(dir, { recursive: true })
      const meta = { type: 'session_meta', payload: { cwd } }
      // The real shape, copied from a rollout on this machine.
      const usage = {
        input_tokens: 14_714,
        cached_input_tokens: 4_480,
        output_tokens: 208,
        reasoning_output_tokens: 0,
        total_tokens: 14_922
      }
      const tokens = {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 258_400 }
        }
      }
      writeFileSync(join(dir, 'rollout-2026-07-11T00-00-00-abc.jsonl'), JSON.stringify(meta) + '\n' + JSON.stringify(tokens) + '\n')
    }
  },
  {
    name: 'gemini: promptTokenCount / limit, past a null-token record',
    provider: 'gemini',
    expectUsedTokens: 123_456,
    expectWindow: 1_048_576,
    expectPct: 12, // 11.77% -> 12 (its footer rounds the same way)
    build: (home, cwd) => {
      const slug = 'fixture-project-1'
      writeFileSync(join(home, 'projects.json'), JSON.stringify({ [cwd.toLowerCase()]: slug }))
      const dir = join(home, 'tmp', slug)
      mkdirSync(join(dir, 'chats'), { recursive: true })
      writeFileSync(join(dir, '.project_root'), cwd)
      const lines = [
        { sessionId: 's1', projectHash: 'deadbeef', kind: 'main' },
        { id: 'm1', type: 'user', content: 'hello' },
        // The answer streams in with no counts yet…
        { id: 'm2', type: 'gemini', content: 'hi', tokens: null, model: 'gemini-2.5-pro' },
        // …then is appended AGAIN once usageMetadata lands. This is the reading.
        {
          id: 'm2',
          type: 'gemini',
          content: 'hi',
          tokens: { input: 123_456, output: 67, cached: 1_000, thoughts: 42, tool: 7, total: 123_572 },
          model: 'gemini-2.5-pro'
        },
        // …and the NEXT answer starts streaming, counts not in yet. A parser that simply takes
        // the last gemini record reads this null and blanks the gauge. Ours must not.
        { id: 'm3', type: 'gemini', content: 'thinking…', tokens: null, model: 'gemini-2.5-pro' }
      ]
      writeFileSync(join(dir, 'chats', 'session-2026-07-11T00-00-abcd1234.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    }
  },
  {
    // Gemini does NOT clamp. Once a prompt outgrows the window its footer says "101% used", and
    // so must the header — a gauge that quietly reports 100% at the exact moment the context has
    // overflowed is lying in the one place it matters. (Verified against the shipped bundle:
    // 1,053,819 / 1,048,576 renders 101.)
    name: 'gemini: over the limit reads 101%, not a comfortable 100',
    provider: 'gemini',
    expectUsedTokens: 1_053_819,
    expectWindow: 1_048_576,
    expectPct: 101,
    build: (home, cwd) => {
      const slug = 'overflow-project'
      writeFileSync(join(home, 'projects.json'), JSON.stringify({ [cwd.toLowerCase()]: slug }))
      const dir = join(home, 'tmp', slug)
      mkdirSync(join(dir, 'chats'), { recursive: true })
      writeFileSync(join(dir, '.project_root'), cwd)
      const rec = {
        id: 'm9',
        type: 'gemini',
        content: 'x',
        tokens: { input: 1_053_819, output: 1, cached: 0, thoughts: 0, tool: 0, total: 1_053_820 },
        model: 'gemini-2.5-pro'
      }
      writeFileSync(join(dir, 'chats', 'session-2026-07-11T00-01-ffff0000.jsonl'), JSON.stringify(rec) + '\n')
    }
  },
  {
    // OPENCODE keeps everything in ONE SQLite store (WAL), keyed by the session's directory.
    // Its sidebar sums FIVE token fields of the last answered assistant message and divides by
    // the model's raw limit.context — reserving nothing. The fixture is built with the schema
    // read off the real database on this machine, in WAL mode with the rows left UNCHECKPOINTED,
    // because a reader that ignores the -wal sees zero rows and shows nothing at all.
    //
    // 90,000 + 1,200 + 800 + 40,000 + 8,000 = 140,000 of a 200,000 window -> 70%.
    // (limit.context 200000 = claude-opus-4-5, verified in this machine's models.dev cache.)
    name: 'opencode: five fields summed, over the raw limit (WAL, uncheckpointed)',
    provider: 'opencode',
    expectUsedTokens: 140_000,
    expectWindow: 200_000,
    expectPct: 70,
    opencodeModels: '', // filled in by build()
    build: (home, cwd) => {
      const Database = require('better-sqlite3') as new (p: string) => {
        pragma: (s: string) => unknown
        exec: (s: string) => void
        prepare: (s: string) => { run: (...a: unknown[]) => void }
        close: () => void
      }
      const db = new Database(join(home, 'opencode.db'))
      db.pragma('journal_mode = WAL')
      db.exec(
        'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER,' +
          ' tokens_input INTEGER, tokens_output INTEGER);' +
          'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);'
      )
      // The lifetime accumulators on `session` are deliberately absurd here: a gauge built on
      // them (the trap) would read 1000%+ instead of 70%.
      db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('sess-1', cwd, 1, 9_000_000, 9_000_000)
      const data = {
        providerID: 'anthropic',
        modelID: 'claude-opus-4-5',
        tokens: { input: 90_000, output: 1_200, reasoning: 800, cache: { read: 40_000, write: 8_000 } }
      }
      // An earlier step that has not been answered yet (output 0) must NOT be the reading.
      db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run(
        'm0',
        'sess-1',
        'assistant',
        1,
        JSON.stringify({ providerID: 'anthropic', modelID: 'claude-opus-4-5', tokens: { input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
      )
      db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('m1', 'sess-1', 'assistant', 2, JSON.stringify(data))
      db.close() // leaves the -wal in place, uncheckpointed — exactly the live shape
      writeFileSync(
        join(home, 'models.json'),
        JSON.stringify({ anthropic: { models: { 'claude-opus-4-5': { limit: { context: 200_000, output: 64_000 } } } } })
      )
    }
  },
  {
    // AIDER shows no percentage anywhere and rounds its printed token counts to the nearest 1k.
    // So the source is the analytics log every pane points it at (AIDER_ANALYTICS_LOG), whose
    // `message_send` events carry the EXACT prompt size — and litellm's cached max_input_tokens,
    // the same denominator `/tokens` uses. 47,500 / 200,000 = 23.75% -> 24%.
    // (The 1k-rounded line aider PRINTS would have said "48k sent" — i.e. 24%, but by luck.)
    name: 'aider: exact prompt_tokens from its own analytics log',
    provider: 'aider',
    expectUsedTokens: 47_500,
    expectWindow: 200_000,
    expectPct: 24,
    build: (home, _cwd, paneId) => {
      mkdirSync(join(home, 'caches'), { recursive: true })
      writeFileSync(
        join(home, 'caches', 'model_prices_and_context_window.json'),
        JSON.stringify({ 'claude-sonnet-4-5': { max_input_tokens: 200_000 } })
      )
      const log = aiderLogPath(paneId)
      mkdirSync(join(log, '..'), { recursive: true })
      const events = [
        { event: 'message_send', properties: { main_model: 'claude-sonnet-4-5', prompt_tokens: 12_000, completion_tokens: 80 }, time: 1 },
        // a later, unrelated event must not be mistaken for a reading
        { event: 'command_tokens', properties: {}, time: 2 },
        { event: 'message_send', properties: { main_model: 'claude-sonnet-4-5', prompt_tokens: 47_500, completion_tokens: 120 }, time: 3 }
      ]
      writeFileSync(log, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    }
  }
]

export async function runCtxAccuracySmoke(): Promise<void> {
  const results: Array<Record<string, unknown>> = []
  let pass = true
  try {
    const root = mkdtempSync(join(tmpdir(), 'mogging-ctxacc-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })

    const seen = new Map<number, ContextUsage | null>()
    const monitor = new ContextMonitor({ change: (paneId, usage) => seen.set(paneId, usage) }, 300)

    CASES.forEach((c, i) => {
      const home = join(root, c.provider + i)
      mkdirSync(home, { recursive: true })
      c.build(home, cwd, i + 1)
      monitor.setPane(i + 1, {
        provider: c.provider,
        cwd,
        home,
        opencodeModels: c.provider === 'opencode' ? join(home, 'models.json') : undefined
      })
    })

    // The monitor's first read is synchronous inside setPane; give its poll a couple of turns
    // anyway, so a slow filesystem cannot read as a wrong number.
    await new Promise((r) => setTimeout(r, 1200))
    monitor.dispose()

    CASES.forEach((c, i) => {
      const u = seen.get(i + 1) ?? null
      const ok =
        !!u &&
        u.usedPct === c.expectPct &&
        u.usedTokens === c.expectUsedTokens &&
        u.windowTokens === c.expectWindow &&
        u.provider === c.provider
      if (!ok) pass = false
      results.push({
        name: c.name,
        provider: c.provider,
        expected: { pct: c.expectPct, usedTokens: c.expectUsedTokens, window: c.expectWindow },
        got: u ? { pct: u.usedPct, usedTokens: u.usedTokens, window: u.windowTokens } : null,
        naiveWouldHaveShown: c.naivePct,
        ok
      })
    })

    // THE WINDOW A MODEL ID CANNOT SETTLE. A transcript says `claude-opus-4-8` whether the
    // session runs 200K or 1M — only the statusline knows, and only an app-launched pane has
    // one. So a relay reading TEACHES the window, and a hand-typed pane running the same model
    // then divides by the truth instead of by a documented guess.
    const beforeLearning = claudeWindowForModel('claude-opus-4-8')
    learnClaudeWindow('claude-opus-4-8[1m]', 640_000) // a window no table would ever contain
    const afterLearning = claudeWindowForModel('claude-opus-4-8') // the BARE id the transcript logs
    const learnOk = afterLearning === 640_000 && beforeLearning !== 640_000
    if (!learnOk) pass = false
    results.push({
      name: 'claude: a relay teaches the true window for the bare model id',
      beforeLearning,
      afterLearning,
      ok: learnOk
    })
  } catch (e) {
    pass = false
    results.push({ name: 'exception', error: String(e), ok: false })
  }
  try {
    writeFileSync(join(app.getAppPath(), 'out', 'ctxaccuracy-result.json'), JSON.stringify({ pass, cases: results }))
  } catch {
    /* best effort */
  }
  app.exit(pass ? 0 : 1)
}
