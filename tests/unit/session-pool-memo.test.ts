import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { poolProviderSessions } from '@backend/features/agents/session-pool'
import { claudeProjectDirName } from '@backend/features/context'
import { makeTempDir, removeTempDir } from './temp-dir'

// Pooling runs on EVERY local launch, and two of its steps were the launch path's
// heaviest filesystem work: codex answers "is this rollout ours?" by OPENING every
// rollout in the 30-day window (it keeps no per-project index), and claude's sidecar
// merge ran a recursive cpSync tree walk per sidecar even when every file was already
// there. Both are now remembered — and the memos must never cost correctness: the
// whole ADR-0013 continuity story (a capped session resuming under another profile
// with its FULL transcript) rests on this module copying what actually changed.

const scratch = makeTempDir('pool-memo-')
afterAll(() => removeTempDir(scratch))

let n = 0
const home = (): string => {
  const dir = join(scratch, `home-${n++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const UUID = '11111111-2222-3333-4444-555555555555'
const CWD = join(scratch, 'work', 'repo')
mkdirSync(CWD, { recursive: true })

// ── claude fixtures ────────────────────────────────────────────────────────────
/** The CLI's own project-dir munge — hand-rolling it here would test the fixture. */
const munge = (p: string): string => claudeProjectDirName(p)

const claudeSession = (h: string, id = UUID): string => {
  const dir = join(h, 'projects', munge(CWD))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, '{"type":"user"}\n')
  return file
}

const claudeSidecar = (h: string, files: Record<string, string>, id = UUID): string => {
  const dir = join(h, 'projects', munge(CWD), id)
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

describe('claude sidecar merge memo', () => {
  it('merges on first sight, and re-merges when a new sidecar entry appears', () => {
    const source = home()
    const target = home()
    claudeSession(source)
    const sidecar = claudeSidecar(source, { 'a.jsonl': 'A' })

    poolProviderSessions('claude', CWD, target, [source])
    const merged = join(target, 'projects', munge(CWD), UUID, 'a.jsonl')
    expect(readFileSync(merged, 'utf8')).toBe('A')

    // A new subagent transcript is a new ENTRY, which moves the sidecar dir's mtime.
    writeFileSync(join(sidecar, 'b.jsonl'), 'B')
    poolProviderSessions('claude', CWD, target, [source])
    expect(readFileSync(join(target, 'projects', munge(CWD), UUID, 'b.jsonl'), 'utf8')).toBe('B')
  })

  it('re-merges when the target sidecar was removed under it', () => {
    const source = home()
    const target = home()
    claudeSession(source)
    claudeSidecar(source, { 'a.jsonl': 'A' })
    poolProviderSessions('claude', CWD, target, [source])

    removeTempDir(join(target, 'projects', munge(CWD), UUID)) // the guarded remover
    poolProviderSessions('claude', CWD, target, [source])
    expect(readFileSync(join(target, 'projects', munge(CWD), UUID, 'a.jsonl'), 'utf8')).toBe('A')
  })

  it('still copies an APPENDED transcript — the memo never covers the session files', () => {
    // The failover case: the capped home's transcript grew after the last pool, and the
    // resumed session must see every exchange.
    const source = home()
    const target = home()
    const file = claudeSession(source)
    poolProviderSessions('claude', CWD, target, [source])
    const copied = join(target, 'projects', munge(CWD), `${UUID}.jsonl`)
    expect(readFileSync(copied, 'utf8')).toBe('{"type":"user"}\n')

    writeFileSync(file, '{"type":"user"}\n{"type":"assistant"}\n')
    const future = new Date(Date.now() + 60_000)
    utimesSync(file, future, future) // newer-wins compares mtime
    poolProviderSessions('claude', CWD, target, [source])
    expect(readFileSync(copied, 'utf8')).toContain('assistant')
  })
})

// ── codex fixtures ─────────────────────────────────────────────────────────────
const codexRollout = (h: string, name: string, sessionCwd: string): string => {
  const dir = join(h, 'sessions', '2026', '08', '02')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { cwd: sessionCwd } })}\n`)
  return file
}

describe('codex rollout cwd cache', () => {
  it('pools the rollouts whose cwd matches, and ignores foreign ones', () => {
    const source = home()
    const target = home()
    codexRollout(source, `rollout-2026-08-02T10-00-00-${UUID}.jsonl`, CWD)
    codexRollout(source, `rollout-2026-08-02T11-00-00-22222222-2222-3333-4444-555555555555.jsonl`, join(scratch, 'elsewhere'))

    const first = poolProviderSessions('codex', CWD, target, [source])
    expect(first.copied).toBe(1)

    // Second pool: every answer is cached, and the verdict must be identical.
    const second = poolProviderSessions('codex', CWD, target, [source])
    expect(second.copied).toBe(0) // already there, newer-wins skips
    expect(second.errors).toBe(0)
  })

  // THE re-copy bug this file found: `utimesSync` cannot reproduce a source's
  // fractional-millisecond mtime, and ~40% of copies landed a hair OLDER than their
  // source — failing `dst >= src` forever, so every launch re-copied whole transcripts.
  it('never re-copies an unchanged transcript, whichever way the mtime rounds', () => {
    const source = home()
    const target = home()
    for (let i = 0; i < 25; i++) {
      codexRollout(source, `rollout-2026-08-02T13-00-${String(i).padStart(2, '0')}-${UUID}.jsonl`, CWD)
    }
    expect(poolProviderSessions('codex', CWD, target, [source]).copied).toBe(25)
    const again = poolProviderSessions('codex', CWD, target, [source])
    expect(again.copied, 'nothing changed on disk — nothing should be copied').toBe(0)
    expect(again.skipped).toBe(25)
  })

  it('still copies a rollout that genuinely grew', () => {
    const source = home()
    const target = home()
    const file = codexRollout(source, `rollout-2026-08-02T14-00-00-${UUID}.jsonl`, CWD)
    poolProviderSessions('codex', CWD, target, [source])
    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { cwd: CWD } })}\n{"more":true}\n`)
    const future = new Date(Date.now() + 60_000)
    utimesSync(file, future, future)
    expect(poolProviderSessions('codex', CWD, target, [source]).copied).toBe(1)
  })

  it('re-reads a rollout whose head was not yet legible when first seen', () => {
    const source = home()
    const target = home()
    const dir = join(source, 'sessions', '2026', '08', '02')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2026-08-02T12-00-00-${UUID}.jsonl`)
    writeFileSync(file, '') // mid-write: no session_meta yet -> null cwd, cached as null

    expect(poolProviderSessions('codex', CWD, target, [source]).copied).toBe(0)

    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { cwd: CWD } })}\n`)
    // The size/mtime moved, so the null answer must be retried rather than trusted.
    expect(poolProviderSessions('codex', CWD, target, [source]).copied).toBe(1)
  })
})
