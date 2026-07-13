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
// PRIVACY: command lines are read, matched, and DROPPED. Only strict adapter identity plus the
// selected foreground descendant's pid/cwd leave this module — never argv or env (ADR 0002/0005).

export interface DetectedAgentProc {
  /** Adapter id: 'claude' | 'codex' | 'gemini' | 'aider' | 'opencode'. */
  agentId: string
  pid: number
  /** The agent process's OWN working directory — where the CLI actually launched, which is
   *  what names its session log. Exact on POSIX (`/proc/<pid>/cwd`, `lsof`) and best-effort on
   *  Windows through a read-only process-parameters snapshot. Undefined means the caller keeps
   *  the pane's lower-priority shell cwd. */
  cwd?: string
  /** When the agent was first SEEN, minus one detection lag: the floor a context watch may
   *  look back to. The session log predates detection, never by more than the lag. */
  sinceMs: number
}

/** Provider-neutral foreground context. Unlike DetectedAgentProc this says nothing about
 * identity, resume support, or whether the program is an AI agent. It only proves that a
 * foreground descendant of the pane shell owns this process context. */
export interface DetectedProcessContext {
  pid: number
  cwd?: string
  sinceMs: number
}

export interface ProcRow {
  pid: number
  ppid: number
  /** POSIX process-group evidence. A row is foreground when pgid === tpgid. Windows has no
   * equivalent in Win32_Process, so prompt boundaries provide the foreground proof there. */
  pgid?: number
  tpgid?: number
  /** Present when the platform snapshot can read the process's current directory. */
  cwd?: string
  /** Executable basename, lowercased, `.exe`/`.cmd`/`.bat`/`.com` stripped. */
  base: string
  cmd: string
}

/** Count logical submitted lines in one PTY input chunk. Bracketed paste can carry several
 * commands at once; CRLF is one boundary, not two. */
export function countSubmittedLines(data: string): number {
  return data.match(/\r\n|\r|\n/g)?.length ?? 0
}

/** Executable names that ARE an agent (native builds, pip/npm .exe shims). */
const BIN_TO_AGENT = new Map(AGENT_ADAPTERS.map((a) => [a.bin.toLowerCase(), a.id]))

/** Interpreters whose SCRIPT decides (npm/pip installs run as node/python). */
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'pythonw'])

/** Interactive shells that may be the tracked root itself. An `exec agent` replaces that root;
 * excluding shells lets the replacement participate without mistaking an idle shell for a CLI. */
const SHELL_BINS = new Set([
  'sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'mksh', 'csh', 'tcsh', 'elvish', 'nu', 'xonsh',
  'cmd', 'powershell', 'pwsh'
])

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
/** Refresh a live foreground process's cwd without another process-table snapshot. Linux is a
 * readlink; macOS needs lsof, so it is intentionally slower there. Windows's fallback is part
 * of the rare process snapshot and is not polled continuously. */
const CONTEXT_CWD_REFRESH_MS = process.platform === 'linux' ? 3000 : 15_000
/** The backstop for a shell that emits no prompt marker (so the confirm path above cannot
 *  run): re-verify a pane's agent occasionally. Slow on purpose — it is pure insurance. */
const REANCHOR_MS = 300_000
/** The agent existed for up to one detection lag before we saw it — the watch floor slack. */
const FIRST_SEEN_SLACK_MS = 15_000
/** A wedged probe is killed rather than allowed to pile up. */
const PROBE_TIMEOUT_MS = 15_000
/** Retries for a failing process listing before backing off. */
const MAX_SNAPSHOT_RETRIES = 3
const PROMPT_COALESCE_MS = 100

/** Windows exposes no supported cwd field through Win32_Process. For ordinary same-user
 * processes the current directory is still present in RTL_USER_PROCESS_PARAMETERS. This
 * read-only helper handles native-pointer and WOW64 layouts; every API/offset failure returns
 * null, leaving the shell cwd as the conservative fallback. It is compiled inside the same
 * PowerShell process that already performs the rare process snapshot, so it adds no poll. */
