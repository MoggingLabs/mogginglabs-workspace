import { describe, expect, it } from 'vitest'
import {
  AgentProcessDetector,
  countSubmittedLines,
  isInteractiveShellRow,
  isRecycledPpidEdge,
  parseEtimeMs,
  type ProcRow
} from '@backend/features/agent-state/agent-proc'
import { isSubmittedInput } from '@backend/features/agent-state/replies'

// The recycled-ppid guard: Windows reuses pids aggressively, so a long-lived
// process can claim a ppid that NOW belongs to a brand-new pane shell — and a
// stray agent running anywhere on the machine reads as "this pane's agent".
// The board's typed-launch handoff trusts that verdict with user prose, which
// is why an impossible edge (child older than its parent) must never be
// followed. Found live on 2026-07-16: a running aider grafted onto fresh
// queue-launched panes exactly this way.

const row = (pid: number, ppid: number, startedAt?: number): ProcRow => ({
  pid,
  ppid,
  base: 'x',
  cmd: 'x',
  ...(startedAt !== undefined ? { startedAt } : {})
})

describe('isRecycledPpidEdge', () => {
  it('drops the impossible edge: the child predates its claimed parent', () => {
    const child = row(200, 100, 1_000_000) // created long ago
    const parent = row(100, 1, 2_000_000) // the pid's NEW owner, created later
    expect(isRecycledPpidEdge(child, parent)).toBe(true)
  })

  it('keeps a real chain (parent predates child)', () => {
    expect(isRecycledPpidEdge(row(200, 100, 2_000_000), row(100, 1, 1_000_000))).toBe(false)
  })

  it('tolerates clock rounding inside the slack', () => {
    expect(isRecycledPpidEdge(row(200, 100, 1_000_000), row(100, 1, 1_000_300))).toBe(false)
  })

  it('fails OPEN when either timestamp is missing (POSIX rows)', () => {
    expect(isRecycledPpidEdge(row(200, 100), row(100, 1, 1_000_000))).toBe(false)
    expect(isRecycledPpidEdge(row(200, 100, 1_000_000), row(100, 1))).toBe(false)
  })
})

// F001 — a BRACKETED paste is composing, not answering.
//
// `isSubmittedInput` (replies.ts) has always bailed on an ESC-introduced chunk, naming
// bracketed paste in its comment. `countSubmittedLines` did not, and both are called from the
// same block in the two write paths (pty.service.ts and the daemon's session.ts twin). So a
// 2,000-line paste — a log tail, a stack trace — armed 2,000 command-starts. The damage does
// not decay: `pendingSubmits` only resets at `<= 1`, so every later prompt in that pane bought
// a full process-table listing (700-1100ms of CIM on Windows, by agent-proc's own measurement),
// and `pendingStarts` kept `commandActive` true, which is the exact flag `acceptWorktree` reads
// to refuse letting a background `git` relabel the pane's cwd — and the flag the daemon's
// `foreground` publisher reports as `active`.
describe('countSubmittedLines', () => {
  const BRACKET_ON = '\x1b[200~'
  const BRACKET_OFF = '\x1b[201~'

  it('counts bare submitted lines', () => {
    expect(countSubmittedLines('one\r\ntwo\nthree\r')).toBe(3)
    expect(countSubmittedLines('a\rb\r')).toBe(2)
    expect(countSubmittedLines('no newline')).toBe(0)
    expect(countSubmittedLines('')).toBe(0)
  })

  it('counts ZERO inside a bracketed paste, however many CRs it carries', () => {
    expect(countSubmittedLines(`${BRACKET_ON}a\rb\rc${BRACKET_OFF}`)).toBe(0)
    // The shape that broke it: a big paste, every line CR-separated by sanitizePaste.
    const big = `${BRACKET_ON}${'line\r'.repeat(2000)}${BRACKET_OFF}`
    expect(countSubmittedLines(big)).toBe(0)
  })

  it('agrees with isSubmittedInput on the ESC rule', () => {
    // The two are read together at the same call site; if they ever disagree again, the
    // cost model and the cwd lane disagree with the attention latch about the same bytes.
    const paste = `${BRACKET_ON}a\rb${BRACKET_OFF}`
    expect(isSubmittedInput(paste)).toBe(false)
    expect(countSubmittedLines(paste)).toBe(0)
    expect(isSubmittedInput('a\r')).toBe(true)
    expect(countSubmittedLines('a\r')).toBe(1)
  })
})

// F048 — a shell the user is SITTING IN vs a shell RUNNING something. They wear the same
// basename, and only the command line tells them apart. The predicate has to discriminate,
// not merely disarm: say yes too often and every `npm run dev` pane buys a process listing
// every five minutes forever; say no too often and F037's nested agent goes back to being
// invisible.
const shellRow = (base: string, cmd: string): ProcRow => ({ pid: 320, ppid: 100, base, cmd })

