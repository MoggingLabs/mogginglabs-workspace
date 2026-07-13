import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { AgentProcessDetector, type ProcRow } from '@backend/features/agent-state'

// Env-gated TYPED-DETECTION COST gate (MOGGING_TYPEDCOST). Windowless: no daemon, no pane, no
// real process listing — the detector is driven on a FAKE clock over a FAKE process table, and
// what is asserted is the one number that decides whether this feature is affordable: HOW MANY
// PROCESS LISTINGS it performs.
//
// It exists because that number is invisible in review. A listing costs 700-1100 ms of a
// background PowerShell on Windows (measured; `wmic`, the cheap one, is gone from Windows), so
// a detector that probes on the wrong signal is not a little slower — it is a permanent CPU
// leak nobody sees. An earlier version of this file probed on every busy/idle EDGE, which reads
// as harmless and is not: bursty output flips that edge every couple of seconds, so a single
// `npm run dev` pane would have burned a listing every 3 s for as long as it ran. That is the
// regression this gate is here to make impossible to reintroduce quietly.
//
// The scenarios are the app's real life, and each carries its own ceiling. Cheap is worthless
// if it is also wrong, so every scenario that CONTAINS an agent must still find it, and every
// exit must still retire it — the same assertions, against the same code, as the live gate.
//
// Writes out/typedcost-result.json, then exits (0=pass, 1=fail).

interface Timer {
  fn: () => void
  at: number
  id: number
}

/** A world with a clock we own: timers fire when we say, processes exist when we say. */
class World {
  now = 1_000_000
  listings = 0
  readonly procs = new Map<number, {
    ppid: number
    base: string
    cmd: string
    cwd?: string
    pgid?: number
    tpgid?: number
  }>()
  readonly emissions: Array<{ paneId: string; agent: string | null }> = []
  readonly contexts: Array<{ paneId: string; pid: number | null; cwd?: string }> = []
  private timers: Timer[] = []
  private nextId = 1

  readonly detector = new AgentProcessDetector(
    (paneId, det) => this.emissions.push({ paneId, agent: det?.agentId ?? null }),
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
        const t: Timer = { fn, at: this.now + Math.max(0, ms), id: this.nextId++ }
        this.timers.push(t)
        return t.id
      },
      clearTimer: (h) => {
        this.timers = this.timers.filter((t) => t.id !== h)
      }
    },
    (paneId, context) => this.contexts.push({
      paneId,
      pid: context?.pid ?? null,
      cwd: context?.cwd
    })
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
const CLAUDE_CMD = 'node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'

interface Case {
  name: string
  /** The ceiling. A listing is ~1 s of a background PowerShell — these are not style points. */
  maxListings: number
  /** This scenario contains an agent, and detection must find it. */
  mustDetect?: boolean
  /** …and must retire it when it goes. */
  mustRetire?: boolean
  /** A provider-neutral foreground context must be found without inventing an agent id. */
  context?: { pid: number; cwd?: string; retire?: boolean; unidentified?: boolean }
  run: (w: World) => Promise<void>
}

