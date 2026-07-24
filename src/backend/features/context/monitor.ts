import * as fs from 'node:fs'
import { dirname, join } from 'node:path'
import type { ContextProvider, ContextUsage } from '@contracts'
import {
  codexDayDirs,
  contextSinkPath,
  findClaudeProjectDir,
  findGeminiProjectDir,
  parseClaudeHead,
  parseClaudeTail,
  parseCodexTail,
  parseGeminiTail,
  pathKey,
  readCodexSessionCwd,
  readContextSink,
  readHead,
  readTail
} from './readers'
import { claudeWindowForModel, codexPercentUsed, geminiWindowForModel, learnClaudeWindow } from './window'
import { aiderWindowForModel, opencodeWindowFor, readAiderUsage, readOpencodeUsage } from './providers'

/** Gemini keeps a project's session logs one level down, in `chats/`. */
function geminiChatsDir(projectDir: string | null): string | null {
  return projectDir ? join(projectDir, 'chats') : null
}

// Tracks the agent session log behind each pane and emits that pane's context usage
// whenever it changes. Same discipline as the git monitor next door: ONE shared poll
// (bounded, predictable cost — no fs watchers), stat-gated so an idle wall of agents
// costs a handful of stat() calls per tick and zero reads, and emit-on-change only so
// idle panes produce no IPC churn. Electron-free: the sink is injected by the app
// layer (src/main/context.ts) and wired to IPC there.
//
// THE HARD PART is not reading a number — it is knowing WHICH file is this pane's
// session. The CLIs never announce it, so the monitor locks on by construction:
//
//   lock      a fresh launch accepts only files written AFTER the watch began (the
//             previous session's log is sitting right there in the same project dir,
//             recently written, and must not be resurrected); an ADOPTED pane (the
//             detached daemon kept the agent alive across an app restart) accepts a
//             recent file — its session began before we did.
//   exclude   a file another pane has locked is never a candidate — two panes in the
//             same cwd each find their own session.
//   migrate   a candidate written STRICTLY LATER than the locked file's last write
//             replaces it: the user relaunched the CLI inside the pane, and the new
//             session supersedes the old. An idle-but-alive session is never dropped
//             (idleness moves no mtimes).
//   reserve   a locked pane may NOT migrate onto a file that an UNLOCKED same-target
//             pane (same provider, home, cwd) with a SHARPER floor could still claim.
//             Without this, pane A (idle, locked) sees pane B's brand-new session log
//             one tick before B does, steals it as an "in-pane relaunch", and B —
//             its own file now excluded — shows "waiting for the first response"
//             forever while A wears B's numbers. Found live 2026-07-23.
//   takeover  the reverse arbitration: an UNLOCKED pane whose (sharper) floor admits
//             a file that another pane holds by mtime HEURISTIC may reclaim it — the
//             holder unlocks and re-resolves on its next tick. Sharpest claimant wins.
//   pin       claude only: the pane's own statusline relay names the EXACT transcript
//             (`transcript_path`), so identity stops being a guess entirely. A pinned
//             lock ignores mtime migration and cannot be taken over.
//
// Known honest gap: two panes launching the same CLI in the same cwd within the same
// poll tick can swap locks (both files appear before either pane locks, both floors
// equally sharp). Both bars still show real sessions of that repo; a relay pin or the
// next relaunch heals it.

export interface ContextSink {
  change(paneId: number, usage: ContextUsage | null): void
}

export interface ContextPaneSpec {
  provider: ContextProvider
  cwd: string
  /** The provider's config home, resolved by the app layer (profile pointer or default). */
  home: string
  /** Pane adopted from the detached daemon — its session predates the watch. */
  adopted?: boolean
  /** Test seam: opencode's offline model catalogue (defaults to its real cache path). */
  opencodeModels?: string
  /** The earliest this session's log can have been written (ms epoch). Detection knows this
   *  EXACTLY — the agent process's creation time where the platform reports it (first-seen
   *  minus the detection lag otherwise) — which beats both guesses below: a fresh launch's
   *  slack, and an adopted pane's blind 30-minute window. */
  since?: number
}

