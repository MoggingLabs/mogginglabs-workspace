import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextMonitor, type ContextPaneSpec } from '@backend/features/context/monitor'
import { claudeProjectDirName, contextSinkPath } from '@backend/features/context/readers'
import type { ContextUsage } from '@contracts'

// The session-log LOCK arbitration — the part of the context gauge that decides WHICH
// file is a pane's session. The failure this tier exists to prevent was found live
// 2026-07-23: two claude panes in one cwd, and the idle locked pane stole the new
// pane's session log one tick before it could lock it — the new pane then showed
// "waiting for the session's first response" forever while the old one wore its
// numbers. Rules under test: reserve (a locked pane may not migrate onto a fresh
// pane's claim), takeover (the sharper unlocked claimant wins a heuristic lock),
// pin (the relay's transcript_path is exact identity and beats every heuristic).

// Pane ids far outside anything a real app run uses: the claude sink rendezvous is a
// REAL per-user tmp dir, and colliding with a live app's pane 1 would read its sink.
const P1 = 990_101
const P2 = 990_102

const assistantLine = (usedTokens: number): string =>
  JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5', usage: { input_tokens: usedTokens } } }) + '\n'

/** Write a claude session log holding one main-chain assistant turn, mtime pinned. */
function writeLog(dir: string, name: string, usedTokens: number, mtimeMs: number): string {
  const file = join(dir, name)
  writeFileSync(file, assistantLine(usedTokens))
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  return file
}

const roots: string[] = []
function fixture(): { cwd: string; home: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'mog-ctxmon-unit-'))
  roots.push(root)
  const cwd = join(root, 'repo')
  const home = join(root, 'home')
  const project = join(home, 'projects', claudeProjectDirName(cwd))
  mkdirSync(project, { recursive: true })
  return { cwd, home, project }
}

interface Rig {
  monitor: ContextMonitor
  seen: Map<number, ContextUsage | null>
  spec: (over?: Partial<ContextPaneSpec>) => ContextPaneSpec
}

function rig(f: { cwd: string; home: string }, pollMs = 40): Rig {
  const seen = new Map<number, ContextUsage | null>()
  const monitor = new ContextMonitor({ change: (paneId, usage) => seen.set(paneId, usage) }, pollMs)
  return {
    monitor,
    seen,
    spec: (over = {}) => ({ provider: 'claude', cwd: f.cwd, home: f.home, ...over })
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let active: ContextMonitor | null = null
afterEach(() => {
  active?.dispose()
  active = null
  try {
    // Sinks live OUTSIDE the fixture root (the real rendezvous dir) — sweep ours.
    for (const id of [P1, P2]) rmSync(contextSinkPath(id), { force: true })
  } catch {
    /* never wrote one */
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('context monitor lock arbitration', () => {
  it('reserve: a locked pane does not steal the session log a fresh unlocked pane is about to claim', async () => {
    const f = fixture()
    const { monitor, seen, spec } = rig(f)
    active = monitor
    const now = Date.now()
    writeLog(f.project, 'a.jsonl', 100_000, now - 60_000)
    monitor.setPane(P1, spec({ since: now - 120_000 }))
    expect(seen.get(P1)?.usedTokens).toBe(100_000) // P1 locked its own session

    // P2's agent just launched (sharp floor); its log has not landed yet.
    monitor.setPane(P2, spec({ since: now - 2_000 }))
    // Now the new session's log appears, strictly newer than P1's idle lock —
    // exactly what P1's migrate rule used to swallow one tick ahead of P2.
    const fileB = writeLog(f.project, 'b.jsonl', 555_000, now)
    await sleep(200)

    expect(monitor.sessionFor(P2)?.file).toBe(fileB)
    expect(seen.get(P2)?.usedTokens).toBe(555_000)
    expect(seen.get(P1)?.usedTokens).toBe(100_000) // never migrated, never blanked
  })

  it('takeover: the sharper unlocked claimant reclaims a heuristic lock; the loser goes honest-null', async () => {
    const f = fixture()
    const { monitor, seen, spec } = rig(f)
    active = monitor
    const now = Date.now()
    // An adopted pane (blind 30-minute floor) grabbed the only fresh log around…
    const fileB = writeLog(f.project, 'b.jsonl', 555_000, now - 10_000)
    monitor.setPane(P1, spec({ adopted: true }))
    expect(monitor.sessionFor(P1)?.file).toBe(fileB)
    // …but that log belongs to the pane whose watch floor actually admits it.
    monitor.setPane(P2, spec({ since: now - 15_000 }))
    expect(monitor.sessionFor(P2)?.file).toBe(fileB)
    expect(seen.get(P2)?.usedTokens).toBe(555_000)
    expect(monitor.sessionFor(P1)).toBeUndefined()
    expect(seen.get(P1)).toBeNull() // unlocked out loud, not left wearing P2's numbers
  })

  it('pin: the relay transcript_path is exact identity — no migration to a newer sibling log', async () => {
    const f = fixture()
    const { monitor, seen, spec } = rig(f)
    active = monitor
    const now = Date.now()
    const fileA = writeLog(f.project, 'a.jsonl', 120_000, now - 60_000)
    writeLog(f.project, 'b.jsonl', 555_000, now) // newer — the heuristic would take it
    const sink = contextSinkPath(P1)
    mkdirSync(dirname(sink), { recursive: true })
    writeFileSync(
      sink,
      JSON.stringify({ usedPct: 12, windowTokens: 1_000_000, usedTokens: 120_000, model: 'claude-fable-5', transcriptPath: fileA })
    )
    monitor.setPane(P1, spec({ since: now - 120_000 }))
    await sleep(150)
    expect(monitor.sessionFor(P1)?.file).toBe(fileA)
    expect(seen.get(P1)?.usedTokens).toBe(120_000) // the sink's own numbers, for the pinned session
  })

  it('a true process-start floor lets a long-idle adopted session lock past the 30-minute guess', () => {
    const f = fixture()
    const { monitor, seen, spec } = rig(f)
    active = monitor
    const now = Date.now()
    const file = writeLog(f.project, 'old.jsonl', 200_000, now - 2 * 3_600_000) // idle two hours
    monitor.setPane(P1, spec({ adopted: true, since: now - 3 * 3_600_000 }))
    expect(monitor.sessionFor(P1)?.file).toBe(file)
    expect(seen.get(P1)?.usedTokens).toBe(200_000)
  })
})