const CASES: Case[] = [
  {
    // A workspace of plain terminals must cost NOTHING. A fresh shell cannot already contain an
    // agent, and anything typed into it later announces itself.
    name: 'four idle shell panes, 10 min',
    maxListings: 0,
    run: async (w) => {
      for (let i = 1; i <= 4; i++) {
        w.procs.set(SHELL + i, { ppid: 1, base: 'cmd', cmd: 'cmd.exe' })
        w.detector.track('p' + i, SHELL + i)
        w.detector.promptSeen('p' + i) // the shell boots and prints its first prompt
      }
      await w.advance(10 * 60_000)
    }
  },
  {
    // Ordinary commands cost NOTHING: the shell's prompt comes back long before the armed
    // probe fires, and cancels it.
    name: 'twenty ordinary commands',
    maxListings: 0,
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'cmd', cmd: 'cmd.exe' })
      w.detector.track('p1', SHELL)
      w.detector.promptSeen('p1')
      await w.advance(20_000)
      for (let i = 0; i < 20; i++) {
        w.detector.commandSubmitted('p1')
        await w.advance(120)
        w.detector.promptSeen('p1')
        await w.advance(6_000)
      }
    }
  },
  {
    // THE REGRESSION THIS GATE EXISTS FOR. A dev server streams output for ten minutes and
    // never prompts. One look is correct (something IS running in there — we must find out
    // what). Probing on output would have cost ~200.
    name: 'npm run dev, 10 min of bursty output',
    maxListings: 1,
    context: { pid: 200, unidentified: true },
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'cmd', cmd: 'cmd.exe' })
      w.detector.track('p1', SHELL)
      w.detector.promptSeen('p1')
      await w.advance(20_000)
      w.detector.commandSubmitted('p1')
      w.procs.set(200, { ppid: SHELL, base: 'node', cmd: 'node C:\\repo\\server.js' }) // not an agent
      await w.advance(10 * 60_000)
    }
  },
  {
    // The feature this gate now protects: an executable absent from every adapter still owns a
    // trustworthy process cwd. Enter presses after detection are its input, not new shell jobs.
    name: 'arbitrary CLI changes cwd and then exits to prompt',
    maxListings: 1,
    context: { pid: 250, cwd: 'C:\\repo\\alternate-worktree', retire: true, unidentified: true },
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'cmd', cmd: 'cmd.exe' })
      w.detector.track('p1', SHELL)
      w.detector.promptSeen('p1')
      w.detector.commandSubmitted('p1')
      w.procs.set(250, {
        ppid: SHELL,
        base: 'future-agent',
        cmd: 'future-agent --workspace alternate-worktree',
        cwd: 'C:\\repo\\alternate-worktree'
      })
      await w.advance(5_000)
      for (let i = 0; i < 20; i++) {
        w.detector.commandSubmitted('p1')
        await w.advance(1_000)
      }
      // A prompt retires foreground ownership even if the process deliberately backgrounded
      // itself and remains alive.
      w.detector.promptSeen('p1')
      await w.advance(10_000)
    }
  },
  {
    // POSIX can prove the actual foreground process group. A lower-pid background watcher in
    // the same pane must not steal context from the foreground arbitrary CLI.
    name: 'foreground process group beats background descendant',
    maxListings: 1,
    context: { pid: 270, cwd: '/repo/foreground', unidentified: true },
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'bash', cmd: 'bash' })
      w.detector.track('p1', SHELL)
      w.detector.promptSeen('p1')
      w.detector.commandSubmitted('p1')
      w.procs.set(260, {
        ppid: SHELL,
        base: 'watcher',
        cmd: 'watcher',
        cwd: '/repo/background',
        pgid: 260,
        tpgid: 270
      })
      w.procs.set(270, {
        ppid: SHELL,
        base: 'future-agent',
        cmd: 'future-agent',
        cwd: '/repo/foreground',
        pgid: 270,
        tpgid: 270
      })
      await w.advance(5_000)
    }
  },
  {
    // POSIX `exec future-agent` replaces the shell process instead of creating a descendant.
    // The tracked root must become eligible once it is no longer an interactive shell.
    name: 'arbitrary CLI replaces the shell with exec',
    maxListings: 1,
    context: { pid: SHELL, cwd: '/repo/exec-target', unidentified: true },
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'bash', cmd: 'bash', pgid: SHELL, tpgid: SHELL })
      w.detector.track('p1', SHELL)
      w.detector.promptSeen('p1')
      w.detector.commandSubmitted('p1')
      w.procs.set(SHELL, {
        ppid: 1,
        base: 'future-agent',
        cmd: 'future-agent',
        cwd: '/repo/exec-target',
        pgid: SHELL,
        tpgid: SHELL
      })
      await w.advance(5_000)
    }
  },
  {
    // A launcher can exit after handing control to the actual CLI without returning a shell
    // prompt. The foreground lane must re-anchor to the surviving process, not disappear.
    name: 'arbitrary launcher hands off to surviving CLI',
    maxListings: 2,
    context: { pid: 281, cwd: '/repo/handed-off', unidentified: true },
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'bash', cmd: 'bash' })
      w.detector.track('p1', SHELL)
      w.detector.promptSeen('p1')
      w.detector.commandSubmitted('p1')
      w.procs.set(280, {
        ppid: SHELL,
        base: 'launcher',
        cmd: 'launcher',
        cwd: '/repo/launcher',
        pgid: 280,
        tpgid: 280
      })
      w.procs.set(281, {
        ppid: 280,
        base: 'future-agent',
        cmd: 'future-agent',
        cwd: '/repo/handed-off',
        pgid: 280,
        tpgid: 280
      })
      await w.advance(5_000)
      w.procs.delete(280)
      w.procs.set(281, {
        ppid: SHELL,
        base: 'future-agent',
        cmd: 'future-agent',
        cwd: '/repo/handed-off',
        pgid: 281,
        tpgid: 281
      })
      await w.advance(10_000)
    }
  },
  {
    // A shell function/cmdlet can do work inside the shell before it finally spawns the CLI.
    // One bounded retry covers that delayed child without creating a polling loop.
    name: 'shell builtin delays arbitrary CLI spawn',
    maxListings: 2,
    context: { pid: 285, cwd: '/repo/delayed-spawn', unidentified: true },
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'powershell', cmd: 'powershell.exe' })
      w.detector.track('p1', SHELL)
      w.detector.promptSeen('p1')
      w.detector.commandSubmitted('p1')
      await w.advance(2_500) // first probe sees only the shell
      w.procs.set(285, {
        ppid: SHELL,
        base: 'future-agent',
        cmd: 'future-agent',
        cwd: '/repo/delayed-spawn'
      })
      await w.advance(5_000)
    }
  },
  {
    // One pane's due snapshot is shared with every pane, but it must not consume another
    // pane's not-yet-due deadline before that pane's delayed child has had time to spawn.
    name: 'shared snapshot preserves a later pane deadline',
    maxListings: 2,
    context: { pid: 291, cwd: '/repo/delayed', unidentified: true },
    run: async (w) => {
      w.procs.set(SHELL + 1, { ppid: 1, base: 'bash', cmd: 'bash' })
      w.procs.set(SHELL + 2, { ppid: 1, base: 'bash', cmd: 'bash' })
      w.detector.track('p1', SHELL + 1)
      w.detector.track('p2', SHELL + 2)
      w.detector.promptSeen('p1')
      w.detector.promptSeen('p2')
      w.detector.commandSubmitted('p1')
      await w.advance(1_500)
      w.detector.commandSubmitted('p2')
      await w.advance(1_000) // p1's shared snapshot is early for p2
      w.procs.set(291, {
        ppid: SHELL + 2,
        base: 'future-agent',
        cmd: 'future-agent',
        cwd: '/repo/delayed'
      })
      await w.advance(5_000)
    }
  },
  {
    // A known agent can remain backgrounded after the shell prompts. It still owns its strict
    // identity, but its branch must not block or steal a later arbitrary foreground context.
    name: 'background known agent does not mask arbitrary foreground CLI',
    maxListings: 3,
    context: { pid: 310, cwd: 'C:\\repo\\new-foreground' },
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'cmd', cmd: 'cmd.exe' })
      w.procs.set(300, { ppid: SHELL, base: 'claude', cmd: 'claude', cwd: 'C:\\repo\\known' })
      w.detector.track('p1', SHELL, true)
      await w.advance(5_000)
      w.detector.promptSeen('p1')
      w.detector.commandSubmitted('p1')
      await w.advance(2_500) // the recycled-agent confirmation snapshot is early for this child
      w.procs.set(310, {
        ppid: SHELL,
        base: 'future-agent',
        cmd: 'future-agent',
        cwd: 'C:\\repo\\new-foreground'
      })
      await w.advance(5_000)
    }
  },
  {
    // The steady state of the whole app: an agent running, a conversation happening. Every
    // message is an Enter, and none of them costs anything — the pane's agent is confirmed by
    // a signal-0, never by a listing.
    name: 'typed claude + 30 min conversation',
    maxListings: 1,
    mustDetect: true,
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'cmd', cmd: 'cmd.exe' })
      w.detector.track('p1', SHELL)
      w.detector.promptSeen('p1')
      await w.advance(20_000)
      w.detector.commandSubmitted('p1') // the user types: claude
      w.procs.set(300, { ppid: SHELL, base: 'node', cmd: CLAUDE_CMD })
      await w.advance(5_000)
      for (let i = 0; i < 60; i++) {
        w.detector.commandSubmitted('p1') // a message to the agent, not a command to the shell
        await w.advance(30_000)
      }
    }
  },
  {
    // A cold restore (a reboot): the session types its OWN resume into a still-booting shell,
    // so the agent appears with nobody to announce it — and the shell's prompt arrives BEFORE
    // that command has run, so it must not be read as "nothing is running".
    name: 'cold restore types its own resume',
    maxListings: 2,
    mustDetect: true,
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'cmd', cmd: 'cmd.exe' })
      w.detector.track('p1', SHELL, true) // expectAgent
      w.detector.promptSeen('p1')
      await w.advance(3_000)
      w.procs.set(400, { ppid: SHELL, base: 'claude', cmd: 'claude --resume' }) // boots late
      await w.advance(10 * 60_000)
    }
  },
  {
    // TYPE-AHEAD: `claude` typed while a long install is still running. The install's prompt
    // belongs to the install — it must not cancel the probe meant for the agent behind it.
    name: 'type-ahead: npm install, then claude',
    maxListings: 2,
    mustDetect: true,
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'cmd', cmd: 'cmd.exe' })
      w.detector.track('p1', SHELL)
      w.detector.promptSeen('p1')
      await w.advance(20_000)
      w.detector.commandSubmitted('p1') // npm install (long)
      await w.advance(200)
      w.detector.commandSubmitted('p1') // …and `claude` typed behind it
      await w.advance(30_000)
      w.detector.promptSeen('p1', 'osc133') // the install finishes and prompts
      w.detector.promptSeen('p1', 'mogging') // same prompt, second integration protocol
      w.procs.set(300, { ppid: SHELL, base: 'node', cmd: CLAUDE_CMD })
      await w.advance(60_000)
    }
  },
  {
    // The agent exits. ONE listing, and it is the one that DISCOVERED the agent — retiring it
    // is free: the shell's prompt says look, and a signal-0 says it is gone.
    name: 'agent exits (prompt + dead pid)',
    maxListings: 1,
    mustDetect: true,
    mustRetire: true,
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'cmd', cmd: 'cmd.exe' })
      w.procs.set(300, { ppid: SHELL, base: 'claude', cmd: 'claude' })
      w.detector.track('p1', SHELL, true)
      await w.advance(20_000)
      w.procs.delete(300)
      w.detector.promptSeen('p1')
      await w.advance(30_000)
    }
  },
  {
    // …and the one case a pid check CANNOT see: the agent died and its pid was recycled onto
    // another process, so the signal-0 lies. TWO listings: one to discover the agent, one to
    // see through the recycled pid. The prompt is what gets us to look at all.
    name: 'pid recycled after exit (self-heals)',
    maxListings: 2,
    mustDetect: true,
    mustRetire: true,
    run: async (w) => {
      w.procs.set(SHELL, { ppid: 1, base: 'cmd', cmd: 'cmd.exe' })
      w.procs.set(300, { ppid: SHELL, base: 'claude', cmd: 'claude' })
      w.detector.track('p1', SHELL, true)
      await w.advance(20_000)
      w.procs.set(300, { ppid: 1, base: 'git', cmd: 'git status' }) // same pid, another process
      w.detector.promptSeen('p1')
      await w.advance(30_000)
    }
  }
]

