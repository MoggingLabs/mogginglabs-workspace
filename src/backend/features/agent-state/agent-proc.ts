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
// COST — the design is shaped by it. A process listing is EXPENSIVE on Windows: measured at
// 700-1100 ms for a PowerShell CIM query over ~350 processes (and `wmic`, the cheap one, has
// been removed from Windows). So the question is never "how fast is a probe" but "how few
// probes can be correct", and the answer is: probe only when the pane can have GAINED or LOST
// a foreground program.
//
//   a line was submitted, and 2 s later the shell has NOT come back to its prompt
//                                    -> something is still running in there. Probe.
//   the shell came back to its prompt while we believed an agent was running
//                                    -> it is gone. Its pid is checked for FREE first; only a
//                                       pid that still looks alive (recycled) costs a probe.
//   a pane was tracked (spawn / cold-restore / reattach)
//                                    -> it may already hold an agent. Probe (+ one retry, for
//                                       a restore that types its own resume).
//
// Nothing else. An agent CONVERSATION costs zero probes (input goes to the agent, not the
// shell). A running agent costs zero probes — it is confirmed with process.kill(pid, 0), which
// is free, on a cheap timer that stops itself when no pane has an agent. Ordinary commands
// cost zero probes: the shell's prompt comes back long before the armed probe fires and
// cancels it. A pane streaming output forever (a dev server, a watch task) costs zero probes —
// which is exactly what an earlier version of this file got wrong, by probing on every
// busy/idle EDGE: bursty output flips that edge every couple of seconds, and a workspace with
// one `npm run dev` pane would have burned a snapshot every 3 s for as long as it ran.
//
// The prompt marker is OSC 9;9 — what a pane's shell emits because we inject it (see
// platform/shell.ts). It is never treated as a VERDICT, only as a trigger: a backgrounded
// agent still shows up in the subtree, and the snapshot, not the prompt, decides.
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

export interface ProcRow {
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

/** After a submitted line: long enough that the shell has printed its prompt back for any
 *  ordinary command (milliseconds) and cancelled this probe, and that an agent's process has
 *  certainly SPAWNED (a CLI appears in the table within ~200 ms of Enter, long before it
 *  paints) — but short enough that the gauge follows the agent by a couple of seconds. */
const SUBMIT_PROBE_MS = 2000
/** After a pane is tracked: the first probe, then one retry — a cold restore types its own
 *  resume into a shell that is still booting, so its agent can appear several seconds late. */
const TRACK_PROBE_MS = 2000
const TRACK_RETRY_MS = 5000
/** The shell prompted while we still believed an agent was running, and its pid still looks
 *  alive: a recycled pid wearing a dead agent's face. Verify (rare — the free pid check
 *  answers the normal case). */
const CONFIRM_PROBE_MS = 250
/** Never list processes more often than this — ALL panes share one listing. */
const MIN_SNAPSHOT_GAP_MS = 3000
/** Cheap liveness sweep (a signal-0 per known agent). Stops itself when no pane has one. */
const LIVENESS_TICK_MS = 3000
/** The backstop for a shell that emits no prompt marker (so the confirm path above cannot
 *  run): re-verify a pane's agent occasionally. Slow on purpose — it is pure insurance. */
const REANCHOR_MS = 300_000
/** The agent existed for up to one detection lag before we saw it — the watch floor slack. */
const FIRST_SEEN_SLACK_MS = 15_000
/** A wedged probe is killed rather than allowed to pile up. */
const PROBE_TIMEOUT_MS = 15_000
/** Retries for a failing process listing before backing off. */
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
  /** When this pane wants a process listing (ms epoch), or null when it wants none. The whole
   *  cost model is this field being null almost all of the time. */
  probeAt: number | null
  /** A prompt must NOT cancel this probe. Set when the SESSION typed the command itself (a
   *  restore's resume): the shell's prompt then arrives BEFORE that command has even run, so
   *  reading it as "nothing is running" would cancel the one probe that finds the resumed
   *  agent — and a machine reboot would bring the agent back with no identity at all. */
  probeSticky: boolean
  /** Lines submitted that the shell has not finished yet. A prompt retires ONE of them; only
   *  the last one going quiet means nothing is running. Typing ahead — `npm install`, then
   *  `claude` before it finishes — is the case a naive "any prompt cancels" gets wrong: the
   *  install's prompt would cancel the probe that was meant for the agent. */
  pendingSubmits: number
  /** Follow-up listings still owed (only a restoring pane asks for one). */
  retries: number
  /** This pane's shell announces its prompt (it has shell integration). Then we are TOLD when
   *  a foreground command ends, and the re-anchor below — the blind backstop for shells that
   *  cannot tell us — is pure waste here. */
  hasPromptMarker: boolean
}

/** Everything this class touches outside itself. Injected by the COST gate, which drives the
 *  whole schedule on a fake clock and a fake process table and asserts how many listings each
 *  scenario performs — the cost model above is a contract, not a hope. */
