import * as fs from 'node:fs'
import * as path from 'node:path'
import { PANE_CWD_MAX, type PaneCwdLocality, type PaneCwdSource } from '@contracts'

const REPORT_CLOCK_SKEW_MS = 5 * 60_000
const PROMPT_COALESCE_MS = 100

export type CwdRejectReason = 'badcwd' | 'stalecwd' | 'badtime'

export interface PaneCwdSnapshot {
  cwd: string
  revision: number
  source: PaneCwdSource
  locality: PaneCwdLocality
}

export interface CwdReportResult {
  ok: boolean
  reason?: CwdRejectReason
  current: PaneCwdSnapshot
  changed?: PaneCwdSnapshot
}

/** Validate a declared path on the reporting machine. Logical spelling is preserved apart from
 * platform path normalization; symlinks are not realpathed because the logical worktree name
 * is user-facing identity. Remote OSC paths use `mustExist:false` on the local host. */
export function normalizePaneCwd(
  raw: unknown,
  opts: { mustExist: boolean; platform?: NodeJS.Platform } = { mustExist: true }
): string | null {
  if (
    typeof raw !== 'string' ||
    !raw ||
    raw.length > PANE_CWD_MAX ||
    /[\x00-\x1f\x7f]/.test(raw)
  ) return null
  const platform = opts.platform ?? process.platform
  const flavor = platform === 'win32' ? path.win32 : path.posix
  if (!flavor.isAbsolute(raw)) return null
  const normalized = flavor.normalize(raw)
  if (!normalized || normalized.length > PANE_CWD_MAX) return null
  const root = flavor.parse(normalized).root
  const canonical = normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized
  if (opts.mustExist) {
    try {
      if (!fs.statSync(canonical).isDirectory()) return null
    } catch {
      return null
    }
  }
  return canonical
}

/** Remote terminals are explicitly POSIX-only; local host path flavor is irrelevant. */
export function normalizeRemotePaneCwd(raw: unknown): string | null {
  if (
    typeof raw !== 'string' ||
    !raw ||
    raw.length > PANE_CWD_MAX ||
    /[\x00-\x1f\x7f]/.test(raw) ||
    !path.posix.isAbsolute(raw)
  ) return null
  const normalized = path.posix.normalize(raw)
  const canonical = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
  return canonical && canonical.length <= PANE_CWD_MAX ? canonical : null
}

const keyFor = (v: Omit<PaneCwdSnapshot, 'revision'>): string =>
  `${v.locality}\0${v.source}\0${process.platform === 'win32' && v.locality === 'local' ? v.cwd.toLocaleLowerCase('en-US') : v.cwd}`

/** One source-aware cwd state machine shared by both PTY backends.
 *
 * Precedence while a foreground command is active:
 *   explicit declaration > observed Git worktree > detected process cwd > shell cwd
 *   > spawn cwd.
 * A real shell prompt or proven foreground-process exit clears command-scoped lanes. */
export class PaneCwdState {
  private shellCwd: string | null = null
  private detected: { pid: number; cwd?: string } | null = null
  private worktreeCwd: string | null = null
  private commandActive = false
  private pendingStarts = 0
  private lastPromptMarker = ''
  private lastPromptAt = 0
  private declared: { cwd: string; observedAt: number } | null = null
  private revision = 0
  private barrierAt = 0
  private effectiveKey: string

  constructor(
    private readonly spawnCwd: string,
    private readonly locality: PaneCwdLocality,
    restored?: { cwd: string; observedAt: number }
  ) {
    if (restored) {
      this.declared = restored
      this.revision = 1
    }
    this.effectiveKey = keyFor(this.value())
  }

  current(): PaneCwdSnapshot {
    return { ...this.value(), revision: this.revision }
  }

  commandInFlight(): boolean {
    return this.commandActive
  }

  declaredForPersistence(): { cwd: string; observedAt: number } | null {
    return this.declared ? { ...this.declared } : null
  }

  /** Provider session-log identity follows the process launch cwd, not a later semantic Git
   * target or explicit primary-worktree declaration. */
  passiveCwd(): string {
    return this.detected?.cwd ?? this.shellCwd ?? this.spawnCwd
  }

  /** A submitted foreground command opens the observation window used by provider-neutral Git
   * setup evidence. Repeated Enter keys inside a TUI keep the same window. */
  acceptCommandStart(): PaneCwdSnapshot | null {
    if (this.detected) return null
    this.pendingStarts++
    this.lastPromptMarker = ''
    if (this.commandActive) return null
    this.commandActive = true
    this.worktreeCwd = null
    return this.commit()
  }

