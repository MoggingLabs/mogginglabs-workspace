import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setAgentDetectOverrideForSmoke } from '../agents'
import { runtimeDir } from '../daemon-client'
import { AgentChannels, type AgentInfo, type AgentInstallState } from '@contracts'

// Env-gated pane profile-SWITCH smoke (MOGGING_PROFSWITCH) — the audit F1/F2 gate:
//   1. REATTACHED pane failover really types (F1): a pane wearing the daemon-reattach
//      mark (dev shim — the RELOAD/SURVIVE gates own real reattach mechanics) accepts
//      a capped offer and the resume command IS written into the PTY — the old adopt
//      branch relabeled the pane and typed NOTHING.
//   2. The per-pane limit trigger: `mogging notify --event usage-limit` at the pane —
//      the daemon door PROFILES also drives — raises the pane's offer overlay. NOT the
//      `capped` announce: since the lane-identity rebuild an ids-only capped event is a
//      NUDGE that derives the offer from live lane state, and a bare event with no spent
//      lane behind it covers nothing BY DESIGN (that negative is CAPFALSE's whole gate).
//   3. Manual switch (⋯ menu): a "Switch to <profile> (resume session)" entry exists
//      for the running provider's OTHER profile and switches the pane back.
//   4. The interrupt fails CLOSED (F2): with a CONFIRMED-running agent that never
//      dies, the switch ends in the overlay's 'failed' state and types NO launch
//      command — AND it holds while the pane's shell claims otherwise.
//      "Never dies" is a PROCESS fact here, not a declaration. The arm used to shim a
//      detection into a pane whose foreground was a plain shell and call the silence
//      that followed "no verdict will ever come" — a property of the SHIM, never of
//      the world. Phase-launch's re-anchor (agent-proc.ts: a pane is re-listed when
//      `!t.hasPromptMarker || t.foregroundIsShell`) then started asking the process
//      table about exactly those panes, and it answered with a REAL null verdict —
//      correctly: a table that finds only a shell in the pane authorizes typing, the
//      fail-closed law protects RUNNING agents. macOS's zsh reached that first, which
//      is the whole platform skew. So the fixture is now a running agent: node
//      executing a script whose basename IS an adapter bin (the npm-shim shape the
//      detector matches by construction), trapping SIGINT so the double-^C cannot end
//      it, holding the pane's foreground so neither a prompt mark nor the re-anchor
//      has anything to say. On top of that process, step 4 still fires the loudest of
//      the HEURISTIC retirements (a real OSC 133;D prompt mark) straight at the
//      interrupt: a guess may hide the context bar, it may never authorize a keystroke.
// Assertions ride __mogging.ptyWrites (the DEV write spy) + the switch trace —
// phases and command presence only, never buffer content.
//
// TWO MODES by the gate value. `MOGGING_PROFSWITCH=1` (the registered sweep row) is
// HERMETIC: provider gemini via a registry override, no real CLI anywhere.
// `MOGGING_PROFSWITCH=claude` is the manual live variant for a machine with Claude
// Code installed: steps 1-3 run against the REAL CLI — real boot, real process-table
// confirmation, a real double-^C death, and the real ADR-0013 exact-session resume —
// while step 4 (fail-closed) keeps its own never-dies gemini fixture on a second pane,
// because a real agent rightly DIES under the interrupt. That second pane keeps the
// DECLARED fixture (the shim): the hermetic row is the one the sweep certifies F2 on,
// and it is the one that runs a real process.
// `MOGGING_PROFSWITCH=shots` is the SCREENSHOT walkthrough on a machine with TWO
// signed-in claude accounts: real conversation on profile A -> /status shows account
// A's email -> capped offer -> switch -> the SAME conversation resumes under profile B
// -> /status shows account B's email -> AND BACK AGAIN, /status showing A's email with
// B's gone. The return leg is not symmetry for its own sake: profile A carries no
// config-home pointer (it means "the CLI's default home") while B does, and the launch
// line's pointers persist in the pane's shell — so B->A is the direction that can
// report a switch it did not perform. Evidence lands as out/profshot/NN-*.png; the
// JSON verdict carries soft machine assertions beside them. Profile B's config home
// rides MOGGING_PROFSHOT_HOME_B (default ~/.claude-cmain); expected emails may ride
// MOGGING_PROFSHOT_EMAIL_A/_B — set BOTH for the return leg's exact-match assertion,
// which is what proves the CLI actually left account B.
/** POSIX literal quoting for a path typed at a pane's own shell prompt (bash/zsh/sh). */
const shq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

/**
 * A real `node` binary, absolute where PATH knows one.
 *
 * NEVER `process.execPath`: in Electron main that is the Electron binary, whose basename
 * is not an interpreter the detector knows — the fixture below would then run as a process
 * the process table cannot identify as an agent at all, which is the exact failure this
 * arm exists to stop faking. Absolute, so the PANE's login shell (a macOS zsh -l re-runs
 * path_helper over its own PATH) does not have to find it; the bare fallback keeps the arm
 * running on a host whose PATH this process never saw, at the cost of that guarantee.
 */
