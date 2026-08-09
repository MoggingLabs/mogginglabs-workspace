import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAgentDetectOverrideForSmoke } from '../agents'
import { AgentChannels, type AgentInfo, type AgentInstallState } from '@contracts'

// Env-gated pane profile-SWITCH smoke (MOGGING_PROFSWITCH) — the audit F1/F2 gate:
//   1. REATTACHED pane failover really types (F1): a pane wearing the daemon-reattach
//      mark (dev shim — the RELOAD/SURVIVE gates own real reattach mechanics) accepts
//      a capped offer and the resume command IS written into the PTY — the old adopt
//      branch relabeled the pane and typed NOTHING.
//   2. The usage-engine trigger (F4): `capped({provider, profile})` at the port the
//      real alert path announces on is CLAIMED and raises the pane's offer overlay.
//   3. Manual switch (⋯ menu): a "Switch to <profile> (resume session)" entry exists
//      for the running provider's OTHER profile and switches the pane back.
//   4. The interrupt fails CLOSED (F2): with a CONFIRMED-running agent that never
//      dies (detection shim; no process verdict will ever come), the switch ends in
//      the overlay's 'failed' state and types NO launch command — AND it holds while
//      the pane's shell claims otherwise. The shim only ever silenced the process
//      table, so "no verdict will ever come" left the heuristics that ALSO retire a
//      pane's agent session free to answer in its place; step 4 now fires the loudest
//      of them (a real OSC 133;D prompt mark) straight at the interrupt instead of
//      hoping the run is fast enough that it never lands.
// Assertions ride __mogging.ptyWrites (the DEV write spy) + the switch trace —
// phases and command presence only, never buffer content.
//
// TWO MODES by the gate value. `MOGGING_PROFSWITCH=1` (the registered sweep row) is
// HERMETIC: provider gemini via a registry override, no real CLI anywhere.
// `MOGGING_PROFSWITCH=claude` is the manual live variant for a machine with Claude
// Code installed: steps 1-3 run against the REAL CLI — real boot, real process-table
// confirmation, a real double-^C death, and the real ADR-0013 exact-session resume —
// while step 4 (fail-closed) keeps a hermetic never-dies gemini fixture on a second
// pane, because a real agent rightly DIES under the interrupt.
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
export function runProfSwitchSmoke(win: BrowserWindow): void {
  const live = process.env.MOGGING_PROFSWITCH === 'claude'
  const shots = process.env.MOGGING_PROFSWITCH === 'shots'
  // Safety net (real CLIs boot slowly). `shots` runs the switch TWICE — two interrupts,
  // two CLI boots, two resumes, three /status reads — so it gets roughly double the
  // live variant's budget rather than the same one.
  setTimeout(() => app.exit(1), shots ? 400000 : live ? 220000 : 150000)
  const provider = live ? 'claude' : 'gemini'
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cliPath = join(app.getAppPath(), 'bin', 'mogging.mjs')
  const cli = (args: string[]): Promise<{ code: number }> =>
    new Promise((resolveCli) => {
      execFile(
        process.execPath,
        [cliPath, ...args],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000, windowsHide: true },
        (err) => resolveCli({ code: err ? 1 : 0 })
      )
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
      const claimed = (await ES(`window.__mogging.agents.capped({ providerId: 'claude', profileId: 'p-a' })`)) as boolean
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
      const claimedBack = (await ES(`window.__mogging.agents.capped({ providerId: 'claude', profileId: 'p-b' })`)) as boolean
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

      const pass = savedA && savedB && confirmed && countA >= 2 && claimed && offered && switched &&
        resumedRunning && historyOk && continuationOk && orderOk && statusAOk && statusBOk &&
        claimedBack && offeredBack && switchedBack && resumedBackRunning && backOnAOk && leftBOk &&
        coverSeen && coverLifted
      result = {
        pass, mode: 'claude-shots', savedA, savedB, confirmed, coverSeen, coverLifted, countA, countB, claimed, offered,
        switched, resumedRunning, historyOk, continuationOk, contDiag, orderOk, phases, switchMs, buildMs,
        statusAOk, statusBOk, emailsA, emailsB,
        claimedBack, offeredBack, switchedBack, resumedBackRunning, backOnAOk, leftBOk, emailsA2,
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
      const claimed = (await ES(
        `window.__mogging.agents.capped({ providerId: ${JSON.stringify(provider)}, profileId: ${JSON.stringify(initialProfile)} })`
      )) as boolean
      let offered = false
      for (let i = 0; i < 20 && !offered; i++) {
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
      // The detection shim marks the session running:true; no process verdict will
      // ever arrive for it, so the interrupt must give up and type NOTHING. Always a
      // HERMETIC gemini fixture: a real agent rightly dies under the interrupt, so the
      // live variant stages this on a SECOND pane with its own gemini profile pair.
      let pane2 = pane
      let failProfile = 'p-a'
      if (live) {
        await save({ id: 'g-a', name: 'GemA', provider: 'gemini', env: { FAKE_MARK: 'GA' }, order: 0 })
        await save({ id: 'g-b', name: 'GemB', provider: 'gemini', env: { FAKE_MARK: 'GB' }, order: 1 })
        await ES(`window.__mogging.agents.refreshCommands()`)
        await ES(`window.__mogging.workspace.create({ name: 'PS2', cwd: ${JSON.stringify(anchor)} })`)
        await sleep(2500)
        pane2 = ((await ES('window.__mogging.workspace.active()')) as { ordinal: number }).ordinal * 100 + 1
        await ES(`window.__mogging.agents.launchIn(${pane2}, 'gemini', ${JSON.stringify(anchor)})`)
        await sleep(2500)
        failProfile = 'g-a'
      }
      const offerState2 = (): Promise<{ state: string } | null> => ES(`window.__mogging.agents.offer(${pane2})`)
      const writesFor2 = (): Promise<number> =>
        ES<number>(`(window.__mogging.ptyWrites || []).filter((w) => w.id === ${pane2} && String(w.data).includes('gemini')).length`)
      await ES(`window.__mogging.agents.detected({ id: ${pane2}, agentId: 'gemini', cwd: ${JSON.stringify(anchor)}, sinceMs: Date.now() })`)
      const sessionWrittenAt = Date.now()
      const claimed2 = (await ES(`window.__mogging.agents.capped({ providerId: 'gemini', profileId: ${JSON.stringify(failProfile)} })`)) as boolean
      let offered2 = false
      for (let i = 0; i < 20 && !offered2; i++) {
        await sleep(300)
        offered2 = (await offerState2())?.state === 'offered'
      }
      const launchesBefore2 = await writesFor2()
      await ES(`(() => { const b = [...document.querySelectorAll('.pane-offer .btn')].find((x) => (x.textContent || '').includes('Continue on')); if (b) b.click(); return 1 })()`)
      // THE GUESSES, fired AT the interrupt — what made this gate flaky instead of
      // deterministic. "No process verdict will ever come" was only ever true of the
      // process table; the pane's agent session can ALSO be retired by heuristics the
      // shim above does not control, and each of those used to read as "the agent is
      // gone". The loudest is the shell's own OSC 133;D — a real mark that any zsh/bash
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
      // Diagnosis line for a fail-closed miss: where the offer actually ended up and
      // what the switch trace recorded (a stuck 'switching' = a throw mid-flow; a
      // trace with 'typed' = the interrupt wrongly reported gone).
      const failDiag = failedOk
        ? null
        : {
            offerFinal: await offerState2(),
            trace2: (await ES(`window.__mogging.agents.switchTrace(${pane2})`)) as { phase: string }[],
            session2: await ES(`window.__mogging.agents.session(${pane2})`)
          }

      const pass =
        savedA && savedB && confirmed && claimed && offered && switched && typedOk && orderOk &&
        menuEntryOk && manualOk && claimed2 && offered2 && guessFired && failedOk && nothingTypedOk
      result = {
        pass, mode: live ? 'claude-live' : 'gemini-hermetic', savedA, savedB, confirmed,
        initialProfile, switchedTo, claimed, offered, switched, typedOk, orderOk, phases1: p1,
        menuEntryOk, menuDiag, manualOk, claimed2, offered2, guessFired, failedOk, failDiag, nothingTypedOk
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
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
