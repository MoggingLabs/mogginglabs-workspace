import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { AGENT_ADAPTERS } from '../agents/adapters'

// TYPED-LAUNCH DETECTION — which agent CLI is REALLY running inside a pane's PTY.
//
// The app only ever knew about the agents IT launched (the launch port). A user who types
// `claude` at the pane's own prompt starts a session the whole identity stack is blind to:
// no context gauge, no provider mark, no manifest resume. Terminal output can't close that
// honestly (banners change with every release, TUIs redraw, `rg claude` prints the word),
// but the PROCESS TABLE cannot lie: the pane's shell is our child, so an agent CLI running
// in that pane is a DESCENDANT of that shell. This detector walks each tracked pane's
// subtree and reports transitions — "pane 103 runs claude (pid 1234, since T)" / "pane 103's
// agent is gone". Both PTY backends (daemon + in-proc) wire one detector across their panes.
//
// COST. A full process snapshot is the expensive part (one PowerShell CIM query on Windows,
// one `ps` on POSIX), so it is only spent on DISCOVERY — panes that have no known agent and
// whose output says a command just started. A pane whose agent is already known is confirmed
// with process.kill(pid, 0), which costs nothing, on a cheap timer. So a wall of idle panes
// costs zero snapshots, a running agent costs zero snapshots, and only "a command started
// somewhere" pays — rate-limited to one snapshot for ALL panes. A slow re-anchor snapshot
// re-verifies everything periodically (pid reuse can't fool the liveness check forever).
//
// MATCHING is by construction, never by grepping the command line for a word:
//   - the executable's NAME is an adapter bin (claude.exe, codex, gemini, aider…), or
//   - it is an INTERPRETER (node/bun/deno/python) whose SCRIPT path carries a distinctive
//     package segment (`@anthropic-ai`, `claude-code`, `@openai`, `gemini-cli`…) or whose
//     script BASENAME is an adapter bin (the npm/pip shim shape: `node …/.bin/claude`).
// A path SEGMENT can't collide the way a substring can — `rg claude` never matches, and a
// repo folder named `codex` never reads as an agent.
//
// PRIVACY: command lines are read, matched, and DROPPED. Only the matched agent id, the pid,
// and the agent's own cwd ever leave this module — never argv, never env (ADR 0002/0005).

export interface DetectedAgentProc {
  /** Adapter id: 'claude' | 'codex' | 'gemini' | 'aider' | 'opencode'. */
  agentId: string
  pid: number
  /** The agent process's OWN working directory — where the CLI actually launched, which is
   *  what names its session log. Exact on POSIX (`/proc/<pid>/cwd`, `lsof`); undefined on
   *  Windows (a process's cwd is not readable without native code), where the caller falls
   *  back to the pane's OSC-7 cwd — which is why panes ship shell-integration OSC 7. */
  cwd?: string
  /** When the agent was first SEEN, minus one detection lag: the floor a context watch may
   *  look back to. The session log predates detection, never by more than the lag. */
  sinceMs: number
}

interface ProcRow {
  pid: number
  ppid: number
  /** Executable basename, lowercased, `.exe`/`.cmd`/`.bat`/`.com` stripped. */
  base: string
  cmd: string
}

/** Executable names that ARE an agent (native builds, pip/npm .exe shims). */
const BIN_TO_AGENT = new Map(AGENT_ADAPTERS.map((a) => [a.bin.toLowerCase(), a.id]))

/** Interpreters whose SCRIPT decides (npm/pip installs run as node/python). */
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'pythonw'])

/** Distinctive install-path SEGMENTS -> agent id. Segments, never substrings. */
const PKG_SEGMENT_TO_AGENT = new Map<string, string>([
  ['@anthropic-ai', 'claude'],
  ['claude-code', 'claude'],
  ['@openai', 'codex'],
  ['@google', 'gemini'],
  ['gemini-cli', 'gemini'],
  ['aider-chat', 'aider'],
  ['opencode-ai', 'opencode']
])

