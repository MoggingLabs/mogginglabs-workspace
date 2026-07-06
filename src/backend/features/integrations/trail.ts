import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TRAIL_MAX_BYTES, TRAIL_MAX_ENTRIES, type TrailEntry, type TrailOutcome, type TrailSource } from '@contracts'

// The agent activity trail's STORE (Phase-8/05, FINDINGS §4.5 — the audit
// trail with teeth). Append-only JSONL, ONE file per workspace under
// `<userData>/trail/`, ring-capped (oldest-half rewrite on overflow).
// Deliberately NOT the settings KV: entries are high-churn and user-clearable
// per workspace. Entries are REFS structurally — every string field is
// LENGTH-CAPPED on append so page text, eval bodies, cookies, and full URLs
// cannot physically fit; the WEBTRAIL smoke greps the raw file to prove it.
// Writes are queued + idle-flushed (never on a hot path) and fire-and-forget:
// a full disk drops entries with ONE loud log line — evidence, not
// enforcement; a trail failure never blocks an action.

const CAP = { workspaceId: 64, pane: 32, verb: 64, target: 256, reason: 256 } as const
const SOURCES: readonly TrailSource[] = ['web', 'mcp', 'bridge']
const OUTCOMES: readonly TrailOutcome[] = ['ok', 'refused', 'confirmed']
const FLUSH_DELAY_MS = 250

/** File-name-safe workspace key (ids are uuids/slugs; anything else escapes). */
const fileKey = (workspaceId: string): string => workspaceId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, CAP.workspaceId)

/** Coerce an entry into the closed, length-capped shape — never throws. */
function sanitizeEntry(raw: TrailEntry): TrailEntry {
  const s = (v: unknown, cap: number): string => String(v ?? '').slice(0, cap)
  const entry: TrailEntry = {
    ts: Number.isFinite(raw?.ts) ? Number(raw.ts) : Date.now(),
    source: SOURCES.includes(raw?.source) ? raw.source : 'mcp',
    workspaceId: s(raw?.workspaceId, CAP.workspaceId),
    verb: s(raw?.verb, CAP.verb),
    target: s(raw?.target, CAP.target),
    outcome: OUTCOMES.includes(raw?.outcome) ? raw.outcome : 'ok'
  }
  if (raw?.pane !== undefined) entry.pane = s(raw.pane, CAP.pane)
  if (raw?.reason !== undefined) entry.reason = s(raw.reason, CAP.reason)
  return entry
}

export class TrailStore {
  private readonly pending = new Map<string, TrailEntry[]>()
  private flushTimer: NodeJS.Timeout | null = null
  private failedLoudly = false

  constructor(private readonly dir: string) {}

  private file(workspaceId: string): string {
    return join(this.dir, `${fileKey(workspaceId)}.jsonl`)
  }

  /** Queue one entry (sanitized) for the idle flush. Never throws. */
  append(entry: TrailEntry): void {
    const clean = sanitizeEntry(entry)
    if (!clean.workspaceId) return // unattributable — nowhere to file it
    const key = fileKey(clean.workspaceId)
    const q = this.pending.get(key) ?? []
    q.push(clean)
    this.pending.set(key, q)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS)
      // Never keep the process alive for a trail write.
      this.flushTimer.unref?.()
    }
  }

  /** Drain the queue to disk; ring-cap each touched file. Never throws. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    for (const [workspaceId, entries] of this.pending) {
      this.pending.delete(workspaceId)
      try {
        mkdirSync(this.dir, { recursive: true })
        appendFileSync(this.file(workspaceId), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
        this.enforceRing(workspaceId)
      } catch (e) {
        if (!this.failedLoudly) {
          this.failedLoudly = true
          // The one loud line — a full disk drops entries, never crashes.
          console.error(`trail: dropping entries for ${workspaceId} (write failed: ${String(e).slice(0, 200)})`)
        }
      }
    }
  }

  /** Oldest-half rewrite when a file crosses either cap. */
  private enforceRing(workspaceId: string): void {
    const file = this.file(workspaceId)
    const size = statSync(file).size
    if (size <= TRAIL_MAX_BYTES) {
      // Bytes under cap — count lines only when the size makes the entry cap
      // even plausible (entries are ≥ ~90 bytes; 2000 need ≥ 180 KB).
      if (size < 180_000) return
    }
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (size <= TRAIL_MAX_BYTES && lines.length <= TRAIL_MAX_ENTRIES) return
    const keep = lines.slice(-Math.floor(TRAIL_MAX_ENTRIES / 2))
    writeFileSync(file, keep.join('\n') + '\n', 'utf8')
  }

  /** Read one workspace's entries, oldest first. Bad lines skip silently. */
  read(workspaceId: string): TrailEntry[] {
    this.flush() // readers see queued writes
    const file = this.file(workspaceId)
    if (!existsSync(file)) return []
    const out: TrailEntry[] = []
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue
        try {
          out.push(sanitizeEntry(JSON.parse(line) as TrailEntry))
        } catch {
          /* torn line (crash mid-append) — skip */
        }
      }
    } catch {
      return []
    }
    return out
  }

  /** Workspace ids (file keys) that have a trail on disk. */
  listWorkspaces(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.slice(0, -6))
    } catch {
      return []
    }
  }

  /** Delete exactly one workspace's trail (the user's clear verb). */
  clear(workspaceId: string): void {
    this.pending.delete(fileKey(workspaceId))
    try {
      rmSync(this.file(workspaceId), { force: true })
    } catch {
      /* already gone */
    }
  }
}