function resolveNodeBin(): string {
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    // `npm run` puts node_modules/.bin FIRST, and a dependency that ships a `node` entry
    // there is a wrapper SCRIPT: the pane would then run `node <wrapper> <fixture>`, whose
    // script leaf is `node` and matches no adapter at all. Only a real installation counts.
    if (!dir || dir.split(/[\\/]+/).includes('node_modules')) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return name.replace(/\.exe$/, '')
}

export function runProfSwitchSmoke(win: BrowserWindow): void {
  const live = process.env.MOGGING_PROFSWITCH === 'claude'
  const shots = process.env.MOGGING_PROFSWITCH === 'shots'
  /** Step 4's fixture agent, once it has reported its own pid. */
  let fixturePid = 0
  const fixtureAlive = (): boolean => {
    if (fixturePid <= 0) return false
    try {
      process.kill(fixturePid, 0)
      return true
    } catch {
      return false
    }
  }
  /** Reap it on EVERY exit path — the watchdog below included. It survives ^C by design
   *  and the daemon survives THIS app (ADR 0006), so an unkilled one is a live node
   *  process leaking into whatever gate runs next. SIGTERM is untrapped there; on
   *  Windows node's kill terminates outright. */
  const killFixture = (): void => {
    if (fixturePid <= 0) return
    try {
      process.kill(fixturePid)
    } catch {
      /* already gone */
    }
  }
  // Safety net (real CLIs boot slowly). `shots` runs the switch TWICE — two interrupts,
  // two CLI boots, two resumes, three /status reads — so it gets roughly double the
  // live variant's budget rather than the same one.
  setTimeout(() => {
    killFixture()
    app.exit(1)
  }, shots ? 400000 : live ? 220000 : 150000)
  const provider = live ? 'claude' : 'gemini'
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')
  const cli = (args: string[], env: Record<string, string> = {}): Promise<{ code: number }> =>
    new Promise((resolveCli) => {
      execFile(
        process.execPath,
        [cliPath, ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }, timeout: 15000, windowsHide: true },
        (err) => resolveCli({ code: err ? 1 : 0 })
      )
    })
  /** The capped trigger, through the daemon's notify door — out-of-band (the pane is
   *  busy running its agent, so nothing can be typed into it), aimed by --pane with the
   *  endpoint handed over explicitly (outside a pane the CLI has neither in its env). */
  const capNotify = (paneId: number): Promise<{ code: number }> =>
    cli(['notify', '--pane', String(paneId), '--event', 'usage-limit'], {
      MOGGING_DAEMON_ENDPOINT: join(runtimeDir(), 'endpoint.json')
    })

  const runShots = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    let phase = 'boot'
    const shotDir = join(process.cwd(), 'out', 'profshot')
    const shot = async (name: string): Promise<string> => {
      const img = await wc.capturePage()
      const file = join(shotDir, name)
      writeFileSync(file, img.toPNG())
      return file
    }
    try {
      mkdirSync(shotDir, { recursive: true })
      await sleep(1500)
      phase = 'profiles'
      const homeB = process.env.MOGGING_PROFSHOT_HOME_B || join(homedir(), '.claude-cmain')
      const save = (p: unknown): Promise<boolean> =>
        ES<boolean>(`window.bridge.invoke('profiles:save', ${JSON.stringify(p)})`)
      const savedA = await save({ id: 'p-a', name: 'cdev', provider: 'claude', env: {}, order: 0 })
      const savedB = await save({ id: 'p-b', name: 'cmain', provider: 'claude', env: { CLAUDE_CONFIG_DIR: homeB }, order: 1 })
      await ES(`window.__mogging.agents.refreshCommands()`)
      await sleep(500)

      phase = 'launch'
      const anchor = mkdtempSync(join(tmpdir(), 'mogging-shot-'))
      writeFileSync(join(anchor, 'a.txt'), 'x\n')
      await ES(`window.__mogging.workspace.create({ name: 'Shot', cwd: ${JSON.stringify(anchor)} })`)
      await sleep(2500)
      const pane = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100 + 1
      await ES(`window.__mogging.agents.launchIn(${pane}, 'claude', ${JSON.stringify(anchor)}, 'p-a')`)
      // THE LAUNCH COVER, photographed. It is raised at the COMMITMENT — before the pane
      // has printed a prompt and before the `claude --session-id …` line is typed — so it
      // has to be caught early and at a fine grain; by the time the process table confirms
      // the CLI below, the pane may already be the user's again. The picture is the point:
      // a DOM read saying `state: 'launching'` is not evidence that anything was actually
      // obscured.
      let coverSeen = false
      for (let i = 0; i < 60 && !coverSeen; i++) {
        coverSeen = (await ES(`window.__mogging.agents.paneCover(${pane}) === 'launching'`)) as boolean
        if (!coverSeen) await sleep(100)
      }
      // Let the fade finish before photographing it. The cover BLOCKS from the instant it
      // is raised (the input gate rides `show()`, not the transition), but its opacity
      // ramps over --dur-2 — so a shot fired on the first frame shows a nearly transparent
      // card over a still-readable shell banner and libels a cover that is doing its job.
      await sleep(450)
      const s0 = coverSeen ? await shot('00-launch-cover.png') : ''
      let confirmed = false
      for (let i = 0; i < 60 && !confirmed; i++) {
        await sleep(500)
        confirmed = (await ES(`(window.__mogging.agents.session(${pane}) || {}).running === true`)) as boolean
      }
      // ...and it comes DOWN. A cover that goes up and stays up is worse than none, so this
      // waits it out rather than sampling once — bounded well past the ceiling, which
      // guarantees termination even if the CLI never signals.
      let coverLifted = false
      for (let i = 0; i < 250 && !coverLifted; i++) {
        coverLifted = (await ES(`window.__mogging.agents.paneCover(${pane}) === null`)) as boolean
        if (!coverLifted) await sleep(100)
      }
      const s0b = coverLifted ? await shot('00b-cover-lifted.png') : ''
      const bufferText = (): Promise<string> =>
        ES<string>(
          `(() => {
            const p = (window.__mogging.panes || []).find((x) => x.id === ${pane})
            if (!p) return ''
            const b = p.term.buffer.active
            let s = ''
            for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + '\\n' }
            return s
          })()`
        )
      // Claude clears its stdin while initializing — a send that races the splash is
      // eaten whole (observed live: empty input, no message, 60s later). And a FRESH
      // project dir first shows the folder-trust dialog, which also eats typed text —
      // answer its preselected "Yes, I trust this folder" with Enter (each config home
      // stores its own trust, so the resumed pane under home B asks again). Wait for
      // the welcome box / conversation to be PAINTED, then a beat for the input loop.
      const settleClaudeTui = async (): Promise<void> => {
        for (let i = 0; i < 50; i++) {
          const text = await bufferText()
          if (/trust this folder/i.test(text) && /Enter to confirm/i.test(text)) {
            await cli(['send-key', String(pane), 'enter'])
            await sleep(2000)
            continue
          }
          if (/Welcome|shortcuts|esc to interrupt/i.test(text)) break
          await sleep(500)
        }
        await sleep(2000)
      }
      await settleClaudeTui()
      const s1 = await shot('01-profile-a-running.png')

      phase = 'prompt'
      const MARK = 'PROFILE_SWITCH_CONTINUITY_CHECK'
      const countMark = async (): Promise<number> => ((await bufferText()).match(/PROFILE_SWITCH_CONTINUITY_CHECK/g) ?? []).length
      // Text and Enter as SEPARATE writes: claude's paste guard reads text+\r arriving
      // in one write as pasted content and leaves it UNSUBMITTED in the input box
      // (observed live — the prompt sat there for 60s).
      await cli(['send', String(pane), `Reply with exactly this and nothing else: ${MARK}`])
      await sleep(1200)
      await cli(['send-key', String(pane), 'enter'])
      let countA = 0
      for (let i = 0; i < 60 && countA < 2; i++) {
        await sleep(1000)
        countA = await countMark()
      }
      const s2 = await shot('02-reply-on-a.png')

      phase = 'status-a'
      await cli(['send', String(pane), '/status'])
      await sleep(1200)
      await cli(['send-key', String(pane), 'enter'])
      await sleep(4000)
      const s3 = await shot('03-status-a.png')
      const emailsA = [...new Set(((await bufferText()).match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []))]
      await cli(['send-key', String(pane), 'escape'])
      await sleep(800)

      phase = 'switch'
      const capSent = (await capNotify(pane)).code === 0
      let offered = false
      for (let i = 0; i < 20 && !offered; i++) {
        await sleep(300)
        offered = ((await ES(`window.__mogging.agents.offer(${pane})`)) as { state?: string } | null)?.state === 'offered'
      }
      const s4 = await shot('04-capped-offer-overlay.png')
      await ES(`(() => { const b = [...document.querySelectorAll('.pane-offer .btn')].find((x) => (x.textContent || '').includes('Continue on')); if (b) b.click(); return 1 })()`)
      // The blur must COVER the machinery (interrupt, shell, typed resume, CLI boot):
      // capture mid-switch — the switching card, never a shell prompt.
      await sleep(4000)
      const s4b = await shot('04b-switching-covers-boot.png')
      let switched = false
      const holdSamples: unknown[] = []
      for (let i = 0; i < 90 && !switched; i++) {
        await sleep(1000)
        if (holdSamples.length < 25) holdSamples.push(await ES(`window.__mogging.agents.readiness(${pane})`))
        switched = (await ES(
          `(() => window.__mogging.agents.offer(${pane}) === null && window.__mogging.agents.lastLaunch(${pane}).profileId === 'p-b')()`
        )) as boolean
      }
      phase = 'resume'
      let resumedRunning = false
      for (let i = 0; i < 60 && !resumedRunning; i++) {
        await sleep(500)
        resumedRunning = (await ES(`(window.__mogging.agents.session(${pane}) || {}).running === true`)) as boolean
      }
      await settleClaudeTui() // home B's own trust dialog, then the resumed history paints
      await sleep(2000)
      const countB = await countMark()
      // The continuation prompt auto-submits behind the blur (limit-triggered switch):
      // the resumed agent must have been TOLD to keep working, without anyone typing.
      let continuationOk = false
      for (let i = 0; i < 30 && !continuationOk; i++) {
        continuationOk = (await bufferText()).includes('Continue exactly where you left off')
        if (!continuationOk) await sleep(500)
      }
      // Diagnosis line for a continuation miss: was it SKIPPED (no 'continued' phase —
      // readiness never observed) or typed-and-eaten (phase present, text absent)?
      const contDiag = continuationOk
        ? null
        : {
            trace: (await ES(`window.__mogging.agents.switchTrace(${pane})`)) as { phase: string }[],
            tail: (await bufferText()).trim().split('\n').slice(-14).join('\n'),
            holdSamples
          }
      const s5 = await shot('05-resumed-history-on-b.png')
      // Let the continuation's (trivial) turn finish before /status — two consecutive
      // quiet reads, so the status panel is not asked for mid-stream.
      let quiet = 0
      for (let i = 0; i < 40 && quiet < 2; i++) {
        await sleep(1000)
        quiet = /esc to interrupt/i.test((await bufferText()).split('\n').slice(-14).join('\n')) ? 0 : quiet + 1
      }

      phase = 'status-b'
      await cli(['send', String(pane), '/status'])
      await sleep(1200)
      await cli(['send-key', String(pane), 'enter'])
      await sleep(4000)
      const s6 = await shot('06-status-b.png')
      const emailsB = [...new Set(((await bufferText()).match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []))]

      // ── THE RETURN LEG (the 2026-08-04 regression) ───────────────────────────────
      // Everything above is A->B, and A->B always worked: profile B NAMES a config-home
      // pointer, so the launch line sets one. The break was coming BACK. Profile A
      // carries no pointer of its own (it means "the CLI's default home"), and the
      // launch line's pointers PERSIST in the pane's shell — so the return switch used
      // to emit nothing at all, relaunch on B's home, and leave /status reporting B
      // while the app reported A. One direction of a two-direction feature was never
      // photographed, which is exactly how it shipped. Same flow, opposite direction.
      phase = 'switch-back'
      await cli(['send-key', String(pane), 'escape'])
      await sleep(800)
      const capSentBack = (await capNotify(pane)).code === 0
      let offeredBack = false
      for (let i = 0; i < 20 && !offeredBack; i++) {
        await sleep(300)
        offeredBack = ((await ES(`window.__mogging.agents.offer(${pane})`)) as { state?: string } | null)?.state === 'offered'
      }
      await ES(`(() => { const b = [...document.querySelectorAll('.pane-offer .btn')].find((x) => (x.textContent || '').includes('Continue on')); if (b) b.click(); return 1 })()`)
      let switchedBack = false
      for (let i = 0; i < 90 && !switchedBack; i++) {
        await sleep(1000)
        switchedBack = (await ES(
          `(() => window.__mogging.agents.offer(${pane}) === null && window.__mogging.agents.lastLaunch(${pane}).profileId === 'p-a')()`
        )) as boolean
      }
      let resumedBackRunning = false
      for (let i = 0; i < 60 && !resumedBackRunning; i++) {
        await sleep(500)
        resumedBackRunning = (await ES(`(window.__mogging.agents.session(${pane}) || {}).running === true`)) as boolean
      }
      await settleClaudeTui()
      let quietBack = 0
      for (let i = 0; i < 40 && quietBack < 2; i++) {
        await sleep(1000)
        quietBack = /esc to interrupt/i.test((await bufferText()).split('\n').slice(-14).join('\n')) ? 0 : quietBack + 1
      }

      phase = 'status-a-again'
      await cli(['send', String(pane), '/status'])
      await sleep(1200)
      await cli(['send-key', String(pane), 'enter'])
      await sleep(4000)
      const s7 = await shot('07-status-back-on-a.png')
      // claude paints /status in the ALT screen, so this reads the panel now on screen —
      // not scrollback. The earlier readings cannot leak into it.
      const emailsA2 = [...new Set(((await bufferText()).match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []))]

      // The switch's wall-clock, offer-accept to overlay-clear — the speed the
      // trust/grants carry exists to buy (pre-carry baseline: ~15-17s).
      const fullTrace = (await ES(`window.__mogging.agents.switchTrace(${pane})`)) as { phase: string; at: number }[]
      const tStart = fullTrace.find((t) => t.phase === 'interrupt-start')?.at
      const tDone = fullTrace.find((t) => t.phase === 'done')?.at
      const switchMs = tStart !== undefined && tDone !== undefined ? Math.round(tDone - tStart) : null

      // Main's build wall-ms for the switch's relaunch — the pipeline-optimization
      // gates' before/after number beside switchMs.
      const buildMs = (await ES(`window.__mogging.agents.lastBuildMs()`)) as number | null

      const expectedA = process.env.MOGGING_PROFSHOT_EMAIL_A
      const expectedB = process.env.MOGGING_PROFSHOT_EMAIL_B
      const statusAOk = expectedA ? emailsA.includes(expectedA) : emailsA.length > 0
      const statusBOk = expectedB ? emailsB.includes(expectedB) : emailsB.length > 0
      // The return leg's assertion is the NEGATIVE one: B's email must be GONE. "A's
      // email is present" is far weaker — the bug's whole signature is that the switch
      // reports profile A while the CLI still answers as B, so only B's absence
      // distinguishes a real switch from a reported one.
      const backOnAOk = expectedA ? emailsA2.includes(expectedA) : emailsA2.length > 0
      const leftBOk = expectedB ? !emailsA2.includes(expectedB) : emailsA2.join() !== emailsB.join()
      const historyOk = countB >= 2 // the resumed pane still shows the exchange
      const trace = (await ES(`window.__mogging.agents.switchTrace(${pane})`)) as { phase: string }[]
      const phases = trace.map((t) => t.phase)
      const orderOk = phases.indexOf('agent-gone') > phases.indexOf('interrupt-start') && phases.indexOf('typed') > phases.indexOf('agent-gone')

      const pass = savedA && savedB && confirmed && countA >= 2 && capSent && offered && switched &&
        resumedRunning && historyOk && continuationOk && orderOk && statusAOk && statusBOk &&
        capSentBack && offeredBack && switchedBack && resumedBackRunning && backOnAOk && leftBOk &&
        coverSeen && coverLifted
      result = {
        pass, mode: 'claude-shots', savedA, savedB, confirmed, coverSeen, coverLifted, countA, countB, capSent, offered,
        switched, resumedRunning, historyOk, continuationOk, contDiag, orderOk, phases, switchMs, buildMs,
        statusAOk, statusBOk, emailsA, emailsB,
        capSentBack, offeredBack, switchedBack, resumedBackRunning, backOnAOk, leftBOk, emailsA2,
        screenshots: [s0, s0b, s1, s2, s3, s4, s4b, s5, s6, s7].filter(Boolean)
      }
    } catch (e) {
      result = { pass: false, phase, error: String(e) }
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'profswitch-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  // The fixture CLI must read as INSTALLED: the palette's switch commands (and the
  // launch entries) exist only for installed providers — published through the same
  // push a real install uses (the plainmenu/AGENTREGISTRY recipe). The live variant
  // needs no override: claude genuinely is installed there.
  const publishInstalled = async (): Promise<void> => {
    setAgentDetectOverrideForSmoke([
      { id: 'gemini', name: 'Gemini', installed: true, installHint: 'npm install -g @google/gemini-cli' } as AgentInfo
    ])
    const state: AgentInstallState = {
      agentId: 'gemini',
      phase: 'succeeded',
      tail: '',
      exitCode: 0,
      startedAt: Date.now() - 10,
      endedAt: Date.now()
    }
    wc.send(AgentChannels.installChanged, state)
    await sleep(700)
  }

  const run = async (): Promise<void> => {
    let result: Record<string, unknown> = { pass: false }
    try {
      await sleep(1500)
      // The DEV write spy records only once PLANTED — before the first launch, so the
      // baseline counts include it.
      await ES(`(window.__mogging.ptyWrites = [], 1)`)
      if (!live) await publishInstalled()
      // ── Fixture: two profiles (same shape as MOGGING_PROFILES). Live mode: profile A
      // is the machine's REAL default home (the login you already have); profile B's
      // pointer home is derived main-side, exactly like the Settings form's save. ──
      const save = (p: unknown): Promise<boolean> =>
        ES<boolean>(`window.bridge.invoke('profiles:save', ${JSON.stringify(p)})`)
      const savedA = live
        ? await save({ id: 'p-a', name: 'Work', provider, env: {}, order: 0 })
        : await save({ id: 'p-a', name: 'Work', provider, env: { FAKE_MARK: 'A_MARK' }, order: 0 })
      const savedB = live
        ? await save({ id: 'p-b', name: 'Personal', provider, order: 1 })
        : await save({ id: 'p-b', name: 'Personal', provider, env: { FAKE_MARK: 'B_MARK' }, order: 1 })
      // A raw bridge save (unlike the Settings form) fires no renderer profiles-changed
      // announce — republish the palette commands the way a real profile edit would.
      await ES(`window.__mogging.agents.refreshCommands()`)
      await sleep(500)

      const anchor = mkdtempSync(join(tmpdir(), 'mogging-psw-'))
      writeFileSync(join(anchor, 'a.txt'), 'x\n')
      await ES(`window.__mogging.workspace.create({ name: 'PS', cwd: ${JSON.stringify(anchor)} })`)
      await sleep(2500)
      const pane = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100 + 1
      await ES(`window.__mogging.agents.launchIn(${pane}, ${JSON.stringify(provider)}, ${JSON.stringify(anchor)})`)
      await sleep(2500)
      // Live mode: wait for the process table to CONFIRM the real CLI before capping it —
      // the capped scenario is an agent that has been running for a while, and the
      // interrupt's full-strength claim (verdict, not the unconfirmed fallback) needs a
      // confirmed process to kill.
      let confirmed = !live
      for (let i = 0; live && i < 40 && !confirmed; i++) {
        await sleep(500)
        confirmed = (await ES(`(window.__mogging.agents.session(${pane}) || {}).running === true`)) as boolean
      }

      const writesFor = (): Promise<number> =>
        ES<number>(`(window.__mogging.ptyWrites || []).filter((w) => w.id === ${pane} && String(w.data).includes(${JSON.stringify(provider)})).length`)
      const offerState = (): Promise<{ state: string; nextName: string } | null> =>
        ES(`window.__mogging.agents.offer(${pane})`)

      // ── 1+2. Reattach mark + capped claim -> offer -> accept -> REALLY typed ──
      // Cap the lane the pane ACTUALLY launched under — on a real machine, login
      // discovery may have minted a `login-claude` row at order 0 before the fixture
      // saves, making IT the default the launch resolved (that is correct product
      // behavior: the signed-in account is the default until the user reorders).
      const initialProfile = (await ES(`window.__mogging.agents.lastLaunch(${pane}).profileId`)) as string
      await ES(`window.__mogging.agents.markReattached(${pane})`)
      const capSent = (await capNotify(pane)).code === 0
      let offered = false
      // 40x300ms, not 20: the out-of-band trigger pays a CLI boot + daemon round trip
      // that the old in-renderer announce never did, and a cold Windows runner spends
      // seconds of it in node.exe startup alone (observed: the offer rose AFTER a 6s
      // poll and the rest of the flow then passed against it).
      for (let i = 0; i < 40 && !offered; i++) {
        await sleep(300)
        offered = (await offerState())?.state === 'offered'
      }
      const launchesBefore = await writesFor()
      await ES(`(() => { const b = [...document.querySelectorAll('.pane-offer .btn')].find((x) => (x.textContent || '').includes('Continue on')); if (b) b.click(); return 1 })()`)
      let switched = false
      let switchedTo = ''
      for (let i = 0; i < 60 && !switched; i++) {
        await sleep(500)
        const state = (await ES(
          `(() => ({ offer: window.__mogging.agents.offer(${pane}), profileId: window.__mogging.agents.lastLaunch(${pane}).profileId }))()`
        )) as { offer: unknown; profileId?: string }
        switched = state.offer === null && !!state.profileId && state.profileId !== initialProfile
        if (switched) switchedTo = state.profileId!
      }
      // F1's exact claim: the relaunch was WRITTEN into the pane (adopt branch bypassed).
      const typedOk = (await writesFor()) > launchesBefore
      const trace1 = (await ES(`window.__mogging.agents.switchTrace(${pane})`)) as { phase: string }[]
      const p1 = trace1.map((t) => t.phase)
      const orderOk =
        p1.indexOf('agent-gone') > p1.indexOf('interrupt-start') && p1.indexOf('typed') > p1.indexOf('agent-gone')

      // ── 3. Manual switch from the pane ⋯ menu, to the OTHER fixture profile ──
      // One synchronous pass per attempt (the plainmenu recipe): open, read, click
      // the entry (which closes the menu) — polled, because the agents feature
      // repopulates commands and rewrites the session asynchronously.
      const manualTarget = switchedTo === 'p-b' ? { name: 'Work', id: 'p-a' } : { name: 'Personal', id: 'p-b' }
      let menuEntryOk = false
      for (let i = 0; i < 40 && !menuEntryOk; i++) {
        menuEntryOk = (await ES(
          `(() => {
            const button = document.querySelector('.layout-slot[data-pane-id="${pane}"] [aria-label="Pane menu"]')
            if (!(button instanceof HTMLButtonElement)) return false
            button.click()
            const menu = document.getElementById('pane-menu-${pane}')
            const items = menu ? [...menu.querySelectorAll('.menu-item')] : []
            const hit = items.find((el) => (el.textContent || '').includes('Switch to ${manualTarget.name}'))
            if (hit) { hit.click(); return true }
            button.click() // close again — a stale open menu would pin the next read
            return false
          })()`
        )) as boolean
        if (!menuEntryOk) await sleep(250)
      }
      // Diagnosis line for a missing entry: what the menu actually held, whether the
      // pane still had a session, and which switch commands were registered at all.
      const menuDiag = menuEntryOk
        ? null
        : await ES(
            `(() => {
              const button = document.querySelector('.layout-slot[data-pane-id="${pane}"] [aria-label="Pane menu"]')
              if (button instanceof HTMLButtonElement) button.click()
              const menu = document.getElementById('pane-menu-${pane}')
              const items = menu ? [...menu.querySelectorAll('.menu-item')].map((el) => (el.textContent || '').trim()) : []
              if (button instanceof HTMLButtonElement) button.click()
              return {
                items,
                session: window.__mogging.agents.session(${pane}),
                switchCmds: window.__mogging.agents.commandsFor('Switch profile')
              }
            })()`
          )
      // Same completion condition as the first switch: the overlay CLEARING is the
      // flow's end (the blur now holds through the relaunch's boot), and the pane
      // leaves its in-flight guard only then — capping again before that is refused.
      let manualOk = false
      for (let i = 0; i < 60 && !manualOk; i++) {
        await sleep(500)
        manualOk = (await ES(
          `(() => window.__mogging.agents.offer(${pane}) === null && window.__mogging.agents.lastLaunch(${pane}).profileId === ${JSON.stringify(manualTarget.id)})()`
        )) as boolean
      }
      await sleep(1000) // the in-flight guard releases just after the overlay clears

      // ── 4. F2 fails CLOSED: a confirmed-running agent that never dies ────────
      // A gemini agent RUNS in the pane and cannot be interrupted to death, so no
      // process verdict will ever arrive and the switch must give up and type NOTHING.
      // Always gemini: a real agent rightly dies under the interrupt, so the live
      // variant stages this on a SECOND pane with its own gemini profile pair.
      let pane2 = pane
      if (live) {
        await save({ id: 'g-a', name: 'GemA', provider: 'gemini', env: { FAKE_MARK: 'GA' }, order: 0 })
        await save({ id: 'g-b', name: 'GemB', provider: 'gemini', env: { FAKE_MARK: 'GB' }, order: 1 })
        await ES(`window.__mogging.agents.refreshCommands()`)
        await ES(`window.__mogging.workspace.create({ name: 'PS2', cwd: ${JSON.stringify(anchor)} })`)
        await sleep(2500)
        pane2 = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100 + 1
        await ES(`window.__mogging.agents.launchIn(${pane2}, 'gemini', ${JSON.stringify(anchor)})`)
        await sleep(2500)
      }
      const offerState2 = (): Promise<{ state: string } | null> => ES(`window.__mogging.agents.offer(${pane2})`)
      const writesFor2 = (): Promise<number> =>
        ES<number>(`(window.__mogging.ptyWrites || []).filter((w) => w.id === ${pane2} && String(w.data).includes('gemini')).length`)
      // THE FIXTURE AGENT. Hermetic: a real process, started in the pane itself.
      //   · `node <file named gemini>` — the BASENAME is the entire match. agent-proc.ts
      //     identifies an npm-installed CLI by reading an INTERPRETER's script path and
      //     asking whether its leaf is an adapter bin, which is why this cannot be
      //     `node -e '…'` (an inline program has no script path, so nothing would ever
      //     read it as gemini) and why the file carries no extension the leaf test would
      //     have to strip twice.
      //   · SIGINT trapped: the interrupt's four double-^C rounds all land, and none of
      //     them ends it — so the process table has nothing to report but "still there",
      //     which is what makes "no verdict will ever come" true BY CONSTRUCTION rather
      //     than by silencing the one thing that is allowed to answer.
      //   · it holds the pane's FOREGROUND, so the shell emits no prompt mark (nothing
      //     retires the session for free) and `foregroundIsShell` stays false (the
      //     re-anchor that broke the declared fixture never fires).
      // The live variant keeps its DECLARED fixture on its own second pane.
      let fixtureStarted = live
      if (live) {
        await ES(`window.__mogging.agents.detected({ id: ${pane2}, agentId: 'gemini', cwd: ${JSON.stringify(anchor)}, sinceMs: Date.now() })`)
      } else {
        const fixtureDir = mkdtempSync(join(tmpdir(), 'mogging-psfix-'))
        const fixtureFile = join(fixtureDir, 'gemini')
        const fixturePidFile = join(fixtureDir, 'pid')
        writeFileSync(
          fixtureFile,
          [
            "// PROFSWITCH step 4's agent: a real process for the process table to find.",
            "process.on('SIGINT', () => {}) // the double-^C lands and changes nothing",
            `require('fs').writeFileSync(${JSON.stringify(fixturePidFile)}, String(process.pid))`,
            'setInterval(() => {}, 1000)',
            ''
          ].join('\n')
        )
        const nodeBin = resolveNodeBin()
        // Typed through the RAW bridge on purpose: terminalClient.write and
        // agentsClient.launchInto are the DEV write spy's two mouths, and this line
        // carries the word `gemini` inside the fixture's path. The spy must see exactly
        // what the SWITCH types and nothing the harness types.
        // node is INVOKED, never a `gemini`/`gemini.cmd` shim found on a doctored PATH: on
        // Windows that shim is a BATCH file, and a ^C inside a batch raises cmd's own
        // "Terminate batch job (Y/N)?" — which this very interrupt answers `Y` (its trap
        // window is open). The fixture would then lose the foreground to a shell prompt
        // mid-arm, in the one arm whose whole premise is that it never does.
        const startFixture =
          process.platform === 'win32'
            ? `"${nodeBin}" "${fixtureFile}"` // cmd.exe, the pane shell COMSPEC names
            : `${shq(nodeBin)} ${shq(fixtureFile)}` // bash (linux) / zsh (macos)
        await ES(
          `window.bridge.send('terminal:write', { id: ${pane2}, data: ${JSON.stringify(startFixture + '\r')} })`
        )
        // Its OWN word that it is up, before detection is asked about it: a fixture that
        // never started must not read as one the detector missed — and the pid is what
        // teardown kills (it ignores ^C by design, and the daemon outlives this app).
        for (let i = 0; i < 24 && !fixturePid; i++) {
          await sleep(500)
          try {
            fixturePid = Number(readFileSync(fixturePidFile, 'utf8').trim()) || 0
          } catch {
            /* not up yet */
          }
        }
        fixtureStarted = fixturePid > 0
      }
      // The arm's whole claim is "a CONFIRMED agent that never dies fails the interrupt
      // CLOSED" — so the confirmation must exist before the trigger fires, and hermetically
      // it is now the PROCESS TABLE's own: nothing declares this session, the detector
      // finds it (submitted line -> probe -> listing, plus the shared-snapshot gap). Racing
      // it hands the interrupt an UNCONFIRMED session, whose rules let it give up after two
      // rounds, and the OSC guess below then legitimately reads as agent-gone.
      let confirmed2 = false
      for (let i = 0; i < 40 && !confirmed2; i++) {
        await sleep(500)
        confirmed2 = (await ES(`(window.__mogging.agents.session(${pane2}) || {}).running === true`)) as boolean
      }
      const sessionWrittenAt = Date.now()
      const capSent2 = (await capNotify(pane2)).code === 0
      let offered2 = false
      for (let i = 0; i < 20 && !offered2; i++) {
        await sleep(300)
        offered2 = (await offerState2())?.state === 'offered'
      }
      const launchesBefore2 = await writesFor2()
      await ES(`(() => { const b = [...document.querySelectorAll('.pane-offer .btn')].find((x) => (x.textContent || '').includes('Continue on')); if (b) b.click(); return 1 })()`)
      // THE GUESSES, fired AT the interrupt — what made this gate flaky instead of
      // deterministic. A living process settles the process table's answer; it settles
      // nothing about the OTHER ways a pane's agent session is retired, and each of those
      // used to reach the interrupt as "the agent is gone" while the CLI ran on. The
      // loudest is the shell's own OSC 133;D — a real mark that any zsh/bash
      // with third-party shell integration emits at every prompt (ours is 633, which is
      // why Windows and Linux sweeps never saw it), fired here through the pane's xterm
      // exactly as blocks-smoke does, so no shell emitter is needed. It is armed by a
      // 133;C and only bites once terminal-pane's 1500ms post-session grace has expired
      // — which is the load dependence: unloaded, the offer polls once and the ^C lands
      // inside the grace; loaded, the poll takes seconds and the guess is live by the
      // time the interrupt starts. A fixture that leaves that to luck is not a fixture.
      let guessFired = false
      for (let i = 0; i < 80 && !guessFired; i++) {
        const started = (await ES(
          `(window.__mogging.agents.switchTrace(${pane2}) || []).some((t) => t.phase === 'interrupt-start')`
        )) as boolean
        if (started && Date.now() - sessionWrittenAt > 1600) {
          guessFired = (await ES(
            `(() => {
              const p = (window.__mogging.panes || []).find((x) => x.id === ${pane2})
              if (!p || !p.term) return false
              const E = String.fromCharCode(27), B = String.fromCharCode(7)
              p.term.write(E + ']133;C' + B)   // a command started (arms the exit guess)
              p.term.write(E + ']133;D;0' + B) // ...and the shell is back at its prompt
              return true
            })()`
          )) as boolean
        }
        if (!guessFired) await sleep(200)
      }
      let failedOk = false
      for (let i = 0; i < 60 && !failedOk; i++) {
        await sleep(500)
        failedOk = (await offerState2())?.state === 'failed'
      }
      const nothingTypedOk = (await writesFor2()) === launchesBefore2
      // Diagnosis line for a fail-closed miss: where the offer actually ended up, what the
      // switch trace recorded (a stuck 'switching' = a throw mid-flow; a trace with 'typed'
      // = the interrupt wrongly reported gone) — and, first of all, whether the FIXTURE was
      // still alive, because a dead one turns every reading below into a different question.
      const failDiag = failedOk
        ? null
        : {
            offerFinal: await offerState2(),
            trace2: (await ES(`window.__mogging.agents.switchTrace(${pane2})`)) as { phase: string }[],
            session2: await ES(`window.__mogging.agents.session(${pane2})`),
            fixturePid,
            fixtureAlive: fixtureAlive()
          }

      const pass =
        savedA && savedB && confirmed && capSent && offered && switched && typedOk && orderOk &&
        menuEntryOk && manualOk && fixtureStarted && confirmed2 && capSent2 && offered2 &&
        guessFired && failedOk && nothingTypedOk
      result = {
        pass, mode: live ? 'claude-live' : 'gemini-hermetic', savedA, savedB, confirmed,
        initialProfile, switchedTo, capSent, offered, switched, typedOk, orderOk, phases1: p1,
        menuEntryOk, menuDiag, manualOk, fixtureStarted, fixturePid, confirmed2, capSent2,
        offered2, guessFired, failedOk, failDiag, nothingTypedOk
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    killFixture() // a throw mid-arm cleans up exactly like a pass does
    try {
      writeFileSync(join(process.cwd(), 'out', 'profswitch-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    app.exit(result.pass ? 0 : 1)
  }

  const entry = shots ? runShots : run
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(entry, 2500))
  else setTimeout(entry, 2500)
}