/** First discovery probe after a pane starts being tracked. */
const TRACK_PROBE_DELAY_MS = 1200
/** Discovery probe this long after the output that suggests a command started. */
const POKE_PROBE_DELAY_MS = 700
/** Never snapshot the process table more often than this (ALL panes share one snapshot). */
const MIN_SNAPSHOT_GAP_MS = 3000
/** Cheap liveness sweep for panes whose agent pid is already known. */
const LIVENESS_TICK_MS = 3000
/** Re-anchor: a full snapshot even when every pane looks settled (pid reuse, missed edges). */
const REANCHOR_MS = 60_000
/** The agent existed for up to one detection lag before we saw it — the watch floor slack. */
const FIRST_SEEN_SLACK_MS = 15_000
/** A wedged probe is killed rather than allowed to pile up. */
const PROBE_TIMEOUT_MS = 15_000
/** Retries for a failing process listing before backing off to the slow cadence. */
const MAX_SNAPSHOT_RETRIES = 3

/** Split a command line into argv-ish tokens, honoring double quotes. */
export function tokenizeCommandLine(cmd: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2])
  return out
}

const stripExeExt = (name: string): string => name.replace(/\.(exe|cmd|bat|com)$/i, '')
const stripScriptExt = (name: string): string => name.replace(/\.(js|mjs|cjs|ts|py)$/i, '')

/** The agent id a single process represents, or null. Pure — the unit of the gate. */
export function matchAgentProcess(base: string, cmd: string): string | null {
  const direct = BIN_TO_AGENT.get(base)
  if (direct) return direct
  if (!INTERPRETERS.has(base)) return null
  // An interpreter: the SCRIPT it runs (first non-flag argument) names the package.
  const script = tokenizeCommandLine(cmd)
    .slice(1)
    .find((t) => !t.startsWith('-'))
  if (!script) return null
  const segments = script.split(/[\\/]+/)
  for (const seg of segments) {
    const hit = PKG_SEGMENT_TO_AGENT.get(seg.toLowerCase())
    if (hit) return hit
  }
  // …or the shim shape: `node <prefix>/.bin/claude`, `python .../bin/aider`.
  const leaf = stripScriptExt(stripExeExt((segments.pop() ?? '').toLowerCase()))
  return BIN_TO_AGENT.get(leaf) ?? null
}

/** A process's own working directory. Exact on POSIX; unavailable on Windows (reading
 *  another process's PEB needs native code — panes carry OSC-7 shell integration instead,
 *  and the caller falls back to the pane's reported cwd). */
export function readProcessCwd(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return Promise.resolve(fs.readlinkSync(`/proc/${pid}/cwd`))
    } catch {
      return Promise.resolve(null)
    }
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
        if (err || !stdout) return resolve(null)
        // -Fn output: "p<pid>\nfcwd\nn/the/path\n"
        const line = stdout.split('\n').find((l) => l.startsWith('n'))
        resolve(line ? line.slice(1) || null : null)
      })
    })
  }
  return Promise.resolve(null)
}

/** One full process snapshot: pid/ppid/name/cmd for every process. Windows rides a single
 *  PowerShell CIM query (wmic is gone on current Windows); POSIX a single `ps`. A failure
 *  resolves to NULL — no data is never "no agents", and every verdict is held. */
