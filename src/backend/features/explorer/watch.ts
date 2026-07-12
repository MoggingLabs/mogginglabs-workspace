import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import type { ExplorerWatchStats } from '@contracts'

/**
 * The liveness law (Phase-11/04, ADR 0010.d): WATCH WHAT'S VISIBLE, NOTHING ELSE.
 *
 * The VS Code watcher architecture (RESEARCH §2/§6) minus the native dependency: they
 * run a recursive tier on `@parcel/watcher` and a NON-recursive tier on `fs.watch`, and
 * fall back to polling for paths that refuse. We only ever need the second and third
 * tiers, because we only ever watch what is on screen — one non-recursive `fs.watch`
 * per EXPANDED directory. A recursive watcher is forbidden outright (the node_modules
 * trap, docs/05): it would index a tree we deliberately never index.
 *
 * THREE RULES MAKE THIS CHEAP:
 *
 *  1. **The renderer declares its whole expanded set, every time.** `setDirs` diffs
 *     against the live pool, so there is no incremental "add" verb to leak handles
 *     through. A collapsed dir costs nothing — not a handle, not a poll, not a byte.
 *
 *  2. **A batch means the LISTING moved.** An event only marks a dir dirty; the flush
 *     then re-reads its children and emits ONLY if the kinds+names actually changed.
 *     This is what makes the law true on Windows: writing a file inside a COLLAPSED
 *     subdirectory bumps that subdirectory's last-write time, which fires the parent's
 *     non-recursive watcher — a real event about a dir whose listing did not move.
 *     Without this check the renderer would be woken for nothing, and "a collapsed dir
 *     costs zero" would be a comment rather than a fact.
 *
 *  3. **Two tiers, one signature.** Handles are capped (LRU); everything above the cap,
 *     and everything that REFUSES a handle (EMFILE, EPERM, an SMB mount), demotes to a
 *     jittered poll. The poll's trigger is the directory's own mtime — O(1), and it
 *     moves on create/delete/rename but NOT on a file's content edit, which is exactly
 *     the set of changes a name-listing tree cares about.
 *
 * Electron-free on purpose: `main/explorer.ts` owns the IPC and the window-visibility
 * hooks, so this is testable without booting an app.
 */

/** Handles are a finite OS resource; past this the coldest dirs poll instead. */
export const WATCH_POOL_CAP = 64
/** The quiet window a burst must clear before it drains as ONE batch. */
export const COALESCE_MS = 150
/** …and the ceiling that stops a SUSTAINED torrent from starving the flush forever. */
export const COALESCE_MAX_MS = 600
/** The fallback tier's base cadence, jittered ±25%. */
export const POLL_BASE_MS = 2000

export interface ExplorerWatcher {
  /** The renderer's CURRENT expanded set, most-important-first (the root leads).
   *  Idempotent: the same set twice is a no-op. `[]` tears the whole pool down. */
  setDirs(dirs: string[]): void
  /** Window hidden: close every handle, park the poll. State is kept so `resume` can
   *  tell what moved while we were blind. */
  suspend(): void
  /** Window shown: rebuild the pool, then re-check the whole visible set in ONE pass. */
  resume(): void
  stats(): ExplorerWatchStats
  dispose(): void
}