describe('isInteractiveShellRow', () => {
  it('says YES to a bare nested shell (the pane the user typed `powershell` into)', () => {
    expect(isInteractiveShellRow(shellRow('powershell', 'powershell.exe'))).toBe(true)
    expect(isInteractiveShellRow(shellRow('cmd', 'cmd.exe'))).toBe(true)
    expect(isInteractiveShellRow(shellRow('bash', 'bash'))).toBe(true)
    expect(isInteractiveShellRow(shellRow('bash', '/usr/bin/bash'))).toBe(true)
  })

  it('says YES when every argument is an INTERACTIVITY switch', () => {
    expect(isInteractiveShellRow(shellRow('bash', 'bash -i'))).toBe(true)
    expect(isInteractiveShellRow(shellRow('bash', 'bash --login --norc'))).toBe(true)
    expect(isInteractiveShellRow(shellRow('zsh', 'zsh -l'))).toBe(true)
    expect(isInteractiveShellRow(shellRow('pwsh', 'pwsh -NoLogo -NoExit'))).toBe(true)
  })

  it('says NO to a shell handed a command string — the Windows dev-server shape', () => {
    // PowerShell cannot CreateProcess a `.cmd`, so THIS is what `npm run dev` looks like.
    expect(
      isInteractiveShellRow(
        shellRow('cmd', '"C:\\WINDOWS\\system32\\cmd.exe" /c ""C:\\Program Files\\nodejs\\npm.cmd" run dev"')
      )
    ).toBe(false)
    expect(isInteractiveShellRow(shellRow('sh', 'sh -c "echo hi"'))).toBe(false)
    expect(isInteractiveShellRow(shellRow('bash', 'bash -lc "make build"'))).toBe(false)
  })

  it('says NO to a shell handed a SCRIPT', () => {
    expect(isInteractiveShellRow(shellRow('bash', 'bash ./scripts/dev.sh'))).toBe(false)
    expect(isInteractiveShellRow(shellRow('sh', '/bin/sh ./gradlew build'))).toBe(false)
  })

  it('says NO to anything that is not a shell at all', () => {
    expect(isInteractiveShellRow(shellRow('node', 'node server.js'))).toBe(false)
    expect(isInteractiveShellRow(shellRow('vim', 'vim'))).toBe(false)
  })

  it('fails CLOSED on a missing or unreadable command line', () => {
    // An unreadable cmd is not evidence of an interactive shell. Saying no costs that pane
    // the pre-flag behaviour (zero re-anchor listings) — the safe direction.
    expect(isInteractiveShellRow(undefined)).toBe(false)
    expect(isInteractiveShellRow(shellRow('powershell', ''))).toBe(false)
    expect(isInteractiveShellRow(shellRow('powershell', '   '))).toBe(false)
  })
})

// F037/F048 at the detector level — the same World the TYPEDCOST gate drives (fake clock,
// fake process table), reduced to the three cases the flag decides. What is asserted is the
// pair that has to hold TOGETHER: the agent inside a nested shell is FOUND, and the two
// dev-server shapes that merely look like nested shells still cost exactly one listing.
interface FakeProc {
  ppid: number
  base: string
  cmd: string
  cwd?: string
  pgid?: number
  tpgid?: number
}

class World {
  now = 1_000_000
  listings = 0
  readonly procs = new Map<number, FakeProc>()
  readonly agents: Array<string | null> = []
  readonly contexts: Array<{ pid: number | null; command?: string }> = []
  private timers: Array<{ fn: () => void; at: number; id: number }> = []
  private nextId = 1

  readonly detector = new AgentProcessDetector(
    (_paneId, det) => this.agents.push(det?.agentId ?? null),
    () => this.now,
    {
      snapshot: async (): Promise<ProcRow[]> => {
        this.listings++
        return [...this.procs.entries()].map(([pid, p]) => ({
          pid,
          ppid: p.ppid,
          base: p.base,
          cmd: p.cmd,
          pgid: p.pgid,
          tpgid: p.tpgid
        }))
      },
      procCwd: async (pid) => this.procs.get(pid)?.cwd ?? null,
      alive: (pid) => this.procs.has(pid),
      setTimer: (fn, ms) => {
        const t = { fn, at: this.now + Math.max(0, ms), id: this.nextId++ }
        this.timers.push(t)
        return t.id
      },
      clearTimer: (h) => {
        this.timers = this.timers.filter((t) => t.id !== h)
      }
    },
    (_paneId, context) => this.contexts.push({ pid: context?.pid ?? null, command: context?.command })
  )