  /** Exact worktree opened by a descendant Git process (`GIT_TRACE_SETUP`). It is ignored when
   * the shell is prompting, so a late/background Git command cannot relabel the pane. */
  acceptWorktree(cwd: string): PaneCwdSnapshot | null {
    if (!this.commandActive) return null
    this.worktreeCwd = cwd
    return this.commit()
  }

  /** Shell OSC 9;9 is a prompt boundary; OSC 7 without a prompt refines only the lower lane. */
  acceptShell(
    cwd: string,
    prompt: boolean,
    at = Date.now(),
    marker = 'generic'
  ): PaneCwdSnapshot | null {
    this.shellCwd = cwd
    if (prompt) this.applyPromptBoundary(at, marker)
    return this.commit()
  }

  /** A prompt marker without a cwd still proves the foreground agent context ended. */
  acceptPrompt(at = Date.now(), marker = 'generic'): PaneCwdSnapshot | null {
    this.applyPromptBoundary(at, marker)
    return this.commit()
  }

  /** Process-table truth. PID replacement inside one active command is a wrapper/pipeline
   * handoff, so command-scoped declarations survive; a prompt or proven process exit retires
   * them. */
  acceptDetected(det: { pid: number; cwd?: string } | null, at = Date.now()): PaneCwdSnapshot | null {
    if (!det) {
      if (this.commandActive || this.detected || this.worktreeCwd || this.declared) {
        this.barrierAt = Math.max(this.barrierAt, at)
      }
      this.commandActive = false
      this.pendingStarts = 0
      this.detected = null
      this.worktreeCwd = null
      this.declared = null
      return this.commit()
    }
    this.commandActive = true
    this.pendingStarts = 0
    this.detected = { pid: det.pid, cwd: det.cwd }
    return this.commit()
  }

  acceptReport(cwd: string, observedAt: number, now = Date.now()): CwdReportResult {
    if (!Number.isFinite(observedAt) || Math.abs(now - observedAt) > REPORT_CLOCK_SKEW_MS) {
      return { ok: false, reason: 'badtime', current: this.current() }
    }
    // A host clock correction can put old anchors in the future. The caller and daemon share
    // one machine, so a report whose own timestamp matches `now` is current; retire future
    // anchors instead of refusing every report until wall time catches up.
    if (now + 1000 < this.barrierAt) this.barrierAt = 0
    if (this.declared && now + 1000 < this.declared.observedAt) this.declared = null
    if (observedAt < this.barrierAt) {
      return { ok: false, reason: 'stalecwd', current: this.current() }
    }
    if (this.declared && observedAt < this.declared.observedAt) {
      return { ok: false, reason: 'stalecwd', current: this.current() }
    }
    this.declared = { cwd, observedAt }
    const changed = this.commit()
    return { ok: true, current: this.current(), ...(changed ? { changed } : {}) }
  }

  private value(): Omit<PaneCwdSnapshot, 'revision'> {
    if (this.declared) return { cwd: this.declared.cwd, source: 'agent', locality: this.locality }
    if (this.worktreeCwd) return { cwd: this.worktreeCwd, source: 'process', locality: this.locality }
    if (this.detected?.cwd) return { cwd: this.detected.cwd, source: 'process', locality: this.locality }
    if (this.shellCwd) return { cwd: this.shellCwd, source: 'shell', locality: this.locality }
    return { cwd: this.spawnCwd, source: 'spawn', locality: this.locality }
  }

  private applyPromptBoundary(at: number, marker: string): void {
    if (
      marker !== 'generic' &&
      this.lastPromptMarker &&
      this.lastPromptMarker !== marker &&
      Math.abs(at - this.lastPromptAt) <= PROMPT_COALESCE_MS
    ) return
    this.lastPromptMarker = marker
    this.lastPromptAt = at
    if (this.pendingStarts > 0) this.pendingStarts--
    this.commandActive = this.pendingStarts > 0
    this.worktreeCwd = null
    this.declared = null
    this.detected = null
    this.barrierAt = Math.max(this.barrierAt, at)
  }

  private commit(): PaneCwdSnapshot | null {
    const value = this.value()
    const key = keyFor(value)
    if (key === this.effectiveKey) return null
    this.effectiveKey = key
    this.revision++
    return { ...value, revision: this.revision }
  }
}