interface Track extends ContextPaneSpec {
  watchStart: number
  /** The locked session log, once found. */
  file?: string
  /** Locked file's last observed mtime — the migration comparator. */
  fileMtimeMs: number
  /** Stat gate: skip the read when the locked file hasn't moved. */
  lastSize: number
  lastMtimeMs: number
  /** Last window the log stated (codex lines can carry a null info block). */
  window?: number
  /** Baseline seed attempted for this lock (one shot — see the seed note below). */
  seeded?: boolean
  /** Locked from the pane's own relay (`transcript_path`) — exact identity, immune
   *  to mtime migration and takeover. */
  pinned?: boolean
  lastSig?: string
}

const DEFAULT_POLL_MS = 2500
/** How far back an ADOPTED pane's initial lock may reach. Covers an agent that spoke
 *  recently; one idle longer shows no bar until its next turn writes the log. */
const ADOPT_LOOKBACK_MS = 30 * 60_000
/** Fresh-launch slack: the CLI stamps its log a beat around our watchStart. */
const LAUNCH_SLACK_MS = 5_000

export class ContextMonitor {
  private readonly panes = new Map<number, Track>()
  /** rollout path -> its session_meta cwd (immutable once written; bounded). */
  private readonly codexCwd = new Map<string, string | null>()
  private timer: NodeJS.Timeout | undefined
  private ticking = false

  constructor(
    private readonly sink: ContextSink,
    private readonly pollMs = DEFAULT_POLL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Start (or replace) tracking a pane's agent session. A relaunch is a NEW session:
   *  the old lock and window are deliberately dropped. */
  setPane(paneId: number, spec: ContextPaneSpec): void {
    this.panes.set(paneId, {
      ...spec,
      watchStart: this.now(),
      fileMtimeMs: 0,
      lastSize: -1,
      lastMtimeMs: -1
    })
    this.ensurePolling()
    this.refresh(paneId)
  }

  /** The session log this pane is locked on, with the provider it was watched for —
   *  how a resume-by-id launch (ADR 0013) learns WHICH session a pane was living in.
   *  Undefined until the matcher locks (a fresh pane, or a log not yet written). */
  sessionFor(paneId: number): { provider: ContextProvider; file: string } | undefined {
    const t = this.panes.get(paneId)
    return t?.file ? { provider: t.provider, file: t.file } : undefined
  }

  /** Stop tracking a pane. Stops the poll when nothing is tracked (renderer clears
   *  its own port state — no farewell emit, matching the git monitor). The pane's
   *  statusline sink file is swept so a future pane with the same id never reads
   *  a dead session's numbers. */
  remove(paneId: number): void {
    this.panes.delete(paneId)
    try {
      fs.unlinkSync(contextSinkPath(paneId))
    } catch {
      /* no sink was ever written */
    }
    if (this.panes.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.panes.clear()
    this.codexCwd.clear()
  }

  private ensurePolling(): void {
    if (this.timer || this.panes.size === 0) return
    this.timer = setInterval(() => this.tick(), this.pollMs)
    this.timer.unref?.()
  }

  private tick(): void {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const paneId of [...this.panes.keys()]) this.refresh(paneId)
    } finally {
      this.ticking = false
    }
  }

  /** How far back THIS pane's lock may reach. Detection reports exactly when it first saw the
   *  agent (`since`), which beats both guesses: a fresh launch's slack, and an adopted pane's
   *  blind 30-minute window. */
  private floorFor(t: Track): number {
    if (t.since) return t.since
    return t.watchStart - (t.adopted ? ADOPT_LOOKBACK_MS : LAUNCH_SLACK_MS)
  }

  /** Two panes are after the SAME pool of session logs: one provider, one config
   *  home, one cwd. Only then can their lock claims collide. */
  private sameTarget(a: Track, b: Track): boolean {
    return a.provider === b.provider && a.home === b.home && pathKey(a.cwd) === pathKey(b.cwd)
  }