  /** Advance the clock, firing every timer that comes due and letting each async listing
   *  settle before the next one (the detector awaits inside its snapshot). */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.now = Math.max(this.now, due.at)
      this.timers = this.timers.filter((t) => t.id !== due.id)
      due.fn()
      for (let i = 0; i < 16; i++) await Promise.resolve()
    }
    this.now = end
    for (let i = 0; i < 16; i++) await Promise.resolve()
  }
}

const SHELL = 100

describe('nested interactive shell (re-anchor)', () => {
  it('finds an agent started inside a nested shell, for two listings', async () => {
    const w = new World()
    w.procs.set(SHELL, { ppid: 1, base: 'cmd', cmd: 'cmd.exe' })
    w.detector.track('p1', SHELL)
    w.detector.promptSeen('p1') // the OUTER shell has integration: hasPromptMarker latches true
    await w.advance(20_000)
    w.detector.commandSubmitted('p1') // the user types: powershell
    // Its command line is load-bearing: bare, so it is INTERACTIVE.
    w.procs.set(320, { ppid: SHELL, base: 'powershell', cmd: 'powershell.exe', cwd: 'C:\\repo' })
    await w.advance(5_000) // listing 1: the pane's foreground is itself a SHELL
    expect(w.listings).toBe(1)
    // The nested shell owns the foreground, so this Enter is ITS input — nothing is armed.
    w.detector.commandSubmitted('p1')
    w.procs.set(321, { ppid: 320, base: 'claude', cmd: 'claude', cwd: 'C:\\repo' })
    await w.advance(6 * 60_000) // only the re-anchor can still find it (listing 2)

    expect(w.listings).toBe(2)
    expect(w.agents).toEqual(['claude']) // the whole identity stack was blind to this pane
    // The provider-neutral lane still names the SHELL, not the agent: `foreground` answers
    // "would closing this pane kill something", and the agent lane answers identity. A
    // nested shell must never read as agent-live on the foreground channel.
    expect(w.contexts).toEqual([{ pid: 320, command: 'powershell' }])
  })

  it('does NOT re-anchor for `cmd /c npm.cmd run dev` from a PowerShell pane', async () => {
    const w = new World()
    w.procs.set(SHELL, { ppid: 1, base: 'powershell', cmd: 'powershell.exe' })
    w.detector.track('p1', SHELL)
    w.detector.promptSeen('p1')
    await w.advance(20_000)
    w.detector.commandSubmitted('p1') // the user types: npm run dev
    w.procs.set(200, {
      ppid: SHELL,
      base: 'cmd',
      cmd: '"C:\\WINDOWS\\system32\\cmd.exe" /c ""C:\\Program Files\\nodejs\\npm.cmd" run dev"',
      cwd: 'C:\\repo'
    })
    await w.advance(10 * 60_000) // it streams and never prompts

    expect(w.listings).toBe(1) // a basename-only flag bought one every REANCHOR_MS here
    expect(w.contexts).toEqual([{ pid: 200, command: 'cmd' }])
    expect(w.agents).toEqual([])
  })

  it('does NOT re-anchor for `bash ./scripts/dev.sh` (the POSIX spelling)', async () => {
    const w = new World()
    w.procs.set(SHELL, { ppid: 1, base: 'bash', cmd: 'bash', pgid: SHELL, tpgid: SHELL })
    w.detector.track('p1', SHELL)
    w.detector.promptSeen('p1')
    await w.advance(20_000)
    w.detector.commandSubmitted('p1')
    w.procs.set(210, {
      ppid: SHELL,
      base: 'bash',
      cmd: 'bash ./scripts/dev.sh',
      cwd: '/repo',
      pgid: 210,
      tpgid: 210
    })
    await w.advance(10 * 60_000)

    expect(w.listings).toBe(1)
    expect(w.contexts).toEqual([{ pid: 210, command: 'bash' }])
    expect(w.agents).toEqual([])
  })
})

// `ps` etime -> startedAt is what gives POSIX rows creation-time evidence at all —
// both for the recycled-ppid guard above and for the context watch's sinceMs floor.
describe('parseEtimeMs', () => {
  it('parses every documented shape ([[dd-]hh:]mm:ss)', () => {
    expect(parseEtimeMs('00:05')).toBe(5_000)
    expect(parseEtimeMs('12:34')).toBe((12 * 60 + 34) * 1000)
    expect(parseEtimeMs('3:02:01')).toBe(((3 * 60 + 2) * 60 + 1) * 1000)
    expect(parseEtimeMs('2-03:04:05')).toBe((((2 * 24 + 3) * 60 + 4) * 60 + 5) * 1000)
  })

  it('yields undefined for foreign shapes (a defunct row prints "-")', () => {
    expect(parseEtimeMs('-')).toBeUndefined()
    expect(parseEtimeMs('')).toBeUndefined()
    expect(parseEtimeMs('123')).toBeUndefined()
  })
})