export function createExplorerWatcher(onChanged: (dirs: string[]) => void): ExplorerWatcher {
  let desired: string[] = [] // priority order, as the renderer sent it
  let want = new Set<string>()
  const watchers = new Map<string, FSWatcher>()
  const polls = new Set<string>()
  const sigs = new Map<string, string>() // listing signature — the DECISION
  const mtimes = new Map<string, number>() // dir mtime — the poll's cheap TRIGGER
  const hot = new Map<string, number>() // last event, monotonic — the LRU key
  const dirty = new Set<string>()

  let clock = 0
  let suspended = false
  let disposed = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let firstDirtyAt = 0
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollRunning = false

  // ── signatures ──────────────────────────────────────────────────────────────
  /** What the TREE renders from a directory: its children's kinds and names. A content
   *  edit does not move this; a create/delete/rename does. A vanished or unreadable dir
   *  IS a signature — the renderer must learn about it too. */
  function listingSig(dir: string): string {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .map((d) => (d.isDirectory() ? 'd:' : 'f:') + d.name)
        .sort()
        .join('\n')
    } catch (e) {
      return '!' + ((e as NodeJS.ErrnoException).code ?? 'ERR')
    }
  }
  /** O(1). Moves when an entry is added, removed, or renamed — never on a content edit. */
  function dirMtime(dir: string): number {
    try {
      return statSync(dir).mtimeMs
    } catch {
      return -1 // gone: a real change, and the flush's signature will say so
    }
  }
  function seed(dir: string): void {
    if (!sigs.has(dir)) sigs.set(dir, listingSig(dir))
    if (!mtimes.has(dir)) mtimes.set(dir, dirMtime(dir))
  }

  // ── coalescing ──────────────────────────────────────────────────────────────
  function markDirty(dir: string): void {
    if (suspended || disposed) return
    dirty.add(dir)
    hot.set(dir, ++clock) // a firing dir is a USED dir — it keeps (or wins back) its handle
    if (!firstDirtyAt) firstDirtyAt = Date.now()
    scheduleFlush()
  }

  function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer)
    // A quiet window coalesces a burst into ONE batch (the @parcel/watcher semantics,
    // RESEARCH §6). The max-wait ceiling is what keeps the ≤1s promise honest when the
    // burst never goes quiet — a `git checkout` is a handful of batches, not a stream.
    const waited = firstDirtyAt ? Date.now() - firstDirtyAt : 0
    const delay = Math.max(0, Math.min(COALESCE_MS, COALESCE_MAX_MS - waited))
    flushTimer = setTimeout(flush, delay)
  }

  function flush(): void {
    flushTimer = null
    firstDirtyAt = 0
    if (suspended || disposed || !dirty.size) {
      dirty.clear()
      return
    }
    const batch: string[] = []
    for (const dir of dirty) {
      const sig = listingSig(dir)
      if (sig === sigs.get(dir)) continue // the listing did not move — do NOT wake the renderer
      sigs.set(dir, sig)
      mtimes.set(dir, dirMtime(dir))
      batch.push(dir)
    }
    dirty.clear()
    if (batch.length) onChanged(batch) // dir paths only — never a file, never telemetry (ADR 0005)
  }

  // ── the pool ────────────────────────────────────────────────────────────────
  function closeWatcher(dir: string): void {
    const w = watchers.get(dir)
    if (!w) return
    try {
      w.close()
    } catch {
      /* already gone */
    }
    watchers.delete(dir)
  }

  function demote(dir: string): void {
    if (!want.has(dir)) return // it left the visible set mid-flight; nothing to do
    polls.add(dir)
    seed(dir)
  }

  function addWatcher(dir: string): void {
    if (watchers.has(dir)) return
    try {
      // NON-recursive, always. Both event types ('rename' for create/delete/move,
      // 'change' for content/attrs) mean the same thing here: re-check this dir. The
      // `filename` argument is unreliable across platforms and we never use it — the
      // listing signature at flush is the truth.
      const w = watch(dir, { persistent: false, recursive: false }, () => markDirty(dir))
      w.on('error', () => {
        // EPERM mid-flight, an unmounted network drive, a deleted dir: never fatal.
        closeWatcher(dir)
        demote(dir)
      })
      w.unref()
      watchers.set(dir, w)
      seed(dir)
    } catch {
      // EMFILE (handle exhaustion), EPERM, ENOENT, a mount that refuses inotify — the
      // dir simply drops to the slower tier rather than the feature dropping dead.
      demote(dir)
    }
  }

  function reconcile(): void {
    if (suspended || disposed) return
    for (const dir of [...watchers.keys()]) if (!want.has(dir)) closeWatcher(dir)
    for (const dir of [...polls]) if (!want.has(dir)) polls.delete(dir)

    // PRIORITY: the renderer sends its set most-important-first (the root leads), and a
    // dir that has been FIRING outranks one that never has — so a busy polled dir wins a
    // handle back at the next reconcile. V8's sort is stable, so the renderer's order
    // survives ties (every cold dir has hot=0).
    const priority = [...desired].sort((a, b) => (hot.get(b) ?? 0) - (hot.get(a) ?? 0))
    const keep = priority.slice(0, WATCH_POOL_CAP)
    const evicted = priority.slice(WATCH_POOL_CAP)

    for (const dir of evicted) {
      closeWatcher(dir) // LRU eviction: the coldest lose their handle, not their liveness
      polls.add(dir)
      seed(dir)
    }
    for (const dir of keep) {
      if (watchers.has(dir)) continue
      polls.delete(dir) // promotion — it gets a real handle now
      addWatcher(dir) // …which may bounce it straight back into polls, and that is fine
    }
    schedulePoll()
  }

  // ── the poll tier ───────────────────────────────────────────────────────────
  function pollPass(): void {
    pollTimer = null
    if (pollRunning || suspended || disposed) return
    pollRunning = true // re-entrancy guard: a slow pass must never overlap itself
    try {
      for (const dir of [...polls]) {
        const now = dirMtime(dir)
        if (now !== mtimes.get(dir)) {
          mtimes.set(dir, now)
          markDirty(dir) // the LISTING check still happens at flush; mtime is only the trigger
        }
      }
    } finally {
      pollRunning = false
    }
    schedulePoll()
  }

  function schedulePoll(): void {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    if (suspended || disposed || !polls.size) return // nothing to poll = no timer at all
    pollTimer = setTimeout(pollPass, jitter())
  }

  // ── API ─────────────────────────────────────────────────────────────────────
  function setDirs(dirs: string[]): void {
    if (disposed) return
    desired = dirs.filter((d) => typeof d === 'string' && !!d)
    want = new Set(desired)
    // A dir that left the visible set is FORGOTTEN — handle, poll, signature and all.
    // Re-expanding it re-seeds, so it can never emit a stale first batch.
    for (const dir of [...sigs.keys()]) {
      if (want.has(dir)) continue
      sigs.delete(dir)
      mtimes.delete(dir)
      hot.delete(dir)
      dirty.delete(dir)
    }
    reconcile()
  }

  function suspend(): void {
    if (suspended || disposed) return
    suspended = true
    for (const dir of [...watchers.keys()]) closeWatcher(dir)
    polls.clear()
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    dirty.clear()
    firstDirtyAt = 0
    // `sigs`/`mtimes` SURVIVE on purpose: they are how resume() knows what moved while
    // we were not looking.
  }

  function resume(): void {
    if (!suspended || disposed) return
    suspended = false
    reconcile() // rebuild handles + polls for the set we still hold
    // We were blind, so re-check everything visible in ONE pass. The flush's signature
    // comparison means an unchanged tree emits NOTHING — resuming is not an excuse to
    // wake the renderer for nothing.
    for (const dir of desired) dirty.add(dir)
    if (dirty.size) {
      firstDirtyAt = Date.now()
      scheduleFlush()
    }
  }

  function dispose(): void {
    if (disposed) return
    suspend()
    disposed = true
    desired = []
    want = new Set()
    sigs.clear()
    mtimes.clear()
    hot.clear()
  }

  return {
    setDirs,
    suspend,
    resume,
    stats: () => ({ handles: watchers.size, polls: polls.size, suspended }),
    dispose
  }
}

// A dependency-free noise source, seeded from the pid: spreads the poll cadence so N app
// instances never sync up (the mcp-status idiom). ±25% around the base.
let noiseSeed = (process.pid * 2654435761) >>> 0
function noise(): number {
  noiseSeed = (Math.imul(noiseSeed, 1664525) + 1013904223) >>> 0
  return noiseSeed / 0xffffffff
}
function jitter(): number {
  return Math.round(POLL_BASE_MS * (0.75 + noise() * 0.5))
}