function snapshotProcesses(): Promise<ProcRow[] | null> {
  return new Promise((resolve) => {
    const opts = { timeout: PROBE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true }
    if (process.platform === 'win32') {
      const ps = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
      const script =
        'Get-CimInstance Win32_Process | ForEach-Object { ' +
        '"{0}`t{1}`t{2}`t{3}" -f $_.ProcessId,$_.ParentProcessId,$_.Name,$_.CommandLine }'
      execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', script], opts, (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const rows: ProcRow[] = []
        for (const line of stdout.split('\n')) {
          const f = line.split('\t')
          if (f.length < 3) continue
          const pid = Number(f[0])
          const ppid = Number(f[1])
          if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
          rows.push({ pid, ppid, base: stripExeExt((f[2] ?? '').trim().toLowerCase()), cmd: (f[3] ?? '').trim() })
        }
        resolve(rows.length ? rows : null)
      })
    } else {
      execFile('ps', ['-eo', 'pid=,ppid=,args='], opts, (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const rows: ProcRow[] = []
        for (const line of stdout.split('\n')) {
          const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
          if (!m) continue
          const cmd = m[3]
          const exe = tokenizeCommandLine(cmd)[0] ?? ''
          rows.push({
            pid: Number(m[1]),
            ppid: Number(m[2]),
            base: stripExeExt((exe.split(/[\\/]+/).pop() ?? '').toLowerCase()),
            cmd
          })
        }
        resolve(rows.length ? rows : null)
      })
    }
  })
}

/** Is this pid still running? (Signal 0 — a permission error still means ALIVE.) */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface TrackedPane {
  rootPid: number
  current: DetectedAgentProc | null
  /** Discovery wanted: this pane has no known agent and its output says something started. */
  poked: boolean
}

export class AgentProcessDetector {
  private readonly panes = new Map<string, TrackedPane>()
  private snapshotTimer: NodeJS.Timeout | undefined
  private tickTimer: NodeJS.Timeout | undefined
  private lastSnapshotAt = 0
  private snapshotting = false
  private disposed = false
  /** Consecutive failed process listings — the retry budget before backing off. */
  private failures = 0

  constructor(
    private readonly emit: (paneId: string, detected: DetectedAgentProc | null) => void,
    private readonly now: () => number = Date.now,
    /** Injected by the gate; production uses the real system snapshot + cwd read. */
    private readonly deps: {
      snapshot?: () => Promise<ProcRow[] | null>
      procCwd?: (pid: number) => Promise<string | null>
      alive?: (pid: number) => boolean
    } = {}
  ) {}

  /** Watch a pane's PTY subtree. `rootPid` is the pane shell's pid (node-pty's `IPty.pid`:
   *  the ConPTY inner pid on Windows, the forked shell on POSIX — the shell either way). */
  track(paneId: string, rootPid: number): void {
    if (this.disposed || !Number.isFinite(rootPid) || rootPid <= 0) return
    this.panes.set(paneId, { rootPid, current: null, poked: true })
    this.scheduleSnapshot(TRACK_PROBE_DELAY_MS)
    this.ensureTick()
  }

  /** The pane's activity state changed — a command may have started or ended here. The
   *  cheap edge: an agent CLI always paints something when it starts and when it dies. */
  poke(paneId: string): void {
    const t = this.panes.get(paneId)
    if (!t || t.current) return // a known agent is confirmed by liveness, not by snapshots
    t.poked = true
    this.scheduleSnapshot(POKE_PROBE_DELAY_MS)
  }

  untrack(paneId: string): void {
    this.panes.delete(paneId)
    if (this.panes.size === 0 && this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
    }
  }

  current(paneId: string): DetectedAgentProc | null {
    return this.panes.get(paneId)?.current ?? null
  }

  dispose(): void {
    this.disposed = true
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.snapshotTimer = undefined
    this.tickTimer = undefined
    this.panes.clear()
  }

  /** One snapshot serves every pane; requests inside the window coalesce into it. */
  private scheduleSnapshot(delayMs: number): void {
    if (this.disposed || this.snapshotTimer) return
    const gap = this.lastSnapshotAt + MIN_SNAPSHOT_GAP_MS - this.now()
    this.snapshotTimer = setTimeout(() => void this.snapshot(), Math.max(delayMs, gap))
    this.snapshotTimer.unref?.()
  }