  /** Whether pane t may lock the file (owned by `owner`, or unclaimed) at this mtime.
   *  Encodes the reserve/takeover arbitration from the header: sharpest claimant wins,
   *  a pin always wins. */
  private mayClaim(t: Track, mtimeMs: number, owner: Track | undefined, others: Track[]): boolean {
    if (owner) {
      // Takeover: only an UNLOCKED pane may reclaim, only from a HEURISTIC (unpinned)
      // lock, and only when its own floor is the sharper claim on this file.
      return !t.file && !owner.pinned && this.sameTarget(t, owner) && this.floorFor(t) > this.floorFor(owner)
    }
    // Reserve: a locked pane weighing a migration must leave a fresh file to any
    // unlocked same-target pane whose sharper floor admits it — that pane's own
    // session is exactly what a file born inside its watch window looks like.
    if (t.file) {
      for (const o of others) {
        if (o.file || !this.sameTarget(t, o)) continue
        const oFloor = this.floorFor(o)
        if (oFloor > this.floorFor(t) && mtimeMs >= oFloor) return false
      }
    }
    return true
  }

  /** Candidate session logs for a pane, newest first. Only files a pane could lock:
   *  recent enough for ITS lock rule, and admissible under the claim arbitration. */
  private candidates(paneId: number, t: Track): Array<{ file: string; mtimeMs: number }> {
    const lockedByOthers = new Map<string, Track>()
    const others: Track[] = []
    for (const [id, other] of this.panes) {
      if (id === paneId) continue
      others.push(other)
      if (other.file) lockedByOthers.set(other.file, other)
    }
    const floor = this.floorFor(t)

    const out: Array<{ file: string; mtimeMs: number }> = []
    if (t.provider === 'claude' || t.provider === 'gemini') {
      // Both keep ONE directory per project cwd, holding that project's session logs — claude
      // under a munged path, gemini under a slug it maps for itself. Same shape from here.
      const dir =
        t.provider === 'claude'
          ? findClaudeProjectDir(t.home, t.cwd)
          : geminiChatsDir(findGeminiProjectDir(t.home, t.cwd))
      if (!dir) return out
      let names: string[]
      try {
        names = fs.readdirSync(dir)
      } catch {
        return out
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const file = join(dir, name)
        try {
          const st = fs.statSync(file)
          if (st.mtimeMs >= floor && this.mayClaim(t, st.mtimeMs, lockedByOthers.get(file), others)) {
            out.push({ file, mtimeMs: st.mtimeMs })
          }
        } catch {
          /* raced away */
        }
      }
    } else {
      // codex: day dirs are shared across ALL cwds — match each recent rollout's
      // session_meta cwd to the pane's (cached; a session's cwd never changes).
      const key = pathKey(t.cwd)
      for (const dir of codexDayDirs(t.home)) {
        let names: string[]
        try {
          names = fs.readdirSync(dir)
        } catch {
          continue
        }
        for (const name of names) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
          const file = join(dir, name)
          try {
            const st = fs.statSync(file)
            if (st.mtimeMs < floor) continue // cheap gate before the session_meta read
            if (!this.mayClaim(t, st.mtimeMs, lockedByOthers.get(file), others)) continue
            if (!this.codexCwd.has(file)) {
              if (this.codexCwd.size > 500) this.codexCwd.clear() // bounded, crude, sufficient
              const cwd = readCodexSessionCwd(file)
              this.codexCwd.set(file, cwd === null ? null : pathKey(cwd))
            }
            if (this.codexCwd.get(file) === key) out.push({ file, mtimeMs: st.mtimeMs })
          } catch {
            /* raced away */
          }
        }
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return out
  }

  /** Unlock every OTHER pane holding `file`: the caller just claimed it (a relay pin,
   *  or takeover arbitration). The loser re-resolves on its next tick; its gauge goes
   *  honest-pending rather than wearing a session that was never its own. */
  private claim(paneId: number, file: string): void {
    for (const [id, other] of this.panes) {
      if (id === paneId || other.file !== file) continue
      other.file = undefined
      other.fileMtimeMs = 0
      other.pinned = false
      this.emit(id, other, null)
    }
  }

  /** Point the track at a different session file, resetting every per-lock gate. */
  private lock(paneId: number, t: Track, file: string, mtimeMs: number, pinned: boolean): void {
    this.claim(paneId, file)
    t.file = file
    t.fileMtimeMs = mtimeMs
    t.lastSize = -1 // force a read of the new lock
    t.lastMtimeMs = -1
    t.window = undefined // a different file is a different session — re-resolve its window
    t.seeded = false
    t.pinned = pinned
  }

  /** Lock/migrate this pane's session file, then read + parse + emit on change. */
  private refresh(paneId: number): void {
    const t = this.panes.get(paneId)
    if (!t) return

    // 1. Resolve the file. Locked file gone -> unlock + hide the bar (session log
    //    deleted under us); a strictly newer candidate -> migrate (in-pane relaunch).
    //    Claude first checks its relay sink: `transcript_path` NAMES the session file,
    //    and an exact identity beats every mtime heuristic below (a fresh sink also
    //    re-pins across an in-pane relaunch — the new session overwrites the sink
    //    within its first statusline fire). The floor guard keeps a leftover sink
    //    from a PREVIOUS session out, same as for its numbers.
    const sink = t.provider === 'claude' ? readContextSink(paneId) : null
    if (sink && sink.transcriptPath && sink.mtimeMs >= this.floorFor(t) && sink.transcriptPath !== t.file) {
      try {
        const st = fs.statSync(sink.transcriptPath)
        this.lock(paneId, t, sink.transcriptPath, st.mtimeMs, true)
      } catch {
        /* named file not on disk (yet) — the heuristics below still apply */
      }
    }
    if (t.file) {
      try {
        fs.statSync(t.file)
      } catch {
        t.file = undefined
        t.fileMtimeMs = 0
        t.pinned = false
        this.emit(paneId, t, null)
      }
    }
    if (!t.pinned) {
      const best = this.candidates(paneId, t)[0]
      if (best && (!t.file || (best.file !== t.file && best.mtimeMs > t.fileMtimeMs))) {
        this.lock(paneId, t, best.file, best.mtimeMs, false)
      }
    }
    // 2. Stat the locked transcript (when there is one). This both feeds the stat
    //    gate for step 4 and keeps the sink's freeze-detection honest below.
    let statChanged = false
    if (t.file) {
      try {
        const st = fs.statSync(t.file)
        statChanged = st.size !== t.lastSize || st.mtimeMs !== t.lastMtimeMs
        if (statChanged) {
          t.lastSize = st.size
          t.lastMtimeMs = st.mtimeMs
          t.fileMtimeMs = Math.max(t.fileMtimeMs, st.mtimeMs)
        }
      } catch {
        return // deleted between the lock check and here; next tick unlocks
      }
    }

    // 3. THE STATUSLINE SINK OUTRANKS EVERYTHING (claude). The app injects a relay
    //    into claude launches (src/main/context.ts) and Claude then PUSHES its own
    //    numbers here on every update — `used_percentage` is the very value /context
    //    prints (same code path, h1n), and `context_window_size` is THIS session's
    //    true window — no table required. Two guards keep it honest: a sink older
    //    than this watch is a PREVIOUS session's leftovers, and a sink the
    //    transcript has clearly outrun (>5s behind a growing log) means the user's
    //    own statusline config replaced the relay mid-session — both fall through
    //    to the transcript path below.
    if (t.provider === 'claude') {
      const floor = this.floorFor(t)
      if (sink && sink.mtimeMs >= floor && !(t.lastMtimeMs > sink.mtimeMs + 5000)) {
        if (sink.windowTokens) t.window = sink.windowTokens
        // TEACH the window table from the horse's mouth. This pane's relay knows the window
        // THIS session runs with, and a model id alone can never settle it (an Opus 4.8
        // transcript reads the same at 200K and at 1M). A hand-typed claude in another pane
        // has no relay of its own — this is how it gets a true denominator instead of a
        // documented one. See window.ts.
        learnClaudeWindow(sink.model, sink.windowTokens)
        const window = sink.windowTokens ?? t.window ?? claudeWindowForModel(sink.model)
        if (sink.usedPct !== null && sink.usedTokens !== undefined && window) {
          this.emit(paneId, t, {
            provider: t.provider,
            usedTokens: sink.usedTokens,
            windowTokens: window,
            usedPct: Math.max(0, Math.min(100, Math.round(sink.usedPct))),
            model: sink.model,
            at: this.now()
          })
          return
        }
      }
    }
    // 3b. THE TWO PROVIDERS THAT ARE NOT A LOG TAIL. Aider reports into a per-pane analytics
    //     log the daemon points it at (exact integers, typed or launched); opencode keeps
    //     everything in one SQLite store keyed by directory. Neither needs the file-locking
    //     machinery below — there is exactly one place to look, and it is this pane's.
    if (t.provider === 'aider') {
      const r = readAiderUsage(paneId)
      if (!r || r.mtimeMs < this.floorFor(t)) return // no reading yet, or a previous session's
      const window = aiderWindowForModel(t.home, r.model)
      if (!window) return // no litellm cache / unknown model: no denominator, so no digit
      this.emit(paneId, t, {
        provider: t.provider,
        usedTokens: r.usedTokens,
        windowTokens: window,
        // Clamp to 100 like the claude path: a session whose counted tokens exceed the documented
        // window must not print ">100% used" in the header/tooltip text (the gauge disc is clamped
        // in the renderer, but the % LABEL is not). OpenCode below stays unclamped on purpose.
        usedPct: Math.max(0, Math.min(100, Math.round((r.usedTokens / window) * 100))),
        model: r.model,
        at: this.now()
      })
      return
    }
    if (t.provider === 'opencode') {
      const r = readOpencodeUsage(t.home, t.cwd)
      if (!r) return
      const window = opencodeWindowFor(r.provider, r.model, t.opencodeModels)
      if (!window) return
      this.emit(paneId, t, {
        provider: t.provider,
        usedTokens: r.usedTokens,
        windowTokens: window,
        // Its sidebar rounds and reserves nothing.
        usedPct: Math.max(0, Math.round((r.usedTokens / window) * 100)),
        model: r.model,
        at: this.now()
      })
      return
    }
    if (!t.file) return // nothing else to read yet; pending "–" stays

    // 4. Stat gate: an idle session costs one stat per tick, no read, no emit.
    if (!statChanged) return

    //    Read the tail + parse the newest reading. No usable line yet (the session
    //    just opened — its log gains a usage line only with the FIRST response), so
    //    a claude pane seeds the BASELINE from a previous session instead: `/context`
    //    shows a real number before any chat (system prompt + tools + CLAUDE.md are
    //    already in the window), and the closest READABLE stand-in for it is a
    //    sibling session's opening turn — same project, same assembly. The smallest
    //    opening turn among the newest siblings is used (a RESUMED session's first
    //    line is mid-conversation-sized; the min filters those out), emitted with
    //    `approx: true`, and replaced by the first real reading. One shot per lock.
    const tail = readTail(t.file)
    if (tail === null) return
    const reading =
      t.provider === 'claude' ? parseClaudeTail(tail) : t.provider === 'gemini' ? parseGeminiTail(tail) : parseCodexTail(tail)
    if (!reading) {
      if (t.provider !== 'claude' || t.seeded) return
      t.seeded = true
      const seed = this.claudeBaselineSeed(t)
      if (seed) {
        // The sink's true window (statusline fires at REPL start with the window
        // even before any usage) beats the documented-model fallback for the seed.
        const window = t.window ?? claudeWindowForModel(seed.model)
        if (window === null) return // unknown model, no relay yet: no number is better than a guess
        this.emit(paneId, t, {
          provider: t.provider,
          usedTokens: seed.usedTokens,
          windowTokens: window,
          usedPct: Math.max(0, Math.min(100, Math.round((seed.usedTokens / window) * 100))),
          model: seed.model,
          approx: true,
          at: this.now()
        })
      }
      return
    }

    // 5. Resolve the window, and then the PERCENT — with the formula that CLI uses, not with
    //    a formula of our own. This is the whole contract of the gauge: the number beside the
    //    pane must be the number inside it.
    //
    //    claude  window: the relay's true per-session size, else what a relay has taught us for
    //            this model, else the documented table (window.ts). percent: used / window —
    //            the CLI's own h1n sum over its own window.
    //    codex   window: stated on the line, verbatim (codex already scaled it). percent: NOT
    //            used/window — codex reserves a 12K baseline on BOTH sides of the ratio, so its
    //            own formula is reproduced (codexPercentUsed). Skipping it reads ~4 points low
    //            against the footer in the very same pane.
    //    gemini  window: its flat limit table (1,048,576; Gemma-4 256,000). percent:
    //            promptTokenCount / limit — what its "N% used" footer divides.
    //
    //    No window, no number: a percent of a guessed denominator is a lie, and the pane keeps
    //    its honest "–".
    let window: number | undefined
    if (t.provider === 'claude') {
      window = t.window ?? claudeWindowForModel(reading.model) ?? undefined
    } else if (t.provider === 'gemini') {
      window = geminiWindowForModel(reading.model)
    } else {
      if (reading.windowTokens) t.window = reading.windowTokens
      window = t.window
    }
    if (!window) return

    const usedPct =
      t.provider === 'codex'
        ? codexPercentUsed(reading.usedTokens, window)
        : t.provider === 'gemini'
          ? // NOT clamped at 100. Gemini's ratio is unclamped and its footer will happily say
            // "101% used" once the prompt outgrows the limit (verified against the shipped
            // bundle: at 1,053,819 tokens of 1,048,576 it renders 101). Clamping would make the
            // header disagree with the pane in the one place a context gauge matters most.
            Math.max(0, Math.round((reading.usedTokens / window) * 100))
          : Math.max(0, Math.min(100, Math.round((reading.usedTokens / window) * 100)))
    if (usedPct === null) return // codex logged no usable window — it shows no percent either
    this.emit(paneId, t, {
      provider: t.provider,
      usedTokens: reading.usedTokens,
      windowTokens: window,
      usedPct,
      model: reading.model,
      at: this.now()
    })
  }

  /** The baseline seed: the smallest OPENING-turn usage among this project's three
   *  newest sibling session logs (excluding the pane's own lock). Null when the
   *  project has no prior sessions — the pane then stays on its pending "–".
   *
   *  Siblings are read from the LOCKED file's own directory, never re-derived from the
   *  pane's cwd: a detected session may have locked a log one directory deeper (see
   *  candidates()), and its baseline must come from ITS project, not the pane's. */
  private claudeBaselineSeed(t: Track): { usedTokens: number; model?: string } | null {
    const dir = t.file ? dirname(t.file) : findClaudeProjectDir(t.home, t.cwd)
    if (!dir) return null
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return null
    }
    const siblings: Array<{ file: string; mtimeMs: number }> = []
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(dir, name)
      if (file === t.file) continue
      try {
        siblings.push({ file, mtimeMs: fs.statSync(file).mtimeMs })
      } catch {
        /* raced away */
      }
    }
    siblings.sort((a, b) => b.mtimeMs - a.mtimeMs)
    let best: { usedTokens: number; model?: string } | null = null
    for (const s of siblings.slice(0, 3)) {
      const head = readHead(s.file)
      if (head === null) continue
      const first = parseClaudeHead(head)
      if (first && (!best || first.usedTokens < best.usedTokens)) best = first
    }
    return best
  }

  /** Emit only when the READING changed (`at` alone never re-emits — no IPC churn).
   *  `approx` is part of the signature: a real first reading that happens to equal
   *  the seed must still re-emit, or the "~" would outlive the approximation. */
  private emit(paneId: number, t: Track, usage: ContextUsage | null): void {
    const sig = usage ? `${usage.usedTokens}|${usage.windowTokens}|${usage.model ?? ''}|${usage.approx ? 1 : 0}` : 'null'
    if (t.lastSig === sig) return
    t.lastSig = sig
    this.sink.change(paneId, usage)
  }
}