export interface AgentProcDeps {
  snapshot?: () => Promise<ProcRow[] | null>
  procCwd?: (pid: number) => Promise<string | null>
  alive?: (pid: number) => boolean
  /** One timer primitive (the class self-reschedules rather than holding an interval). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class AgentProcessDetector {
  private readonly panes = new Map<string, TrackedPane>()
  private snapshotTimer: unknown
  private tickTimer: unknown
  private lastSnapshotAt = 0
  private snapshotting = false
  private disposed = false
  /** Consecutive failed process listings — the retry budget before backing off. */
  private failures = 0

  constructor(
    private readonly emit: (paneId: string, detected: DetectedAgentProc | null) => void,
    private readonly now: () => number = Date.now,
    private readonly deps: AgentProcDeps = {}
  ) {}

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms)
    const h = setTimeout(fn, ms)
    h.unref?.()
    return h
  }

  private clearTimer(handle: unknown): void {
    if (!handle) return
    if (this.deps.clearTimer) this.deps.clearTimer(handle)
    else clearTimeout(handle as NodeJS.Timeout)
  }

  /** Watch a pane's PTY subtree. `rootPid` is the pane shell's pid (node-pty's `IPty.pid`:
   *  the ConPTY inner pid on Windows, the forked shell on POSIX — the shell either way).
   *
   *  `expectAgent` is the difference between a workspace of shells costing NOTHING and costing
   *  a process listing per pane on open. A brand-new shell cannot already contain an agent, and
   *  anything the app types into it afterwards announces itself (commandSubmitted). The one
   *  pane that must be looked at unprompted is a RESTORING one: it types its own resume into a
   *  shell that is still booting, so its agent arrives seconds later, with nobody to say so. */
  track(paneId: string, rootPid: number, expectAgent = false): void {
    if (this.disposed || !Number.isFinite(rootPid) || rootPid <= 0) return
    this.panes.set(paneId, {
      rootPid,
      current: null,
      probeAt: expectAgent ? this.now() + TRACK_PROBE_MS : null,
      probeSticky: expectAgent,
      pendingSubmits: 0,
      retries: expectAgent ? 1 : 0,
      hasPromptMarker: false
    })
    this.reschedule()
  }

  /** A LINE was submitted into the pane (the user, or the app, pressed Enter). Something may be
   *  starting. Arm one probe — the shell coming back to its prompt cancels it, so an ordinary
   *  command costs nothing at all. Ignored while an agent is running: those keystrokes are a
   *  conversation with the agent, not a command to the shell. */
  commandSubmitted(paneId: string): void {
    const t = this.panes.get(paneId)
    if (!t || t.current) return
    t.pendingSubmits++
    const at = this.now() + SUBMIT_PROBE_MS
    if (t.probeAt === null || at < t.probeAt) t.probeAt = at
    this.reschedule()
  }

  /** The pane's shell is back at its PROMPT (its OSC 9;9 marker). Two meanings, both free.
   *
   *  One submitted line has finished. If it was the LAST one outstanding, nothing is running in
   *  there and an armed probe has nothing to find — cancel it, and an ordinary command has cost
   *  nothing. If lines are still queued behind it (the user typed ahead), keep watching: the
   *  agent may be in one of them.
   *
   *  And if we believed an agent was running here, it isn't any more — the shell would not be
   *  prompting. That is settled with a signal-0, no listing; only a pid that still answers
   *  (recycled onto some other process) is worth the cost of one. The prompt is never the
   *  verdict, only the trigger: a backgrounded agent still shows up in the subtree, and the
   *  listing decides. */
  promptSeen(paneId: string): void {
    const t = this.panes.get(paneId)
    if (!t) return
    t.hasPromptMarker = true // this shell tells us when a command ends — the re-anchor can rest
    if (t.pendingSubmits > 0) t.pendingSubmits--
    if (t.pendingSubmits > 0) t.probeAt = this.now() + SUBMIT_PROBE_MS // more lines queued behind it
    else if (!t.probeSticky) t.probeAt = null
    if (t.current) {
      if (!(this.deps.alive ?? isAlive)(t.current.pid)) {
        t.current = null
        this.emit(paneId, null) // free: no listing needed to know a dead pid is dead
      } else {
        t.probeAt = this.now() + CONFIRM_PROBE_MS // its pid still answers — a recycled one?
      }
    }
    this.reschedule()
  }

  untrack(paneId: string): void {
    this.panes.delete(paneId)
    this.reschedule()
  }

  current(paneId: string): DetectedAgentProc | null {
    return this.panes.get(paneId)?.current ?? null
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer(this.snapshotTimer)
    this.clearTimer(this.tickTimer)
    this.snapshotTimer = undefined
    this.tickTimer = undefined
    this.panes.clear()
  }

  /** The earliest moment any pane wants a listing — null when nobody does, which is the
   *  normal state of the world. */
  private nextProbeAt(): number | null {
    let at: number | null = null
    for (const t of this.panes.values()) {
      if (t.probeAt !== null && (at === null || t.probeAt < at)) at = t.probeAt
    }
    return at
  }

  /** Re-aim the ONE probe timer at whatever the panes now want (nothing, usually). Cancelling
   *  matters as much as scheduling: a prompt clears an armed probe, and that must really stop
   *  it — an un-cancelled timer would spend the listing anyway. */
  private reschedule(): void {
    if (this.disposed) return
    this.clearTimer(this.snapshotTimer)
    this.snapshotTimer = undefined
    this.ensureTick() // a pane may have just gained an agent to keep alive
    const at = this.nextProbeAt()
    if (at === null) return
    const gap = this.lastSnapshotAt + MIN_SNAPSHOT_GAP_MS - this.now()
    this.snapshotTimer = this.setTimer(() => void this.snapshot(), Math.max(at - this.now(), gap, 0))
  }

  /** The free sweep: confirm known agents by pid. It exists only while some pane HAS an agent —
   *  a workspace of plain shells keeps no timer at all — and stops itself when the last one
   *  goes. */
  private ensureTick(): void {
    if (this.tickTimer || this.disposed) return
    if (![...this.panes.values()].some((t) => t.current)) return
    this.tickTimer = this.setTimer(() => this.tick(), LIVENESS_TICK_MS)
  }

  private tick(): void {
    this.tickTimer = undefined
    if (this.disposed) return
    const alive = this.deps.alive ?? isAlive
    let anyAgent = false
    for (const [paneId, t] of this.panes) {
      if (!t.current) continue
      if (alive(t.current.pid)) {
        anyAgent = true
        continue
      }
      t.current = null // the agent died and no shell told us (this pane has no prompt marker)
      this.emit(paneId, null)
    }
    if (!anyAgent) return // nothing left to keep alive: the timer simply stops existing
    // The re-anchor covers exactly one hole: an agent that died and had its pid RECYCLED onto
    // another process, in a pane whose shell never announces its prompt — so promptSeen's free
    // check can never run there. A shell WITH integration (every cmd.exe pane we spawn) needs
    // none of it, and a 30-minute agent session there costs zero listings instead of six.
    if (this.now() - this.lastSnapshotAt >= REANCHOR_MS) {
      for (const t of this.panes.values()) {
        if (t.current && !t.hasPromptMarker) t.probeAt = this.now()
      }
    }
    this.tickTimer = this.setTimer(() => this.tick(), LIVENESS_TICK_MS)
    if (this.nextProbeAt() !== null) this.reschedule()
  }

  private async snapshot(): Promise<void> {
    this.snapshotTimer = undefined
    if (this.snapshotting || this.disposed) return
    // Everything that wanted a listing may have stopped wanting one while the timer ran — the
    // shell came back to its prompt, the pane closed. Then there is nothing here to learn, and
    // the most expensive thing this file does must simply not happen.
    const due = [...this.panes.values()].filter((t) => t.probeAt !== null && t.probeAt <= this.now())
    if (!due.length) {
      this.reschedule() // a later deadline may still be pending
      return
    }
    this.snapshotting = true
    this.lastSnapshotAt = this.now()
    try {
      const rows = await (this.deps.snapshot ?? snapshotProcesses)()
      // A failed listing is NO DATA — never "no agents": every verdict stands. But a pane still
      // waiting to be discovered must not be stranded by one bad listing, so retry a few times,
      // then give up rather than hammer a tool that is not working.
      if (!rows || this.disposed) {
        if (rows) return
        this.failures++
        const retry = this.failures <= MAX_SNAPSHOT_RETRIES
        for (const t of due) t.probeAt = retry ? this.now() + MIN_SNAPSHOT_GAP_MS : null
        return
      }
      this.failures = 0
      const byParent = new Map<number, ProcRow[]>()
      for (const r of rows) {
        const kids = byParent.get(r.ppid)
        if (kids) kids.push(r)
        else byParent.set(r.ppid, [r])
      }
      // Read EVERY pane off this one listing, not just the ones that asked for it: it is
      // already paid for, and a verdict that costs nothing more is worth having.
      for (const [paneId, t] of this.panes) {
        t.probeAt = null
        t.probeSticky = false
        const found = this.findAgentIn(byParent, t.rootPid)
        const prev = t.current
        if (!found) {
          // A restoring pane gets one more look: it typed its own resume into a shell that was
          // still booting, so its agent can arrive after this listing — and nothing will ever
          // announce it. Sticky, because the shell's prompt is not evidence either way here.
          if (t.retries > 0) {
            t.retries--
            t.probeAt = this.now() + TRACK_RETRY_MS
            t.probeSticky = true
          }
          if (!prev) continue
          t.current = null
          this.emit(paneId, null)
          continue
        }
        t.retries = 0
        t.pendingSubmits = 0 // from here the pane's keystrokes belong to the agent, not the shell
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
      this.reschedule() // start the liveness tick for anything newly found; re-aim any retry
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
