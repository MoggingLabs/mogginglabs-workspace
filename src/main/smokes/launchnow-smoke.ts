import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

// LAUNCHNOW gate (MOGGING_LAUNCHNOW): the instant-lineup contract, after the fixed
// 900ms launchLineup delay was removed (2026-07). A template open with an agent slot
// must type that slot's launch command on the pane's READINESS SIGNAL, not on a timer:
//
//   (1) exactly ONE launch-shaped write lands in the agent pane, and NONE in the
//       shell pane (the negative — proven by the ptyWrites spy, not the buffer);
//   (2) the write lands AFTER the pane's first PTY output (an early write is silently
//       dropped by the daemon — the Linux-sweep regression this ordering guards);
//   (3) the write lands within GAP_MS of that first output — a reintroduced fixed
//       lineup delay (the old 900ms, or any successor) fails this arithmetic;
//   (4) the command BUILD (agent:command) started BEFORE the pane went live — the
//       prefetch overlap that hides main-side config I/O inside the shell boot.
//
// All timestamps share one clock (renderer performance.now): the ptyWrites /
// agentCommandCalls DEV seams and agents.paneLiveAt. No assertion reads wall-clock
// totals (shell boot varies by machine); only the app-imposed gap is bounded.
// Writes out/launchnow-result.json, then exits (0=pass, 1=fail).

// The app-imposed live→write budget. Same-tick in principle; generous for CI load,
// while still strictly below the 900ms class of fixed delays this gate exists to bury.
const GAP_MS = 800
// Prefetch grace: the build starts a few microtasks after the lineup request, the
// first PTY byte needs a full spawn round trip — 100ms of scheduler jitter allowed.
const PREFETCH_GRACE_MS = 100
const AGENT_PANE = 102 // 2nd workspace (ordinal 1) -> base 100; mix [shell, claude] -> slot 2
const SHELL_PANE = 101

export function runLaunchNowSmoke(win: BrowserWindow): void {
  setTimeout(() => app.exit(1), 90000) // safety net
  const wc = win.webContents
  let done = false
  const ES = (js: string): Promise<unknown> => wc.executeJavaScript(js)
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const emit = (o: object): void => {
    try {
      writeFileSync(join(app.getAppPath(), 'out', 'launchnow-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }

  interface SpyWrite {
    id: number
    data: string
    at: number
  }

  const run = async (): Promise<void> => {
    if (done) return
    done = true
    try {
      await delay(500)
      // Launcher-first boot: base workspace first so the template one is ordinal 1.
      await ES(
        '(function(){var m=window.__mogging;' +
          'if(m&&m.workspace&&m.workspace.count()===0)m.workspace.create({name:"Workspace 1"});return 1;})()'
      )
      await delay(600)
      // Plant BOTH spies before the open — every launch byte and build call is caught.
      await ES('(function(){window.__mogging.ptyWrites=[];window.__mogging.agentCommandCalls=[];return 1;})()')
      await ES("window.__mogging.templates.open([{provider:'shell',count:1},{provider:'claude',count:1}])")

      // Poll for the launch write (a cd/Set-Location prefix naming claude) — the pane
      // must first boot its shell, so this is the one legitimately variable wait.
      const findLaunch =
        `(function(){var ws=(window.__mogging.ptyWrites||[]).filter(function(w){` +
        `return w.id===${AGENT_PANE}&&/^(cd|chdir|Set-Location)\\b/i.test(String(w.data))&&/claude/.test(String(w.data))});` +
        `return JSON.stringify(ws);})()`
      let launchWrites: SpyWrite[] = []
      for (let i = 0; i < 120 && launchWrites.length === 0; i++) {
        await delay(250)
        launchWrites = JSON.parse(String(await ES(findLaunch))) as SpyWrite[]
      }
      // Settle window: catches an erroneous SECOND launch write (double-fire) and any
      // late launch-shaped write into the shell pane.
      await delay(1500)
      launchWrites = JSON.parse(String(await ES(findLaunch))) as SpyWrite[]
      const shellLaunchWrites = JSON.parse(
        String(
          await ES(
            `(function(){var ws=(window.__mogging.ptyWrites||[]).filter(function(w){` +
              `return w.id===${SHELL_PANE}&&/^(cd|chdir|Set-Location)\\b/i.test(String(w.data))&&/claude/.test(String(w.data))});` +
              `return JSON.stringify(ws);})()`
          )
        )
      ) as SpyWrite[]
      const liveAt = (await ES(`window.__mogging.agents.paneLiveAt(${AGENT_PANE})`)) as number | null
      const commandCalls = JSON.parse(
        String(await ES('JSON.stringify(window.__mogging.agentCommandCalls||[])'))
      ) as { paneId?: number; agentId?: string; at: number }[]
      const build = commandCalls.find((c) => c.paneId === AGENT_PANE && c.agentId === 'claude')

      const launch = launchWrites[0]
      const exactlyOneLaunch = launchWrites.length === 1
      const shellPaneClean = shellLaunchWrites.length === 0
      const wroteAfterLive = !!launch && liveAt !== null && launch.at >= liveAt
      const gapMs = launch && liveAt !== null ? launch.at - liveAt : null
      const instant = gapMs !== null && gapMs <= GAP_MS
      const prefetched = !!build && liveAt !== null && build.at <= liveAt + PREFETCH_GRACE_MS

      const pass = exactlyOneLaunch && shellPaneClean && wroteAfterLive && instant && prefetched
      emit({
        pass,
        exactlyOneLaunch,
        shellPaneClean,
        wroteAfterLive,
        instant,
        gapMs,
        gapBudgetMs: GAP_MS,
        prefetched,
        liveAt,
        buildAt: build?.at ?? null,
        writeAt: launch?.at ?? null,
        launchData: launch ? String(launch.data).slice(0, 300) : null,
        launchWriteCount: launchWrites.length,
        commandCalls
      })
      app.exit(pass ? 0 : 1)
    } catch (e) {
      emit({ pass: false, error: String(e) })
      app.exit(1)
    }
  }

  wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
}
