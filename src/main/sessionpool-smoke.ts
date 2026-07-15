// Env-gated session-pool smoke (MOGGING_SESSIONPOOL=1) — windowless, fixture homes, no daemon.
//
// Gates "sessions follow profiles" (ADR 0013): a usage-limit failover relaunches the agent on
// a FALLBACK profile, which is a separate CLI config home — and the CLIs keep their session
// transcripts inside the home, so without pooling the fallback resumes NOTHING and the agent
// wakes up amnesiac. poolProviderSessions unions the launch cwd's sessions from the provider's
// other homes into the launch home, at each CLI's own documented paths, so the CLI's own
// resume machinery simply sees them.
//
// Every assert encodes one of the module's stated rules, because each rule is a way the
// feature can silently rot:
//   newer wins        a stale copy must never shadow the transcript the user actually has;
//                     preserved mtimes are what keep the comparison meaningful on the NEXT
//                     pool (a copy stamped "now" would win forever).
//   memory stays home claude's projects/<cwd>/memory/ is the ACCOUNT's auto-memory —
//                     pooling it would splice one account's notes into another's.
//   no secrets       .credentials.json lives in the same home and must never ride along.
//   freshness         transcripts older than the CLI's own retention are not copied — the
//                     first failover must not exhume a workspace's whole history.
//   dated paths       a codex rollout lives in the dir of its START date; `codex resume`
//                     walks the same tree on the other side.
//   cwd scoping       only the LAUNCH cwd's sessions move (codex rollouts carry their cwd in
//                     session_meta; a different project's rollout stays put).
//   resume identity   resumeSessionIdFromFile: uuid-shaped ids only — anything else must
//                     never enter a typed command line.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { poolProviderSessions, resumeSessionIdFromFile } from '@backend/features/agents/session-pool'
import { claudeProjectDirName } from '@backend/features/context'

const DAY = 24 * 60 * 60_000

export async function runSessionPoolSmoke(): Promise<void> {
  const write = (o: object): void => {
    try {
      const out = path.join(app.getAppPath(), 'out')
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'sessionpool-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  setTimeout(() => {
    write({ pass: false, error: 'TIMEOUT' })
    app.exit(1)
  }, 30_000)

  const r: Record<string, unknown> = {}
  try {
    const now = Date.now()
    const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'))
    const cwd = path.join(fx, 'repo')
    const munge = claudeProjectDirName(cwd)
    const A = path.join(fx, 'homeA') // the capped profile's home (source)
    const B = path.join(fx, 'homeB') // the fallback's home (target)
    const aProj = path.join(A, 'projects', munge)
    const mk = (file: string, text: string, ageDays: number): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
      const t = new Date(now - ageDays * DAY)
      fs.utimesSync(file, t, t)
    }

    const uuid = '11111111-2222-3333-4444-555555555555'
    mk(path.join(aProj, `${uuid}.jsonl`), 'fresh-transcript', 1)
    mk(path.join(aProj, 'stale.jsonl'), 'too-old', 40) // outside retention
    mk(path.join(aProj, uuid, 'tool-result.json'), 'sidecar', 1) // rides along
    mk(path.join(aProj, 'memory', 'MEMORY.md'), 'account-private-notes', 1) // must stay
    mk(path.join(A, '.credentials.json'), 'SECRET', 1) // never a candidate

    // ── claude: fresh transcript + sidecar pool; memory, secrets, stale stay ──
    const res1 = poolProviderSessions('claude', cwd, B, [A], now)
    const bProj = path.join(B, 'projects', munge)
    r.claudeCopied = res1.copied === 1 && fs.readFileSync(path.join(bProj, `${uuid}.jsonl`), 'utf8') === 'fresh-transcript'
    r.claudeSidecarRode = fs.existsSync(path.join(bProj, uuid, 'tool-result.json'))
    r.claudeMemoryStayedHome = !fs.existsSync(path.join(bProj, 'memory'))
    r.claudeSecretsStayedHome = !fs.existsSync(path.join(B, '.credentials.json'))
    r.claudeStaleStayedHome = !fs.existsSync(path.join(bProj, 'stale.jsonl'))
    // mtime preserved, so newer-wins keeps meaning something on the NEXT pool
    r.claudeMtimePreserved =
      Math.abs(fs.statSync(path.join(bProj, `${uuid}.jsonl`)).mtimeMs - fs.statSync(path.join(aProj, `${uuid}.jsonl`)).mtimeMs) < 2000

    // ── newer wins, both directions ──
    fs.writeFileSync(path.join(bProj, `${uuid}.jsonl`), 'target-progress') // simulate work on B
    const tNew = new Date(now)
    fs.utimesSync(path.join(bProj, `${uuid}.jsonl`), tNew, tNew)
    const res2 = poolProviderSessions('claude', cwd, B, [A], now)
    r.newerTargetKept = res2.skipped >= 1 && fs.readFileSync(path.join(bProj, `${uuid}.jsonl`), 'utf8') === 'target-progress'
    mk(path.join(aProj, `${uuid}.jsonl`), 'source-advanced', 0) // A moves ahead
    poolProviderSessions('claude', cwd, B, [A], now)
    r.newerSourceWins = fs.readFileSync(path.join(bProj, `${uuid}.jsonl`), 'utf8') === 'source-advanced'

    // ── target dedup: pooling a home into itself is a no-op ──
    const res3 = poolProviderSessions('claude', cwd, B, [B, ''], now)
    r.selfPoolNoop = res3.copied === 0 && res3.skipped === 0 && res3.errors === 0

    // ── codex: cwd scoping + the dated path survives the trip ──
    const cUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const dated = path.join('sessions', '2026', '07', '14')
    const rollout = `rollout-2026-07-14T10-00-00-${cUuid}.jsonl`
    mk(
      path.join(A, dated, rollout),
      JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n{"type":"turn"}',
      1
    )
    mk(
      path.join(A, dated, `rollout-2026-07-14T11-00-00-${uuid}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { cwd: path.join(fx, 'OTHER-project') } }) + '\n{}',
      1
    )
    const res4 = poolProviderSessions('codex', cwd, B, [A], now)
    r.codexDatedPathKept = res4.copied === 1 && fs.existsSync(path.join(B, dated, rollout))
    r.codexForeignCwdStayed = !fs.existsSync(path.join(B, dated, `rollout-2026-07-14T11-00-00-${uuid}.jsonl`))

    // ── resume identity: uuid-shaped or nothing ──
    r.resumeClaude = resumeSessionIdFromFile('claude', path.join('x', `${uuid}.jsonl`)) === uuid
    r.resumeCodex = resumeSessionIdFromFile('codex', path.join('x', rollout)) === cUuid
    r.resumeRejectsNonUuid = resumeSessionIdFromFile('claude', path.join('x', 'notes.jsonl')) === null
    r.resumeGeminiBare = resumeSessionIdFromFile('gemini', path.join('x', 'session-1.jsonl')) === null

    // ── unknown provider: total no-op, never a throw ──
    const res5 = poolProviderSessions('aider', cwd, B, [A], now)
    r.unknownProviderNoop = res5.copied === 0 && res5.errors === 0

    const pass = Object.values(r).every((v) => v === true)
    write({ pass, ...r })
    app.exit(pass ? 0 : 1)
  } catch (e) {
    write({ pass: false, error: String(e), ...r })
    app.exit(1)
  }
}