export async function runTypedCostSmoke(): Promise<void> {
  const results: Array<Record<string, unknown>> = []
  let pass = true
  try {
    for (const c of CASES) {
      const w = new World()
      await c.run(w)
      w.detector.dispose()
      const detected = w.emissions.some((e) => e.agent)
      const retired = w.emissions.some((e) => e.agent === null)
      const contextDetected = c.context
        ? w.contexts.some((e) => e.pid === c.context!.pid && (c.context!.cwd === undefined || e.cwd === c.context!.cwd))
        : true
      const contextRetired = !c.context?.retire || w.contexts.some((e) => e.pid === null)
      const stayedUnidentified = !c.context?.unidentified || !detected
      const withinBudget = w.listings <= c.maxListings
      const ok = withinBudget && (!c.mustDetect || detected) && (!c.mustRetire || retired) &&
        contextDetected && contextRetired && stayedUnidentified
      if (!ok) pass = false
      results.push({
        name: c.name,
        listings: w.listings,
        maxListings: c.maxListings,
        withinBudget,
        detected,
        retired,
        contextDetected,
        contextRetired,
        stayedUnidentified,
        mustDetect: !!c.mustDetect,
        mustRetire: !!c.mustRetire,
        ok
      })
    }
  } catch (e) {
    pass = false
    results.push({ name: 'exception', error: String(e), ok: false })
  }
  try {
    writeFileSync(join(app.getAppPath(), 'out', 'typedcost-result.json'), JSON.stringify({ pass, cases: results }))
  } catch {
    /* best effort */
  }
  app.exit(pass ? 0 : 1)
}