  /** The cheap sweep: confirm known agents by pid (free), and re-anchor slowly. */
  private ensureTick(): void {
    if (this.tickTimer || this.disposed) return
    const alive = this.deps.alive ?? isAlive
    this.tickTimer = setInterval(() => {
      let died = false
      let anyAgent = false
      for (const [paneId, t] of this.panes) {
        if (!t.current) continue
        if (alive(t.current.pid)) {
          anyAgent = true
          continue
        }
        t.current = null
        t.poked = true // the shell is back — a new agent may start here at any moment
        died = true
        this.emit(paneId, null)
      }
      // A death is the one moment a pane goes from "confirmed, costs nothing" back to
      // "unknown": re-discover at once rather than waiting for the shell's next edge.
      if (died) this.scheduleSnapshot(0)
      // The re-anchor exists for the one thing a pid check cannot see: a recycled pid
      // wearing a dead agent's face. So it only runs while some pane HAS an agent — a
      // workspace of idle shells never pays for a process listing it cannot learn from.
      else if (anyAgent && this.now() - this.lastSnapshotAt >= REANCHOR_MS) this.scheduleSnapshot(0)
    }, LIVENESS_TICK_MS)
    this.tickTimer.unref?.()
  }

  private async snapshot(): Promise<void> {
    this.snapshotTimer = undefined
    if (this.snapshotting || this.disposed || this.panes.size === 0) return
    this.snapshotting = true
    this.lastSnapshotAt = this.now()
    try {
      const rows = await (this.deps.snapshot ?? snapshotProcesses)()
      // A failed probe is NO DATA — never "no agents": every verdict stands. But a pane still
      // waiting to be discovered must not be stranded by one bad listing, so retry — a few
      // times, then fall back to the slow cadence rather than hammering a broken tool.
      if (!rows || this.disposed) {
        if (rows) return
        this.failures++
        if (this.failures <= MAX_SNAPSHOT_RETRIES && [...this.panes.values()].some((t) => t.poked)) {
          this.scheduleSnapshot(MIN_SNAPSHOT_GAP_MS)
        }
        return
      }
      this.failures = 0
      const byParent = new Map<number, ProcRow[]>()
      for (const r of rows) {
        const kids = byParent.get(r.ppid)
        if (kids) kids.push(r)
        else byParent.set(r.ppid, [r])
      }
      for (const [paneId, t] of this.panes) {
        t.poked = false
        const found = this.findAgentIn(byParent, t.rootPid)
        const prev = t.current
        if (!found) {
          if (!prev) continue
          t.current = null
          this.emit(paneId, null)
          continue
        }
        if (prev && prev.pid === found.pid && prev.agentId === found.agentId) continue
        const cwd = await (this.deps.procCwd ?? readProcessCwd)(found.pid)
        if (this.disposed || this.panes.get(paneId) !== t) return // pane replaced under the await
        const det: DetectedAgentProc = {
          agentId: found.agentId,
          pid: found.pid,
          cwd: cwd ?? undefined,
          sinceMs: this.now() - FIRST_SEEN_SLACK_MS
        }
        t.current = det
        this.emit(paneId, det)
      }
    } finally {
      this.snapshotting = false
    }
  }

  /** BFS the pane's subtree: the SHALLOWEST agent wins — the CLI the user ran, not an
   *  agent one of its own tools happened to spawn. Visited-guard: recycled pids can knot
   *  the ppid graph, and a cycle must never hang the daemon. */
  private findAgentIn(byParent: Map<number, ProcRow[]>, rootPid: number): { agentId: string; pid: number } | null {
    let level = [rootPid]
    const seen = new Set<number>(level)
    while (level.length) {
      const next: number[] = []
      const hits: Array<{ agentId: string; pid: number }> = []
      for (const pid of level) {
        for (const child of byParent.get(pid) ?? []) {
          if (seen.has(child.pid)) continue
          seen.add(child.pid)
          const agentId = matchAgentProcess(child.base, child.cmd)
          if (agentId) hits.push({ agentId, pid: child.pid })
          else next.push(child.pid)
        }
      }
      if (hits.length) return hits.sort((a, b) => a.pid - b.pid)[0] // stable pick within a level
      level = next
    }
    return null
  }
}