const WINDOWS_CWD_READER_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MoggingProcessCwd {
  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessBasicInformation {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr Reserved3;
  }

  [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess")]
  private static extern int QueryBasic(IntPtr process, int kind, ref ProcessBasicInformation info, int size, out int returned);
  [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess")]
  private static extern int QueryPointer(IntPtr process, int kind, out IntPtr info, int size, out int returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  private static bool Read(IntPtr process, long address, byte[] buffer) {
    IntPtr count;
    return ReadProcessMemory(process, new IntPtr(address), buffer, buffer.Length, out count) && count.ToInt64() == buffer.Length;
  }

  private static long ReadPointer(IntPtr process, long address, int pointerSize) {
    byte[] value = new byte[pointerSize];
    if (!Read(process, address, value)) return 0;
    return pointerSize == 8 ? BitConverter.ToInt64(value, 0) : BitConverter.ToUInt32(value, 0);
  }

  public static string Get(int pid) {
    IntPtr process = OpenProcess(0x1010, false, pid);
    if (process == IntPtr.Zero) return null;
    try {
      IntPtr peb = IntPtr.Zero;
      int pointerSize = IntPtr.Size;
      int returned;
      if (IntPtr.Size == 8) {
        IntPtr wow64Peb;
        if (QueryPointer(process, 26, out wow64Peb, IntPtr.Size, out returned) == 0 && wow64Peb != IntPtr.Zero) {
          peb = wow64Peb;
          pointerSize = 4;
        }
      }
      if (peb == IntPtr.Zero) {
        ProcessBasicInformation info = new ProcessBasicInformation();
        if (QueryBasic(process, 0, ref info, Marshal.SizeOf(typeof(ProcessBasicInformation)), out returned) != 0) return null;
        peb = info.PebBaseAddress;
      }
      if (peb == IntPtr.Zero) return null;
      long parameters = ReadPointer(process, peb.ToInt64() + (pointerSize == 8 ? 0x20 : 0x10), pointerSize);
      if (parameters == 0) return null;
      long currentDirectory = parameters + (pointerSize == 8 ? 0x38 : 0x24);
      byte[] lengthBytes = new byte[2];
      if (!Read(process, currentDirectory, lengthBytes)) return null;
      int length = BitConverter.ToUInt16(lengthBytes, 0);
      if (length <= 0 || length > 65534) return null;
      long bufferAddress = ReadPointer(process, currentDirectory + (pointerSize == 8 ? 8 : 4), pointerSize);
      if (bufferAddress == 0) return null;
      byte[] value = new byte[length];
      return Read(process, bufferAddress, value) ? Encoding.Unicode.GetString(value) : null;
    } catch {
      return null;
    } finally {
      CloseHandle(process);
    }
  }
}
`

const WINDOWS_CWD_READER_B64 = Buffer.from(WINDOWS_CWD_READER_CS, 'utf8').toString('base64')

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
const isForegroundRow = (row: ProcRow): boolean => {
  const hasGroupEvidence = row.pgid !== undefined && row.tpgid !== undefined
  return !hasGroupEvidence || (row.pgid! > 0 && row.pgid === row.tpgid)
}

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

/** A cheap process-cwd refresh. Exact on POSIX; Windows uses the batched native fallback in
 * `snapshotProcesses` and returns null here to avoid launching another PowerShell poll. */
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
function snapshotProcesses(rootPids: readonly number[] = []): Promise<ProcRow[] | null> {
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
      const script = [
        '$moggingCwdReader=$false',
        `try { Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${WINDOWS_CWD_READER_B64}'))) -Language CSharp -ErrorAction Stop; $moggingCwdReader=$true } catch {}`,
        '$moggingProcesses=@(Get-CimInstance Win32_Process)',
        '$moggingPaneTree=[Collections.Generic.HashSet[int]]::new()',
        `@(${rootPids.filter((pid) => Number.isInteger(pid) && pid > 0).join(',')}) | ForEach-Object { [void]$moggingPaneTree.Add([int]$_) }`,
        'do { $moggingAdded=$false; foreach($p in $moggingProcesses){ if($moggingPaneTree.Contains([int]$p.ParentProcessId) -and $moggingPaneTree.Add([int]$p.ProcessId)){ $moggingAdded=$true } } } while($moggingAdded)',
        '$moggingProcesses | ForEach-Object {',
        '  $cwd=if($moggingCwdReader -and $moggingPaneTree.Contains([int]$_.ProcessId)){[MoggingProcessCwd]::Get([int]$_.ProcessId)}else{$null}',
        '  $cwd64=if($cwd){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$cwd))}else{""}',
        '  $cmd64=if($_.CommandLine){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine))}else{""}',
        '  "{0}`t{1}`t{2}`t{3}`t{4}" -f $_.ProcessId,$_.ParentProcessId,$_.Name,$cwd64,$cmd64',
        '}'
      ].join('\n')
      execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', script], opts, (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const rows: ProcRow[] = []
        for (const line of stdout.split('\n')) {
          const f = line.split('\t')
          if (f.length < 5) continue
          const pid = Number(f[0])
          const ppid = Number(f[1])
          if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
          let cwd = ''
          let cmd = ''
          try {
            cwd = f[3] ? Buffer.from(f[3].trim(), 'base64').toString('utf8') : ''
            cmd = f[4] ? Buffer.from(f[4].trim(), 'base64').toString('utf8') : ''
          } catch {
            continue
          }
          rows.push({
            pid,
            ppid,
            base: stripExeExt((f[2] ?? '').trim().toLowerCase()),
            cmd,
            cwd: cwd || undefined
          })
        }
        resolve(rows.length ? rows : null)
      })
    } else {
      execFile('ps', ['-eo', 'pid=,ppid=,pgid=,tpgid=,args='], opts, (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const rows: ProcRow[] = []
        for (const line of stdout.split('\n')) {
          const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(.*)$/.exec(line)
          if (!m) continue
          const cmd = m[5]
          const exe = tokenizeCommandLine(cmd)[0] ?? ''
          rows.push({
            pid: Number(m[1]),
            ppid: Number(m[2]),
            pgid: Number(m[3]),
            tpgid: Number(m[4]),
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
  /** The foreground process context, whether or not its executable is a known adapter. */
  foreground: DetectedProcessContext | null
  contextCheckedAt: number
  /** True only while the shell is waiting for a submitted/restored foreground command. */
  contextArmed: boolean
  /** Invalidates a process snapshot or cwd read that returns after a newer prompt/command. */
  contextEpoch: number
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
  /** One follow-up for a long shell builtin that has not spawned its CLI by the first probe. */
  contextRetries: number
  /** This pane's shell announces its prompt (it has shell integration). Then we are TOLD when
   *  a foreground command ends, and the re-anchor below — the blind backstop for shells that
   *  cannot tell us — is pure waste here. */
  hasPromptMarker: boolean
  /** Coalesce two different shell-integration protocols describing the same rendered prompt. */
  lastPromptMarker: string
  lastPromptAt: number
}

/** Everything this class touches outside itself. Injected by the COST gate, which drives the
 *  whole schedule on a fake clock and a fake process table and asserts how many listings each
 *  scenario performs — the cost model above is a contract, not a hope. */
export interface AgentProcDeps {
  snapshot?: (rootPids?: readonly number[]) => Promise<ProcRow[] | null>
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
    private readonly deps: AgentProcDeps = {},
    private readonly emitContext: (paneId: string, context: DetectedProcessContext | null) => void = () => {}
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
      foreground: null,
      contextCheckedAt: 0,
      contextArmed: expectAgent,
      contextEpoch: 0,
      probeAt: expectAgent ? this.now() + TRACK_PROBE_MS : null,
      probeSticky: expectAgent,
      pendingSubmits: 0,
      retries: expectAgent ? 1 : 0,
      contextRetries: 0,
      hasPromptMarker: false,
      lastPromptMarker: '',
      lastPromptAt: 0
    })
    this.reschedule()
  }

  /** A LINE was submitted into the pane (the user, or the app, pressed Enter). Something may be
   *  starting. Arm one probe — the shell coming back to its prompt cancels it, so an ordinary
   *  command costs nothing at all. Ignored while a foreground process owns the pane: those
   *  keystrokes are input to that program, not a command to the shell. A known agent that was
   *  backgrounded at a real prompt does not block a later foreground command. */
  commandSubmitted(paneId: string): void {
    const t = this.panes.get(paneId)
    if (!t || t.foreground) return
    t.contextArmed = true
    t.contextEpoch++
    t.pendingSubmits++
    t.contextRetries = 1
    t.lastPromptMarker = ''
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
  promptSeen(paneId: string, marker = 'generic'): void {
    const t = this.panes.get(paneId)
    if (!t) return
    const now = this.now()
    if (
      marker !== 'generic' &&
      t.lastPromptMarker &&
      t.lastPromptMarker !== marker &&
      Math.abs(now - t.lastPromptAt) <= PROMPT_COALESCE_MS
    ) return
    t.lastPromptMarker = marker
    t.lastPromptAt = now
    t.hasPromptMarker = true // this shell tells us when a command ends — the re-anchor can rest
    if (t.pendingSubmits > 0) t.pendingSubmits--
    if (t.pendingSubmits > 0) {
      t.contextRetries = 1
      t.probeAt = this.now() + SUBMIT_PROBE_MS // more lines queued behind it
    } else if (!t.probeSticky) {
      t.contextRetries = 0
      t.probeAt = null
    }
    t.contextEpoch++
    t.contextArmed = t.pendingSubmits > 0 || t.probeSticky
    // A shell prompt is authoritative foreground-group evidence. A background child may still
    // be alive, but it no longer owns the pane's active directory.
    if (t.foreground) {
      t.foreground = null
      this.emitContext(paneId, null)
    }
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
    if (![...this.panes.values()].some((t) => t.current || t.foreground)) return
    this.tickTimer = this.setTimer(() => this.tick(), LIVENESS_TICK_MS)
  }

  private tick(): void {
    this.tickTimer = undefined
    if (this.disposed) return
    const alive = this.deps.alive ?? isAlive
    let anyTracked = false
    for (const [paneId, t] of this.panes) {
      if (t.foreground) {
        if (alive(t.foreground.pid)) {
          anyTracked = true
          this.refreshContextCwd(paneId, t)
        } else {
          // A pipeline/wrapper can hand the foreground group to a surviving descendant without
          // returning to the shell. Hold the last context until the fresh snapshot can either
          // hand it off or retire it; a transient null would close the Git observation window.
          if (t.contextArmed) {
            anyTracked = true
            t.probeAt = this.now()
          } else {
            t.foreground = null
            this.emitContext(paneId, null)
          }
        }
      }
      if (t.current) {
        if (alive(t.current.pid)) {
          anyTracked = true
        } else {
          t.current = null // the agent died and no shell told us (this pane has no prompt marker)
          this.emit(paneId, null)
        }
      }
    }
    if (!anyTracked) {
      if (this.nextProbeAt() !== null) this.reschedule()
      return // nothing left to keep alive: the timer simply stops existing
    }
    // The re-anchor covers exactly one hole: an agent that died and had its pid RECYCLED onto
    // another process, in a pane whose shell never announces its prompt — so promptSeen's free
    // check can never run there. A shell WITH integration (every cmd.exe pane we spawn) needs
    // none of it, and a 30-minute agent session there costs zero listings instead of six.
    if (this.now() - this.lastSnapshotAt >= REANCHOR_MS) {
      for (const t of this.panes.values()) {
        if ((t.current || t.foreground) && !t.hasPromptMarker) t.probeAt = this.now()
      }
    }
    this.tickTimer = this.setTimer(() => this.tick(), LIVENESS_TICK_MS)
    if (this.nextProbeAt() !== null) this.reschedule()
  }

  private refreshContextCwd(paneId: string, t: TrackedPane): void {
    const foreground = t.foreground
    if (!foreground || this.now() - t.contextCheckedAt < CONTEXT_CWD_REFRESH_MS) return
    // The platform implementation returns null on Windows. A test/native host adapter may
    // still supply procCwd there, so only skip when the default implementation is in use.
    if (process.platform === 'win32' && !this.deps.procCwd) return
    t.contextCheckedAt = this.now()
    const contextEpoch = t.contextEpoch
    void (this.deps.procCwd ?? readProcessCwd)(foreground.pid).then((cwd) => {
      if (!cwd || this.disposed || this.panes.get(paneId) !== t) return
      if (
        t.contextEpoch !== contextEpoch ||
        t.foreground?.pid !== foreground.pid ||
        t.foreground.cwd === cwd
      ) return
      t.foreground = { ...t.foreground, cwd }
      this.emitContext(paneId, t.foreground)
    })
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
      const rows = await (this.deps.snapshot ?? snapshotProcesses)(
        [...this.panes.values()].map((pane) => pane.rootPid)
      )
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
      const byPid = new Map<number, ProcRow>()
      for (const r of rows) {
        byPid.set(r.pid, r)
        const kids = byParent.get(r.ppid)
        if (kids) kids.push(r)
        else byParent.set(r.ppid, [r])
      }
      const dueSet = new Set(due)
      // Read EVERY pane off this one listing, not just the ones that asked for it: it is
      // already paid for, and a verdict that costs nothing more is worth having. A pane whose
      // delay has not elapsed keeps its deadline when nothing is visible yet: its child may
      // simply not have spawned, so an early shared snapshot is not a negative verdict.
      for (const [paneId, t] of this.panes) {
        const wasDue = dueSet.has(t)
        if (wasDue) {
          t.probeAt = null
          t.probeSticky = false
        }
        const root = byPid.get(t.rootPid)
        const rootAgent = root ? matchAgentProcess(root.base, root.cmd) : null
        const found = rootAgent
          ? { agentId: rootAgent, pid: t.rootPid }
          : this.findAgentIn(byParent, t.rootPid)
        const replacedRoot = root && !SHELL_BINS.has(root.base) && isForegroundRow(root)
          ? { pid: root.pid }
          : null
        const backgroundBranch = t.current && !t.foreground && root?.pgid === undefined
          ? this.branchUnderRoot(byPid, t.rootPid, t.current.pid)
          : undefined
        const foreground = t.contextArmed
          ? (replacedRoot ?? this.findForegroundIn(byParent, t.rootPid, backgroundBranch))
          : null
        const previousContext = t.foreground
        let contextCwd: string | null = null
        if (foreground) {
          const contextEpoch = t.contextEpoch
          contextCwd = byPid.get(foreground.pid)?.cwd ??
            await (this.deps.procCwd ?? readProcessCwd)(foreground.pid)
          if (this.disposed || this.panes.get(paneId) !== t) return // pane replaced under the await
          if (!t.contextArmed || t.contextEpoch !== contextEpoch) continue
          // A positive early verdict is conclusive and can consume this pane's later deadline;
          // only a negative shared snapshot must preserve time for a child that has not spawned.
          t.probeAt = null
          t.probeSticky = false
          t.contextRetries = 0
          if (!contextCwd && previousContext?.pid === foreground.pid) {
            contextCwd = previousContext.cwd ?? null
          }
          const nextContext: DetectedProcessContext = {
            pid: foreground.pid,
            cwd: contextCwd ?? undefined,
            sinceMs:
              previousContext?.pid === foreground.pid
                ? previousContext.sinceMs
                : this.now() - FIRST_SEEN_SLACK_MS
          }
          t.foreground = nextContext
          t.contextCheckedAt = this.now()
          t.pendingSubmits = 0 // subsequent Enter keys belong to this foreground program
          if (
            previousContext?.pid !== nextContext.pid ||
            previousContext?.cwd !== nextContext.cwd
          ) {
            this.emitContext(paneId, nextContext)
          }
        } else if (previousContext) {
          t.foreground = null
          this.emitContext(paneId, null)
        }
        const prev = t.current
        if (!foreground) {
          // A restoring pane gets one more look: it typed its own resume into a shell that was
          // still booting, so its agent can arrive after this listing — and nothing will ever
          // announce it. Sticky, because the shell's prompt is not evidence either way here.
          if (wasDue && !found && t.retries > 0) {
            t.retries--
            t.probeAt = this.now() + TRACK_RETRY_MS
            t.probeSticky = true
          } else if (wasDue && t.pendingSubmits <= 1 && t.contextRetries > 0) {
            // PowerShell functions/cmd builtins can remain inside the shell for longer than the
            // initial delay and spawn the real CLI afterwards. One bounded retry covers that
            // shape without turning an unknown long command into continuous process polling.
            t.contextRetries--
            t.probeAt = this.now() + MIN_SNAPSHOT_GAP_MS
          }
          if (
            (wasDue || previousContext !== null) &&
            !foreground &&
            t.probeAt === null &&
            t.contextArmed &&
            t.pendingSubmits <= 1
          ) {
            t.contextArmed = false
            t.pendingSubmits = 0
            if (!previousContext) this.emitContext(paneId, null)
          }
        }
        if (!found) {
          if (!prev) continue
          t.current = null
          this.emit(paneId, null)
          continue
        }
        t.retries = 0
        if (prev && prev.pid === found.pid && prev.agentId === found.agentId) continue
        const agentCwd = found.pid === foreground?.pid
          ? contextCwd
          : byPid.get(found.pid)?.cwd ?? await (this.deps.procCwd ?? readProcessCwd)(found.pid)
        if (this.disposed || this.panes.get(paneId) !== t) return
        const det: DetectedAgentProc = {
          agentId: found.agentId,
          pid: found.pid,
          cwd: agentCwd ?? undefined,
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

  /** The foreground command independent of provider identity. POSIX process groups make this
   * exact. Win32_Process does not expose a foreground group, so the shell's submitted-line and
   * prompt boundaries bracket the snapshot and the shallowest live descendant is the command
   * the shell is waiting for. Background commands prompt before the delayed probe and cancel it. */
  private findForegroundIn(
    byParent: Map<number, ProcRow[]>,
    rootPid: number,
    excludedBranch?: number
  ): { pid: number } | null {
    let level = [rootPid]
    const seen = new Set<number>(level)
    while (level.length) {
      const next: number[] = []
      const hits: number[] = []
      for (const pid of level) {
        for (const child of byParent.get(pid) ?? []) {
          if (seen.has(child.pid)) continue
          seen.add(child.pid)
          if (child.pid === excludedBranch) continue
          if (isForegroundRow(child)) hits.push(child.pid)
          next.push(child.pid)
        }
      }
      if (hits.length) return { pid: hits.sort((a, b) => a - b)[0] }
      level = next
    }
    return null
  }

  /** Return the direct child of `rootPid` that contains `pid`, for excluding a known
   * background agent's whole branch from a later foreground command on Windows. */
  private branchUnderRoot(byPid: Map<number, ProcRow>, rootPid: number, pid: number): number | undefined {
    let current = byPid.get(pid)
    if (!current) return undefined
    const seen = new Set<number>()
    while (current.ppid !== rootPid) {
      if (seen.has(current.pid) || current.ppid <= 0) return undefined
      seen.add(current.pid)
      const parent = byPid.get(current.ppid)
      if (!parent) return undefined
      current = parent
    }
    return current.pid
  }
}
